#!/usr/bin/env bash
#
# find-duplicates.sh — search a repo for issues that may already cover what you are about to file.
#
# ADVISORY ONLY. It always exits 0. It ranks text; it does not understand the problem. Read the
# candidates before deciding, and never let it stand in for that reading.
#
# Invoke via `bash`, not `./` — git does not record the executable bit on Windows checkouts
# (core.filemode=false), so `./find-duplicates.sh` fails with "Permission denied" elsewhere.
#
#   bash find-duplicates.sh "Checkout returns 500 when the coupon code is blank"
#   bash find-duplicates.sh "Per-region shipping rates" shipping rate region
#   bash find-duplicates.sh --repo owner/name "Some title"
#   bash find-duplicates.sh --broad 25 "Some title"     # loosen the breadth filter
#   bash find-duplicates.sh --tsv "Some title"          # machine-readable
#
# TERMS. With none given it derives them from the title, preferring identifiers —
# Module.function/3, snake_case, CamelCase, ALLCAPS, `backticked`. Identifiers survive rephrasing;
# English descriptions of one defect often share no words at all. It falls back to content words
# only when the title carries no identifier, which is common for feature titles.
#
# BREADTH FILTER. A term matching more than --broad issues (default 15) is not distinctive, so its
# results are discarded and the term is reported as too broad. This is what stops a word like
# "admin" or "user" burying the real candidates.
#
# RANKING. Candidates are ordered by what needs your attention — adjudicated decisions first —
# then by how many of the searches independently found them. Two searches agreeing is a much
# stronger signal than one broad search hitting.
#
# FAILED SEARCHES are reported, never swallowed. A query that errored and a query that genuinely
# found nothing both produce no rows, so the difference is tracked explicitly and printed. Treat
# any run marked INCOMPLETE as "unknown", never as "nothing found" — a duplicate the search never
# reached is still a duplicate.
#
# Requires: gh (authenticated), jq. Reference: references/duplicate-check.md

set -euo pipefail

REPO=""
TSV=false
TITLE=""
TERMS=()
MAX_TERMS=4
MAX_TERM_HITS=15
MAX_ROWS=15

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)    REPO="${2:?--repo needs owner/name}"; shift 2 ;;
    --broad)   MAX_TERM_HITS="${2:?--broad needs a number}"; shift 2 ;;
    --tsv)     TSV=true; shift ;;
    -h|--help) awk 'NR>2 && /^#/ {sub(/^# ?/,""); print; next} NR>2 {exit}' "$0"; exit 0 ;;
    -*)        echo "unknown option: $1" >&2; exit 2 ;;
    *)         if [[ -z "$TITLE" ]]; then TITLE="$1"; else TERMS+=("$1"); fi; shift ;;
  esac
done

[[ -n "$TITLE" ]] || { echo "usage: bash find-duplicates.sh \"<title>\" [term...]" >&2; exit 2; }

command -v gh >/dev/null       || { echo "gh is not installed"     >&2; exit 1; }
command -v jq >/dev/null       || { echo "jq is not installed"     >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated" >&2; exit 1; }

[[ -n "$REPO" ]] || REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# ---------------------------------------------------------------- term derivation

STOPWORDS='^(a|an|and|any|are|as|at|be|been|but|by|can|could|do|does|during|each|for|from|has|have|how|in|into|is|it|its|no|not|of|on|or|should|that|the|their|this|to|was|were|what|when|where|which|who|will|with|would|after|before|all|only|then|than|there|these|those|some|such|very|just|also|more|most|other|over|under|about|against|between|through|every|never|always|zero|one|two|used|uses|using)$'

DERIVED=false
if [[ ${#TERMS[@]} -eq 0 ]]; then
  DERIVED=true
  ID_TITLE=$(printf '%s' "$TITLE" | sed -E 's/^\[SEV-[0-9]\][[:space:]]*//')
  while IFS= read -r t; do TERMS+=("$t"); done < <(
    {
      printf '%s\n' "$ID_TITLE" | grep -oE '`[^`]+`' | tr -d '`' || true
      printf '%s\n' "$ID_TITLE" | grep -oE '[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*(/[0-9]+)?' || true
      printf '%s\n' "$ID_TITLE" | grep -oE '[a-z][a-z0-9]*(_[a-z0-9]+)+' || true
      printf '%s\n' "$ID_TITLE" | grep -oE '[A-Z][a-z0-9]+([A-Z][a-z0-9]+)+' || true
      printf '%s\n' "$ID_TITLE" | grep -oE '[A-Z]{3,}' || true
    } 2>/dev/null | sort -u | head -n "$MAX_TERMS"
  )

  # Only when the title carries no identifier at all. Never pad good terms with weak ones —
  # one distinctive term beats four generic ones, and the breadth filter culls the rest.
  if [[ ${#TERMS[@]} -eq 0 ]]; then
    while IFS= read -r t; do TERMS+=("$t"); done < <(
      printf '%s\n' "$TITLE" \
        | tr '[:upper:]' '[:lower:]' \
        | tr -cs '[:alnum:]_' '\n' \
        | grep -vE "$STOPWORDS" \
        | awk 'length >= 4' \
        | sort -u | head -n "$MAX_TERMS"
    )
  fi
fi

CLEAN=()
for t in ${TERMS[@]+"${TERMS[@]}"}; do
  [[ -n "$t" && ${#CLEAN[@]} -lt $MAX_TERMS ]] && CLEAN+=("$t")
done
TERMS=(${CLEAN[@]+"${CLEAN[@]}"})
[[ ${#TERMS[@]} -gt 0 ]] || { echo "could not derive search terms; pass them explicitly" >&2; exit 0; }

# ---------------------------------------------------------------- the query battery
#
# The searches are independent, so they run concurrently and are collected in a fixed order
# afterwards. Order matters: `collect` appends to RAW and the ranking below is stable-sorted,
# so shuffling arrivals would shuffle output. Wall time drops from the sum to the max.

RAW=$(mktemp); BROAD=$(mktemp); FAILED=$(mktemp)
QDIR=$(mktemp -d); trap 'rm -f "$RAW" "$BROAD" "$FAILED"; rm -rf "$QDIR"' EXIT

SHAPE='.[] | {number, title, state, stateReason: (.stateReason // ""), labels: [.labels[].name]}'

# Collect into RAW, one JSON object per line, tagged with the query that found it. A term whose
# result set exceeds the breadth filter is discarded whole and recorded in BROAD.
collect() { # query-tag  json-lines
  local tag="$1" body="$2" n
  n=$(printf '%s' "$body" | grep -c . || true)
  [[ "$n" -eq 0 ]] && return 0
  if [[ "$n" -gt "$MAX_TERM_HITS" ]]; then
    printf '%s\t%s\n' "$tag" "$n" >>"$BROAD"
    return 0
  fi
  printf '%s' "$body" | jq -c --arg q "$tag" '. + {q: $q}' >>"$RAW" || true
}

# A failed query and a query that legitimately matched nothing both leave an empty file, so
# failure needs a channel of its own: the exit status lands in <idx>.fail and stderr in <idx>.err,
# read back in TAGS order with everything else. Discarding stderr here — as this did — turns a
# rate-limited, 5xx or expired-auth run into "No candidates. File it", which is the worst
# available output: the one that reads as permission to proceed.
query() { # index  --  command...
  local idx="$1"; shift
  "$@" >"$QDIR/$idx" 2>"$QDIR/$idx.err" || printf '%s' "$?" >"$QDIR/$idx.fail"
}

TAGS=()
i=0
for t in "${TERMS[@]}"; do
  TAGS+=("title:$t")
  query "$i" gh issue list --repo "$REPO" --state all --limit 60 --search "$t in:title" \
    --json number,title,state,stateReason,labels -q "$SHAPE" &
  i=$((i + 1))
done

TAGS+=("fulltitle")
query "$i" gh issue list --repo "$REPO" --state all --limit 60 --search "$TITLE" \
  --json number,title,state,stateReason,labels -q "$SHAPE" &
i=$((i + 1))

if [[ ${#TERMS[@]} -ge 2 ]]; then
  TAGS+=("pair")
  query "$i" gh issue list --repo "$REPO" --state all --limit 60 --search "${TERMS[0]} ${TERMS[1]}" \
    --json number,title,state,stateReason,labels -q "$SHAPE" &
  i=$((i + 1))
fi

# Comments are an indexed field, and a correction to a wrong description lives only there — so this
# is the only query that finds an issue under what it actually turned out to be.
for t in "${TERMS[@]}"; do
  TAGS+=("comments:$t")
  query "$i" gh search issues --repo "$REPO" --match title,body,comments --limit 60 "$t" \
    --json number,title,state,labels -q "$SHAPE" &
  i=$((i + 1))
done

wait

for n in "${!TAGS[@]}"; do
  if [[ -f "$QDIR/$n.fail" ]]; then
    printf '%s\t%s\n' "${TAGS[$n]}" \
      "$(head -n1 "$QDIR/$n.err" 2>/dev/null | tr -d '\r' | cut -c1-100)" >>"$FAILED"
    continue
  fi
  collect "${TAGS[$n]}" "$(cat "$QDIR/$n" 2>/dev/null || true)"
done

NFAILED=$(grep -c . "$FAILED" 2>/dev/null || true)
NQUERIES=${#TAGS[@]}

# ---------------------------------------------------------------- resolve unknown close reasons
#
# `gh search issues --json` has no stateReason field, so a closed issue found ONLY by query 4
# reaches the classifier with no close reason and degrades to "read the thread" — exactly the
# candidates the comment search exists to surface. Look those up directly. Bounded by the number
# of closed-and-unknown hits, not by the candidate count.

# `tr -d '\r'` is not cosmetic: the Windows jq build emits CRLF, so every line but the last
# arrives as "208\r" and `gh issue view` rejects it with `invalid issue format`. Silently — the
# lookup returns empty and the candidate keeps its unresolved verdict.

if [[ -s "$RAW" ]]; then
  UNKNOWN=$(jq -s -r '
    group_by(.number)
    | map(select((.[0].state | ascii_upcase) == "CLOSED"
                 and ([.[].stateReason] | map(select(. != "")) | length) == 0))
    | .[] | .[0].number
  ' "$RAW" 2>/dev/null | tr -d '\r' || true)

  # One GraphQL call for every unknown reason at once, then a single jq merge. The old form made
  # one `gh issue view` AND one whole-file jq rewrite per issue, which is quadratic in candidates.
  if [[ -n "$UNKNOWN" ]]; then
    Q="{ repository(owner: \"${REPO%%/*}\", name: \"${REPO##*/}\") {"
    for n in $UNKNOWN; do
      [[ "$n" =~ ^[0-9]+$ ]] || continue
      Q="$Q i$n: issue(number: $n) { number stateReason }"
    done
    Q="$Q } }"

    REASONS=$(gh api graphql -f query="$Q" \
      --jq '[.data.repository[] | select(. != null) | {key: (.number|tostring), value: (.stateReason // "")}] | from_entries' \
      2>/dev/null || echo '{}')

    jq -c --argjson r "${REASONS:-{\}}" \
      'if .stateReason == "" and ($r[(.number|tostring)] // "") != ""
       then .stateReason = $r[(.number|tostring)] else . end' \
      "$RAW" >"$RAW.tmp" && mv "$RAW.tmp" "$RAW"
  fi
fi

# ---------------------------------------------------------------- classify and rank

CANDIDATES=$(jq -s '
  group_by(.number)
  | map(
      (.[0]) as $f
      | $f + {
          hits: (map(.q) | unique | length),
          queries: (map(.q) | unique | join(", ")),
          stateReason: (map(.stateReason) | map(select(. != "")) | first // ""),
          resolution: (($f.labels // []) | map(select(startswith("resolution:"))) | first // "")
        }
    )
  | map(. + {
      # The parentheses are load-bearing: jq 1.7 rejects a bare `if` as an object value,
      # while 1.6 and 1.8 accept it. Debian stable ships 1.7, so without them this whole
      # program is a compile error on most Linux machines -- and the error used to be
      # swallowed into an empty candidate list, i.e. "No candidates. File it".
      verdict: (
        if (.state | ascii_upcase) == "OPEN"                    then "open"
        elif .resolution != ""                                  then "decision"
        elif (.stateReason | ascii_upcase) == "COMPLETED"        then "regression"
        else "closed-unknown" end
      )
    })
  | sort_by([{decision:0, "closed-unknown":1, open:2, regression:3}[.verdict], -.hits])
' "$RAW" 2>"$QDIR/classify.err" || true)

# A classifier that failed and a search that found nothing both used to render as
# "No candidates. File it" -- the same silent-failure shape as a failed query, one layer
# down. An empty result here can only mean jq itself failed, since an empty RAW still
# slurps to a valid `[]`.
if [[ -z "${CANDIDATES//[[:space:]]/}" ]]; then
  printf '
  ⚠  Could not classify the search results — this run is INCOMPLETE.
'
  while IFS= read -r line; do printf '     %s
' "$line"; done     < <(head -n 3 "$QDIR/classify.err" 2>/dev/null | tr -d '\r')
  printf '     Treat this as UNKNOWN, never as "no duplicates found". Re-run before filing.
'
  printf '     `jq --version` — this needs 1.6 or newer.

'
  exit 0
fi

TOTAL=$(jq 'length' <<<"$CANDIDATES")

if $TSV; then
  # Warnings go to stderr so the TSV stream stays parseable, but never nowhere.
  if [[ "$NFAILED" -gt 0 ]]; then
    printf 'INCOMPLETE: %s of %s searches failed\n' "$NFAILED" "$NQUERIES" >&2
    awk -F'\t' '{printf "  %s%s\n", $1, ($2 == "" ? "" : ": " $2)}' "$FAILED" >&2
  fi
  if [[ -s "$BROAD" ]]; then
    { printf 'skipped: '
      awk '{printf "%s (%s hits) ", $1, $2}' "$BROAD"
      printf '\n         too broad to be distinctive — over %s hits. Results discarded, not truncated.\n' "$MAX_TERM_HITS"
    } >&2
  fi
  jq -r '.[] | [.number, .verdict, .hits, .state, .resolution, .title] | @tsv' <<<"$CANDIDATES" \
    | tr -d '\r'
  exit 0
fi

printf '\nrepo:   %s\n' "$REPO"
printf 'title:  %s\n' "$TITLE"
printf 'terms:  %s%s\n' "$(printf '%s · ' "${TERMS[@]}" | sed 's/ · $//')" \
                        "$($DERIVED && echo '   (derived from the title)' || echo '   (given)')"

if [[ "$NFAILED" -gt 0 ]]; then
  printf '\n  ⚠  %s of %s searches FAILED — what follows is INCOMPLETE.\n' "$NFAILED" "$NQUERIES"
  awk -F'\t' '{printf "     %s%s\n", $1, ($2 == "" ? "" : "  —  " $2)}' "$FAILED"
  printf '     A duplicate these searches would have found is still a duplicate. Re-run before\n'
  printf '     you file, and do not record this run as `**Candidates:** none`.\n'
fi

if [[ -s "$BROAD" ]]; then
  printf 'skipped: '
  awk -v m="$MAX_TERM_HITS" '{printf "%s (%s hits) ", $1, $2}' "$BROAD"
  printf '\n         too broad to be distinctive — over %s hits. Results discarded, not truncated.\n' "$MAX_TERM_HITS"
fi

printf 'found:  %s candidate(s)\n\n' "$TOTAL"

if [[ "$TOTAL" -eq 0 ]]; then
  if [[ "$NFAILED" -gt 0 ]]; then
    cat <<'EOF'
  Zero rows, but searches failed — so this is an UNKNOWN result, not an empty one, and it is
  not grounds for filing. Re-run; file only once a complete search comes back empty.

EOF
  elif [[ -s "$BROAD" ]]; then
    cat <<'EOF'
  Zero rows, but the searches under "skipped:" were discarded as too broad, so this is not a
  clean result. Re-run with distinctive terms (an identifier, the error text, a file path) or a
  higher --broad before recording `**Candidates:** none`.

EOF
  else
    cat <<'EOF'
  No candidates. File it — and put the Searched: block in the issue body with
  `**Candidates:** none`, so the next agent can see this check ran.

EOF
  fi
  exit 0
fi

# A candidate found by exactly one search, with nothing corroborating it, is usually a false
# positive. Suppress those once there is real signal — but never suppress anything that needs the
# operator, however it was found.
STRONG=$(jq '[.[] | select(.hits >= 2 or .verdict == "decision" or .verdict == "closed-unknown")] | length' <<<"$CANDIDATES")

if [[ "$STRONG" -eq 0 ]]; then
  printf '  Nothing corroborated. Every hit below came from a single search with nothing agreeing,\n'
  printf '  which usually means no real candidate exists — skim them, then file.\n\n'
fi

SHOWN=$(jq --argjson max "$MAX_ROWS" '
  (map(select(.hits >= 2 or .verdict == "decision" or .verdict == "closed-unknown"))) as $strong
  | (if ($strong | length) >= 3 then $strong else . end)
  | .[:$max]
' <<<"$CANDIDATES")

jq -r '.[] |
  (if   .verdict == "decision"       then "★ DECISION     "
   elif .verdict == "closed-unknown" then "? CLOSED       "
   elif .verdict == "regression"     then "↻ CLOSED, FIXED"
   else                                   "  OPEN         " end)
  + "  " + (.hits|tostring) + "×  #" + (.number|tostring) + "  " + .title
  + (if .resolution != "" then "\n                     → " + .resolution else "" end)
' <<<"$SHOWN" | tr -d '\r'

HIDDEN=$((TOTAL - $(jq 'length' <<<"$SHOWN")))
if [[ "$HIDDEN" -gt 0 ]]; then
  printf '\n  … %s weaker candidate(s) not shown — matched by a single search, nothing corroborating.\n' "$HIDDEN"
  printf '    Re-run with --tsv for every hit.\n'
fi

cat <<'EOF'

  ★ DECISION       a human already adjudicated this. STOP — show the operator the link and the
                   stated reason, and ask what changed. Never refile without an explicit yes.
  ? CLOSED         closed with no resolution label. Read the thread: either a past fix (a new
                   occurrence is a regression) or an undocumented decision.
  ↻ CLOSED, FIXED  a new occurrence is a REGRESSION, not a duplicate. File it, link the original,
                   and name the commit that fixed it the first time.
    OPEN           possible duplicate. Add your evidence to that issue rather than filing a second.

  N× is how many of the searches found it independently. Two agreeing beats one broad hit.
  Record the outcome in the Searched: block — see references/duplicate-check.md.
EOF

NEEDS=$(jq '[.[] | select(.verdict == "decision" or .verdict == "closed-unknown")] | length' <<<"$CANDIDATES")
[[ "$NEEDS" -gt 0 ]] && printf '\n  %s hit(s) need the operator to weigh in before you file.\n\n' "$NEEDS" || printf '\n'

exit 0
