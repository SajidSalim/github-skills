#!/usr/bin/env bash
#
# Tests for find-duplicates.sh. Every case marks a real failure shape this script once had:
#   - a close-reason lookup that resolved only the last candidate (CRLF from the Windows jq)
#   - a failed query rendered as zero candidates
#   - a jq version that rejected the classifier, swallowed into "No candidates. File it"

_GOLDEN="$TESTS_DIR/__fixtures__/find-duplicates.golden.txt"
_TITLE="Checkout returns 500 when the coupon code is blank"

_OPEN='{"number":88,"title":"Checkout 500 on blank coupon_code","state":"OPEN","stateReason":"","labels":["type:bug"]}'
_CLOSED='{"number":142,"title":"coupon_code blank handling is deliberate","state":"CLOSED","stateReason":"","labels":["resolution:works-as-intended"]}'

# #88 is OPEN and comes back from every query, so it corroborates heavily. #142 is CLOSED
# with a resolution label and is only ever found via `gh search issues` -- which, like the
# real API, omits stateReason from --json. That is what puts it in the UNKNOWN set and makes
# the close-reason lookup fire.
_stub_ok() {
  stub_gh <<STUB
printf '%s\n' "\$*" >> "\$LOGFILE"
case "\$1 \$2" in
  "auth status")  exit 0 ;;
  "repo view")    echo "acme/shop"; exit 0 ;;
  "issue view")   [[ "\$3" == "142" ]] && echo "NOT_PLANNED" || echo ""; exit 0 ;;
  "api graphql")  echo '{"142":"NOT_PLANNED"}'; exit 0 ;;
  "search issues") printf '%s\n%s\n' '$_OPEN' '$_CLOSED'; exit 0 ;;
esac
printf '%s\n' '$_OPEN'
exit 0
STUB
}

# Fails whichever subcommand matches $1 (a case pattern), succeeds otherwise.
_stub_failing() {
  local pattern="$1"
  stub_gh <<STUB
case "\$1 \$2" in
  "auth status")  exit 0 ;;
  "repo view")    echo "acme/shop"; exit 0 ;;
  "api graphql")  echo '{}'; exit 0 ;;
esac
if [[ "\$1 \$2" == $pattern ]]; then
  echo "gh: API rate limit exceeded for user ID 1234" >&2
  exit 1
fi
printf '%s\n' '$_OPEN'
exit 0
STUB
}

_find() {
  export LOGFILE="$TEST_TMP/gh.log"
  : > "$LOGFILE"
  run_cmd bash "$SCRIPTS/find-duplicates.sh" "$@"
}

test_output_is_byte_identical_to_the_golden_fixture() {
  _stub_ok
  # cmp on files, not $(...) on strings: command substitution strips trailing newlines from
  # both sides, which would let a trailing-whitespace regression through a test whose name
  # promises byte-identical. A CRLF defect once had exactly that shape.
  bash "$SCRIPTS/find-duplicates.sh" "$_TITLE" >"$TEST_TMP/actual.txt" 2>/dev/null
  local status=$?
  assert_eq 0 "$status" "advisory script must always exit 0"

  if ! cmp -s "$_GOLDEN" "$TEST_TMP/actual.txt"; then
    printf 'output differs from the golden fixture:
%s
'       "$(diff "$_GOLDEN" "$TEST_TMP/actual.txt" | sed 's/^/    /')" >&2
    return 1
  fi
}

test_close_reasons_resolve_in_one_batched_call_not_one_per_issue() {
  _stub_ok
  _find "$_TITLE"
  local views; views=$(grep -c '^issue view' "$LOGFILE" || true)
  assert_eq 0 "$views" "the per-issue gh issue view loop was quadratic in candidates"
}

# A gh that cannot authenticate is an environment problem, and the script says so instead
# of proceeding to report zero candidates -- which would be indistinguishable from a clean
# search. The Node original only asserted "status is not 2", which almost nothing violates.
test_an_unauthenticated_gh_fails_loudly_rather_than_reporting_nothing() {
  stub_gh <<'STUB'
exit 1
STUB
  _find "anything at all"
  assert_contains "$RUN_OUT" "gh is not authenticated"
  assert_not_contains "$RUN_OUT" "No candidates"     "an unusable gh must never look like a completed search"
}

test_failed_searches_are_reported_not_rendered_as_zero_candidates() {
  _stub_failing '*'
  _find "$_TITLE"
  assert_eq 0 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "INCOMPLETE"
  assert_not_contains "$RUN_OUT" "No candidates. File it" \
    "this is the output that reads as permission to proceed"
}

test_partial_failure_is_reported_alongside_what_it_did_find() {
  _stub_failing '"search issues"'
  _find "$_TITLE"
  assert_eq 0 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "#88" "the searches that succeeded still report"
  assert_contains "$RUN_OUT" "INCOMPLETE" \
    "partial failure is the dangerous case — output looks normal but under-reports"
  assert_contains "$RUN_OUT" "comments:" "name which coverage was lost"
}

test_a_clean_run_carries_no_failure_warning() {
  _stub_ok
  _find "$_TITLE"
  assert_not_contains "$RUN_OUT" "INCOMPLETE" \
    "false alarms train the reader to ignore the real ones"
}

# jq 1.7 rejects a bare `if` as an object value, so the classifier was a compile error on
# Debian stable, and `2>/dev/null || echo '[]'` turned that into "No candidates. File it".
# The gate green-lit every filing there. Pinning a jq version in the suite is not possible,
# so this drives the same path with a jq that cannot run at all.
test_a_broken_jq_is_reported_not_rendered_as_zero_candidates() {
  _stub_ok
  stub_bin jq <<'STUB'
exit 1
STUB
  _find "$_TITLE"
  assert_eq 0 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "INCOMPLETE" "a classifier that could not run is unknown, not empty"
  assert_not_contains "$RUN_OUT" "No candidates. File it"
}

# Every query matches 40 issues, so every one is discarded as too broad.
_stub_all_broad() {
  stub_gh <<STUB
case "\$1 \$2" in
  "auth status")  exit 0 ;;
  "repo view")    echo "acme/shop"; exit 0 ;;
  "api graphql")  echo '{}'; exit 0 ;;
esac
for i in \$(seq 1 40); do
  printf '{"number":%s,"title":"noise %s","state":"OPEN","stateReason":"","labels":[]}\n' "\$i" "\$i"
done
exit 0
STUB
}

test_a_term_matching_too_many_issues_is_discarded_and_said_so() {
  _stub_all_broad
  _find "coupon_code checkout"
  assert_contains "$RUN_OUT" "too broad to be distinctive"
  assert_contains "$RUN_OUT" "Results discarded, not truncated" \
    "silently truncating would read as coverage it does not have"
  # Zero rows because everything was thrown away is not a clean search.
  assert_not_contains "$RUN_OUT" "No candidates. File it"
  assert_contains "$RUN_OUT" "were discarded as too broad"
  assert_contains "$RUN_OUT" "before recording \`**Candidates:** none\`"
}

test_tsv_mode_reports_discarded_searches_on_stderr() {
  _stub_all_broad
  export LOGFILE="$TEST_TMP/gh.log"
  local out err
  out=$(bash "$SCRIPTS/find-duplicates.sh" --tsv "coupon_code checkout" 2>"$TEST_TMP/err")
  err=$(cat "$TEST_TMP/err")
  assert_eq "" "$out" "the TSV stream itself stays rows only"
  assert_contains "$err" "skipped: " "a skipped-only run must not look like a clean empty one"
  assert_contains "$err" "too broad to be distinctive"
}

# The golden title carries no identifier, so it only exercises the content-word fallback. Under
# `set -e` the first identifier grep that matches nothing used to end the derivation subshell,
# and a title that did carry identifiers fell through to content words (here: `blank`). A
# `[SEV-n]` prefix must not survive either, or the ALLCAPS rule reduces the title to `SEV`.
test_identifiers_in_the_title_are_preferred_over_content_words() {
  _stub_ok
  _find "CartService.applyCoupon throws TypeError on blank coupon_code"
  assert_eq 0 "$RUN_STATUS"
  local terms
  terms=$(printf '%s\n' "$RUN_OUT" | grep '^terms:' || true)
  assert_contains "$terms" "CartService.applyCoupon" "a Module.function identifier is a term"
  assert_contains "$terms" "TypeError" "a CamelCase identifier is a term"
  assert_contains "$terms" "coupon_code" "a snake_case identifier is a term"
  assert_not_contains "$terms" "blank" "a content word must not displace an identifier"

  _find "[SEV-2] Checkout fails with TypeError"
  terms=$(printf '%s\n' "$RUN_OUT" | grep '^terms:' || true)
  assert_contains "$terms" "TypeError"
  assert_not_contains "$terms" "SEV" "the severity prefix is stripped before deriving terms"
}
