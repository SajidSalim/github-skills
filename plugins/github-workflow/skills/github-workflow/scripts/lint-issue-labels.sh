#!/usr/bin/env bash
#
# lint-issue-labels.sh — check issues against the label taxonomy in references/labels.md.
#
# Reports only. It never edits an issue, never adds or removes a label, and never closes anything.
# Exits non-zero when any issue violates the taxonomy, so it can be wired to CI later.
#
# Invoke via `bash`, not `./` — git does not record the executable bit on Windows checkouts
# (core.filemode=false), so `./lint-issue-labels.sh` fails with "Permission denied" elsewhere.
#
#   bash lint-issue-labels.sh 231              # one issue
#   bash lint-issue-labels.sh --pr 236         # one pull request
#   bash lint-issue-labels.sh --all            # open issues, up to --limit (default 500)
#   bash lint-issue-labels.sh --all --state all
#   bash lint-issue-labels.sh --all --quiet    # violations only, no clean-issue lines
#   bash lint-issue-labels.sh --repo owner/name --all
#
# Rules checked, per references/labels.md:
#   1. exactly one type:
#   2. exactly one priority:, OR status:needs-triage with no priority:
#   3. exactly one severity: when type:bug or type:security
#   4. at least one area:
#   5. at most one status: and at most one resolution:
#   6. [SEV-1]/[SEV-2] title prefix present if and only if that severity label is present
#   7. none of GitHub's stock labels, which shadow the taxonomy
#   8. closed with a reason other than "completed" carries a resolution:
#
# PULL REQUESTS (--pr) are checked against rules 1, 4, 5 and 7 only. A PR carries exactly one
# type: and at least one area:, mirroring the issue it resolves. priority: and severity: are
# scheduling and impact facts about the problem itself, so they live on the issue and are
# neither required nor expected on the branch that fixes it; the [SEV-n] title prefix and the
# closed-with-a-resolution rule are issue concerns for the same reason.
#
# --pr takes explicit numbers. There is no --pr --all sweep: `gh issue list` excludes pull
# requests, and a repo-wide PR sweep is a wider question than this checks.
#
# Requires: gh (authenticated), jq. Reference: references/labels.md

set -euo pipefail

REPO=""
ALL=false
PR_MODE=false
QUIET=false
STATE="open"
LIMIT=500
NUMBERS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)    REPO="${2:?--repo needs owner/name}"; shift 2 ;;
    --all)     ALL=true; shift ;;
    --pr)      PR_MODE=true; shift ;;
    --state)   STATE="${2:?--state needs open|closed|all}"; shift 2 ;;
    --limit)   LIMIT="${2:?--limit needs a number}"; shift 2 ;;
    --quiet)   QUIET=true; shift ;;
    -h|--help) awk 'NR>2 && /^#/ {sub(/^# ?/,""); print; next} NR>2 {exit}' "$0"; exit 0 ;;
    -*)        echo "unknown option: $1" >&2; exit 2 ;;
    *)         NUMBERS+=("$1"); shift ;;
  esac
done

if ! $ALL && [[ ${#NUMBERS[@]} -eq 0 ]]; then
  echo "usage: bash lint-issue-labels.sh <number>... | --pr <number>... | --all [--state open|closed|all]" >&2
  exit 2
fi

if $PR_MODE && $ALL; then
  echo "--pr --all is not supported: gh issue list excludes pull requests." >&2
  echo "Pass PR numbers explicitly." >&2
  exit 2
fi

command -v gh >/dev/null       || { echo "gh is not installed"     >&2; exit 1; }
command -v jq >/dev/null       || { echo "jq is not installed"     >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated" >&2; exit 1; }

[[ -n "$REPO" ]] || REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

FIELDS=number,title,state,stateReason,labels
# `gh pr view` has no stateReason field. The rule that consumes it is issue-only, and jq's
# `.stateReason // ""` already tolerates its absence.
$PR_MODE && FIELDS=number,title,state,labels

DATA=$(mktemp); trap 'rm -f "$DATA"' EXIT

if $ALL; then
  gh issue list --repo "$REPO" --state "$STATE" --limit "$LIMIT" --json "$FIELDS" >"$DATA"
else
  printf '[' >"$DATA"
  sep=""
  for n in "${NUMBERS[@]}"; do
    printf '%s' "$sep" >>"$DATA"
    if $PR_MODE; then
      gh pr view "$n" --repo "$REPO" --json "$FIELDS" >>"$DATA"
    else
      gh issue view "$n" --repo "$REPO" --json "$FIELDS" >>"$DATA"
    fi
    sep=","
  done
  printf ']' >>"$DATA"
fi

# One jq pass produces a violation list per issue. Everything below is presentation.
REPORT=$(jq -r --argjson pr "$PR_MODE" '
  def names: [.labels[].name];
  def of($p): names | map(select(startswith($p)));

  map(
    . as $i
    | (of("type:"))       as $type
    | (of("priority:"))   as $prio
    | (of("severity:"))   as $sev
    | (of("area:"))       as $area
    | (of("status:"))     as $status
    | (of("resolution:")) as $res
    | (names | map(select(. == "bug" or . == "enhancement" or . == "documentation"
                          or . == "duplicate" or . == "wontfix" or . == "question"))) as $stock
    | (($type | first) // "") as $t
    | ([
        (if   ($type|length) == 0 then "no type: label"
         elif ($type|length) >  1 then "multiple type: labels — " + ($type|join(", "))
         else empty end),

        (if $pr then
           (if ($prio|length) > 1 then "multiple priority: labels — " + ($prio|join(", "))
            else empty end)
         elif ($prio|length) > 1 then "multiple priority: labels — " + ($prio|join(", "))
         elif ($prio|length) == 0 and (($status | index("status:needs-triage")) == null)
           then "no priority: label and no status:needs-triage"
         elif ($prio|length) == 1 and (($status | index("status:needs-triage")) != null)
           then "carries both a priority: label and status:needs-triage"
         else empty end),

        (if $pr then
           (if ($sev|length) > 1 then "multiple severity: labels — " + ($sev|join(", "))
            else empty end)
         elif ($t == "type:bug" or $t == "type:security") then
           (if   ($sev|length) == 0 then "no severity: label on " + $t
            elif ($sev|length) >  1 then "multiple severity: labels — " + ($sev|join(", "))
            else empty end)
         elif ($sev|length) > 1 then "multiple severity: labels — " + ($sev|join(", "))
         else empty end),

        (if ($area|length) == 0 then "no area: label" else empty end),
        (if ($status|length) > 1 then "multiple status: labels — " + ($status|join(", ")) else empty end),
        (if ($res|length) > 1 then "multiple resolution: labels — " + ($res|join(", ")) else empty end),

        (if $pr then empty else
         (($sev | index("severity:sev-1")) as $s1
         | ($sev | index("severity:sev-2")) as $s2
         | ($i.title | startswith("[SEV-1]")) as $p1
         | ($i.title | startswith("[SEV-2]")) as $p2
         | if   ($s1 != null) and ($p1 | not) then "severity:sev-1 without the [SEV-1] title prefix"
           elif ($s2 != null) and ($p2 | not) then "severity:sev-2 without the [SEV-2] title prefix"
           elif $p1 and ($s1 == null)         then "[SEV-1] title prefix without the severity:sev-1 label"
           elif $p2 and ($s2 == null)         then "[SEV-2] title prefix without the severity:sev-2 label"
           else empty end) end),

        (if ($stock|length) > 0
           then "GitHub stock label(s) shadowing the taxonomy — " + ($stock|join(", "))
           else empty end),

        (if $pr | not then
           (if ($i.state | ascii_downcase) == "closed"
            and (($i.stateReason // "") | ascii_upcase) != "COMPLETED"
            and ($res|length) == 0
            then "closed as " + (($i.stateReason // "unknown")|ascii_downcase) + " with no resolution: label"
            else empty end)
         else empty end)
      ]) as $problems
    | {number: $i.number, title: $i.title, problems: $problems}
  )
  | sort_by(.number)
  | .[]
  | (.number|tostring) + "\u001f" + ((.problems|length)|tostring) + "\u001f" + .title
    + "\u001f" + (.problems | join(" \u0002 "))
' "$DATA")

total=0; bad=0; problems=0

while IFS=$'\037' read -r num count title probs; do
  [[ -z "${num:-}" ]] && continue
  total=$((total + 1))
  if [[ "$count" -eq 0 ]]; then
    $QUIET || printf '  ok    #%-5s %s\n' "$num" "$title"
  else
    bad=$((bad + 1)); problems=$((problems + count))
    printf '  FAIL  #%-5s %s\n' "$num" "$title"
    printf '%s\n' "$probs" | tr '\002' '\n' | sed 's/^ *//; s/^/          · /'
  fi
done <<<"$REPORT"

# `gh issue edit` rejects a PR number, so the remedy line has to match the mode it ran in.
if $PR_MODE; then NOUN=PR; CMD='pr'; else NOUN=issue; CMD='issue'; fi

# A full page from `gh issue list` means the sweep may have stopped short of the backlog, and
# a clean summary must not read as a complete audit.
TRUNC=""
if $ALL; then
  got=$(jq length "$DATA" | tr -d '\r')
  if [[ "$got" -ge "$LIMIT" ]]; then TRUNC=" · stopped at --limit $LIMIT, there may be more"; fi
fi

printf '\n  %s %s(s) checked · %s clean · %s with %s violation(s)%s\n\n' \
  "$total" "$NOUN" "$((total - bad))" "$bad" "$problems" "$TRUNC"

if [[ "$bad" -gt 0 ]]; then
  printf '  Fix with `gh %s edit <n> --add-label ... --remove-label ...`, per references/labels.md.\n' "$CMD"
  printf '  Never invent a label: `bash "%s/bootstrap-labels.sh"` (or /github-workflow:setup) creates the set.\n\n' \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  exit 1
fi

exit 0
