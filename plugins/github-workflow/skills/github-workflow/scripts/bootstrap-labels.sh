#!/usr/bin/env bash
#
# bootstrap-labels.sh — create or update the github-workflow label taxonomy on a GitHub repo.
#
# Idempotent: uses `gh label create --force`, which updates colour and description if the
# label already exists. Safe to re-run after adding an area. Never deletes anything.
#
# Invoke via `bash`, not `./` — git does not record the executable bit on Windows checkouts
# (core.filemode=false), so `./bootstrap-labels.sh` fails with "Permission denied" elsewhere.
#
#   bash bootstrap-labels.sh                          # current repo, settings from its config
#   bash bootstrap-labels.sh --repo owner/name        # a specific repo
#   bash bootstrap-labels.sh --areas api,ui,checkout  # the area: set (replaces the default)
#   bash bootstrap-labels.sh --board                  # a Projects board owns in-flight state
#   bash bootstrap-labels.sh --config path/to.json    # read settings from this file
#   bash bootstrap-labels.sh --dry-run                # print what would happen, change nothing
#
# SETTINGS. Without --config, the repository's .github/github-workflow.json is read when it
# exists: `areas` becomes the area: set and `"inFlightState": "board"` implies --board. Flags
# beat the config. With neither, the generic areas are used in labels-only mode.
#
# BOARD MODE. A repo whose GitHub Projects board owns in-flight state must not also carry
# status:in-progress and status:needs-review -- two writers for one fact is how state goes
# stale. --board skips those two and keeps the three status: labels a board cannot express.
#
# Requires: gh, authenticated with write access (not for --dry-run); jq only when a config
# file is read. Reference: ../references/labels.md

set -euo pipefail

REPO=""
DRY_RUN=false
BOARD=false
AREAS_FLAG=""
CONFIG=""
DEFAULT_AREAS="api,ui,db,auth,infra,integrations,docs,ci"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)     [[ $# -ge 2 && -n "$2" ]] || { echo "--repo needs owner/name" >&2; exit 2; }
                REPO="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=true; shift ;;
    --board)    BOARD=true; shift ;;
    --areas)    [[ $# -ge 2 && -n "$2" ]] || { echo "--areas needs a comma-separated list" >&2; exit 2; }
                AREAS_FLAG="$2"; shift 2 ;;
    --config)   [[ $# -ge 2 && -n "$2" ]] || { echo "--config needs a path" >&2; exit 2; }
                CONFIG="$2"; shift 2 ;;
    -h|--help)  awk 'NR>2 && /^#/ {sub(/^# ?/,""); print; next} NR>2 {exit}' "$0"; exit 0 ;;
    *)          echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- settings

if [[ -z "$CONFIG" ]]; then
  root=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [[ -n "$root" && -f "$root/.github/github-workflow.json" ]]; then
    CONFIG="$root/.github/github-workflow.json"
  fi
fi

CONFIG_AREAS=""
if [[ -n "$CONFIG" ]]; then
  [[ -f "$CONFIG" ]] || { echo "config not found: $CONFIG" >&2; exit 2; }
  command -v jq >/dev/null || { echo "jq is not installed -- it is needed to read $CONFIG" >&2; exit 1; }
  # Windows editors save JSON with a UTF-8 BOM and CRLF line endings. jq rejects the first,
  # and the Windows jq build echoes the second into every value it prints.
  json=$(sed $'1s/^\xef\xbb\xbf//' "$CONFIG" | tr -d '\r')
  if ! jq -e 'type == "object" and .version == 1 and ((.areas // []) | type == "array")' >/dev/null 2>&1 <<<"$json"; then
    echo "not a valid config (a JSON object with \"version\": 1 and an \"areas\" array): $CONFIG -- fix it, or run /github-workflow:doctor" >&2
    exit 2
  fi
  CONFIG_AREAS=$(jq -r '(.areas // []) | map(tostring) | join(",")' <<<"$json" | tr -d '\r')
  if [[ "$(jq -r '.inFlightState // "labels"' <<<"$json" | tr -d '\r')" == "board" ]]; then
    BOARD=true
  fi
fi

AREAS="${AREAS_FLAG:-${CONFIG_AREAS:-$DEFAULT_AREAS}}"
AREA_LIST=()
IFS=',' read -r -a raw_areas <<<"$AREAS"
for a in ${raw_areas[@]+"${raw_areas[@]}"}; do
  a="${a//[[:space:]]/}"
  [[ -z "$a" ]] && continue
  if [[ ! "$a" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    echo "invalid area name: '$a' -- lowercase letters, digits and hyphens only" >&2
    exit 2
  fi
  AREA_LIST+=("$a")
done
[[ ${#AREA_LIST[@]} -gt 0 ]] || { echo "no areas to create" >&2; exit 2; }

if ! $DRY_RUN; then
  command -v gh >/dev/null       || { echo "gh is not installed"     >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated" >&2; exit 1; }
fi

# ---------------------------------------------------------------- labels

count=0

label() { # name  colour  description
  count=$((count + 1))
  if $DRY_RUN; then
    printf '  would set  %-30s #%s\n' "$1" "$2"
    return
  fi
  local args=(label create "$1" --color "$2" --description "$3" --force)
  [[ -n "$REPO" ]] && args+=(--repo "$REPO")
  gh "${args[@]}" >/dev/null
  printf '  ok  %-30s #%s\n' "$1" "$2"
}

if [[ -n "$REPO" ]]; then
  target="$REPO"
elif $DRY_RUN; then
  target="(current repo)"
else
  target=$(gh repo view --json nameWithOwner -q .nameWithOwner)
fi

echo "Labels → ${target}"
$DRY_RUN && echo "(dry run — nothing will change)"
$BOARD && echo "(board mode — a Projects board owns in-flight state)"

echo
echo "type: — what kind of work this is"
label "type:feature"      "0E8A16" "A capability that does not exist today"
label "type:enhancement"  "A2EEEF" "Existing behaviour made better, faster or clearer"
label "type:bug"          "D73A4A" "Behaviour differs from intended behaviour"
label "type:security"     "B60205" "Vulnerability, exposure, or hardening"
label "type:chore"        "FEF2C0" "Dependencies, build, tooling, config"
label "type:docs"         "0075CA" "Documentation only"
label "type:refactor"     "C5DEF5" "Internal restructuring, no behaviour change"
label "type:test"         "BFD4F2" "Test coverage or test infrastructure only"
label "type:spike"        "D4C5F9" "Timeboxed investigation; output is a decision or another issue"

echo
echo "severity: — how bad it is when it happens"
label "severity:sev-1"    "B60205" "Critical - production down, data loss, money wrong, security breach, no workaround"
label "severity:sev-2"    "D93F0B" "High - core flow broken for a segment, tenant or role; painful workaround"
label "severity:sev-3"    "FBCA04" "Medium - bounded misbehaviour, clear workaround"
label "severity:sev-4"    "C2E0C6" "Low - cosmetic, copy, or a rare edge case"

echo
echo "priority: — when we act on it"
label "priority:p0"       "5319E7" "Drop everything - being worked now"
label "priority:p1"       "8A63F2" "Committed - current cycle"
label "priority:p2"       "B197FC" "Planned, next cycle"
label "priority:p3"       "E0D5FA" "Backlog"

echo
if $BOARD; then
  echo "status: — meanings a board's Status field does not express"
else
  echo "status: — triage and in-flight state (labels-only mode)"
fi
label "status:needs-triage" "EDEDED" "Filed, not yet prioritised"
label "status:needs-info"   "FEF2C0" "Blocked on an answer from the reporter"
label "status:blocked"      "E11D21" "Blocked - the comment must name the blocker"
if ! $BOARD; then
  label "status:in-progress"  "1D76DB" "Actively being worked"
  label "status:needs-review" "5319E7" "PR open, awaiting human review"
fi

echo
echo "resolution: — why it closed, when it was not a normal fix"
label "resolution:duplicate"         "CFD3D7" "Tracked by another issue - the closing comment names it"
label "resolution:wontfix"           "CFD3D7" "Real, understood, deliberately not being fixed"
label "resolution:cannot-reproduce"  "CFD3D7" "Could not reproduce - the closing comment lists what was tried"
label "resolution:works-as-intended" "CFD3D7" "Behaviour is correct; the expectation was wrong"

echo
echo "area: — which part of the system"
for a in "${AREA_LIST[@]}"; do
  label "area:${a}" "006B75" "Area: ${a}"
done

# No delivery-planning labels (wave:, phase:, sprint:). Planning metadata has no fixed
# cardinality -- the set grows forever and every old value stays in the picker. Use sub-issues
# or a milestone instead; see ../references/labels.md.

echo
if $DRY_RUN; then
  echo "${count} labels would be created or updated. Re-run without --dry-run to apply."
else
  echo "${count} labels created or updated on ${target}."
  echo "Review with: gh label list --limit 100${REPO:+ --repo $REPO}"
fi

# GitHub's stock labels shadow this taxonomy. Nothing is deleted here -- that is destructive
# and the operator's call -- but flag them so nobody applies `bug` when they mean `type:bug`.
if ! $DRY_RUN; then
  stock=$(gh label list --limit 200 ${REPO:+--repo "$REPO"} --json name -q '.[].name' \
          | tr -d '\r' | grep -Ex 'bug|enhancement|documentation|duplicate|wontfix|question|invalid' || true)
  if [[ -n "$stock" ]]; then
    echo
    echo "Note: GitHub's stock labels are still present and shadow this taxonomy:"
    echo "$stock" | sed 's/^/  /'
    echo "  Never apply these -- use type:bug, type:enhancement, type:docs, resolution:duplicate,"
    echo "  resolution:wontfix, status:needs-info instead. Deleting them is a human decision."
  fi
fi
