#!/usr/bin/env bash
#
# run-tests.sh — the test gate for the github-workflow plugin's bash tooling.
#
# Runs with bash alone. No Node, no third-party framework: the scripts under test need bash,
# gh and jq, and so does this, so any agent that can run them can verify them.
#
# Invoke via `bash`, not `./` — git does not record the executable bit on Windows
# checkouts (core.filemode=false).
#
#   bash tests/github-workflow/run-tests.sh
#   bash tests/github-workflow/run-tests.sh --filter doc-links   # substring of file or test
#   bash tests/github-workflow/run-tests.sh --verbose            # show passing output too
#
# A test file defines `test_*` functions and NOTHING at top level: the runner sources it
# to enumerate them, so top-level work would run twice and leak between files.
#
# Each test runs in its own subshell with its own TEST_TMP, under `set -e`. An assertion
# that fails aborts its own test and no other, and the runner reads the exit status. That
# gives isolation without shared counters, which a subshell could not update anyway.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$HERE/../.." && pwd)
PLUGIN_ROOT="$REPO_ROOT/plugins/github-workflow"
SCRIPTS="$PLUGIN_ROOT/skills/github-workflow/scripts"
TESTS_DIR="$HERE"
export PLUGIN_ROOT REPO_ROOT SCRIPTS TESTS_DIR

FILTER=""
VERBOSE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --filter)  FILTER="${2:?--filter needs a pattern}"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    -h|--help) awk 'NR>2 && /^#/ {sub(/^# ?/,""); print; next} NR>2 {exit}' "$0"; exit 0 ;;
    *)         echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null || { echo "jq is not installed — the scripts under test need it" >&2; exit 1; }

shopt -s nullglob
FILES=("$HERE"/*.test.sh)
shopt -u nullglob

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "no *.test.sh files found in $HERE" >&2
  exit 1
fi

total=0; failed=0; skipped=0
FAILED_NAMES=()

for file in "${FILES[@]}"; do
  base=$(basename "$file" .test.sh)

  # Enumerate test functions in a throwaway shell so sourcing cannot affect this one.
  funcs=()
  while IFS= read -r fn; do funcs+=("$fn"); done < <(
    bash -c "source '$HERE/helpers.sh'; source '$file'; declare -F" 2>/dev/null \
      | awk '{print $3}' | grep '^test_' | sort
  )

  if [[ ${#funcs[@]} -eq 0 ]]; then
    printf '  %-22s no test_* functions found\n' "$base" >&2
    failed=$((failed + 1))
    FAILED_NAMES+=("$base (no tests)")
    continue
  fi

  printf '\n%s\n' "$base"

  for fn in "${funcs[@]}"; do
    name="${fn#test_}"
    name="${name//_/ }"

    if [[ -n "$FILTER" && "$base" != *"$FILTER"* && "$fn" != *"$FILTER"* ]]; then
      skipped=$((skipped + 1))
      continue
    fi

    total=$((total + 1))
    tmp=$(mktemp -d)

    # Both streams into $out, so a diagnostic is printed under its own FAIL line rather
    # than escaping to the terminal ahead of it.
    out=$(
      {
        set -e
        export TEST_TMP="$tmp"
        # shellcheck source=/dev/null
        source "$HERE/helpers.sh"
        # shellcheck source=/dev/null
        source "$file"
        "$fn"
      } 2>&1
    )
    status=$?

    rm -rf "$tmp"

    if [[ $status -eq 0 ]]; then
      printf '  ok    %s\n' "$name"
      if $VERBOSE && [[ -n "$out" ]]; then sed 's/^/          /' <<<"$out"; fi
    else
      printf '  FAIL  %s\n' "$name"
      [[ -n "$out" ]] && sed 's/^/          /' <<<"$out"
      failed=$((failed + 1))
      FAILED_NAMES+=("$base :: $name")
    fi
  done
done

printf '\n  %s test(s) · %s passed · %s failed' "$total" "$((total - failed))" "$failed"
[[ $skipped -gt 0 ]] && printf ' · %s filtered out' "$skipped"
printf '\n\n'

if [[ $failed -gt 0 ]]; then
  printf '  Failed:\n'
  printf '    %s\n' "${FAILED_NAMES[@]}"
  printf '\n'
  exit 1
fi

exit 0
