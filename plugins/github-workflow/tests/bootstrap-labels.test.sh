#!/usr/bin/env bash
#
# Tests for bootstrap-labels.sh. --dry-run needs no gh at all, so the taxonomy is asserted
# offline; the one real-path test stubs `gh label create` and inspects what it was asked.
# Every test starts by leaving the plugin's own checkout, so a config there can never leak in.

_dry() { run_cmd bash "$SCRIPTS/bootstrap-labels.sh" --dry-run "$@"; }

# A git repo whose .github/github-workflow.json holds $1 verbatim; leaves the shell inside it.
_adopted_repo() {
  local root="$TEST_TMP/repo"
  mkdir -p "$root/.github"
  git -C "$root" init -q
  printf '%s' "$1" >"$root/.github/github-workflow.json"
  cd "$root"
}

test_dry_run_needs_no_gh_at_all() {
  cd "$TEST_TMP"
  stub_bin gh <<'STUB'
echo "gh must not be called during a dry run" >&2
exit 1
STUB
  _dry
  assert_eq 0 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "nothing will change"
}

test_dry_run_covers_every_taxonomy_dimension() {
  cd "$TEST_TMP"
  _dry
  for l in type:feature type:bug type:security type:spike severity:sev-1 severity:sev-4 \
           priority:p0 priority:p3 resolution:duplicate resolution:works-as-intended; do
    assert_contains "$RUN_OUT" "$l"
  done
}

test_generic_areas_are_the_default() {
  cd "$TEST_TMP"
  _dry
  for a in api ui db auth infra integrations docs ci; do
    assert_contains "$RUN_OUT" "area:$a"
  done
}

test_the_areas_flag_replaces_the_default_set() {
  cd "$TEST_TMP"
  _dry --areas checkout,payments
  assert_contains "$RUN_OUT" "area:checkout"
  assert_contains "$RUN_OUT" "area:payments"
  assert_not_contains "$RUN_OUT" "area:api" "--areas is the whole set, not an addition"
}

test_config_areas_are_read() {
  _adopted_repo '{"version":1,"areas":["checkout","search"]}'
  _dry
  assert_eq 0 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "area:checkout"
  assert_contains "$RUN_OUT" "area:search"
  assert_not_contains "$RUN_OUT" "area:infra"
}

test_the_areas_flag_beats_the_config() {
  _adopted_repo '{"version":1,"areas":["checkout"]}'
  _dry --areas billing
  assert_contains "$RUN_OUT" "area:billing"
  assert_not_contains "$RUN_OUT" "area:checkout"
}

test_an_explicit_config_path_is_used() {
  cd "$TEST_TMP"
  printf '{"version":1,"areas":["mobile"]}' >"$TEST_TMP/cfg.json"
  _dry --config "$TEST_TMP/cfg.json"
  assert_contains "$RUN_OUT" "area:mobile"
}

test_labels_only_mode_creates_all_five_status_labels() {
  cd "$TEST_TMP"
  _dry
  for s in needs-triage needs-info blocked in-progress needs-review; do
    assert_contains "$RUN_OUT" "status:$s"
  done
}

test_the_board_flag_skips_the_two_in_flight_labels() {
  cd "$TEST_TMP"
  _dry --board
  assert_not_contains "$RUN_OUT" "status:in-progress" "a board's Status field owns in-flight state"
  assert_not_contains "$RUN_OUT" "status:needs-review"
  for s in needs-triage needs-info blocked; do
    assert_contains "$RUN_OUT" "status:$s" "a board cannot express these three"
  done
}

test_a_board_config_implies_board_mode() {
  _adopted_repo '{"version":1,"inFlightState":"board"}'
  _dry
  assert_not_contains "$RUN_OUT" "status:in-progress"
  assert_contains "$RUN_OUT" "status:blocked"
}

test_a_config_saved_on_windows_is_read() {
  local root="$TEST_TMP/repo"
  mkdir -p "$root/.github"
  git -C "$root" init -q
  printf '\xef\xbb\xbf{"version":1,\r\n"areas":["checkout"]}\r\n' >"$root/.github/github-workflow.json"
  cd "$root"
  _dry
  assert_eq 0 "$RUN_STATUS" "a BOM and CRLF are how Windows editors save JSON"
  assert_contains "$RUN_OUT" "area:checkout "
  assert_not_contains "$RUN_OUT" $'\r'
}

test_an_invalid_area_name_is_rejected() {
  cd "$TEST_TMP"
  _dry --areas "Check Out"
  assert_eq 2 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "invalid area name"
}

test_a_malformed_config_is_rejected_naming_the_file() {
  _adopted_repo '{not json'
  _dry
  assert_eq 2 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "github-workflow.json"
}

test_a_config_with_the_wrong_version_or_areas_type_is_rejected_naming_the_file() {
  _adopted_repo '{"version":1,"areas":"checkout"}'
  _dry
  assert_eq 2 "$RUN_STATUS" "a string where the areas array belongs is a malformed config"
  assert_contains "$RUN_OUT" "github-workflow.json"
  _adopted_repo '{"version":2,"areas":["checkout"]}'
  _dry
  assert_eq 2 "$RUN_STATUS" "a version this script does not know is not safe to read"
  assert_contains "$RUN_OUT" "github-workflow.json"
}

test_labels_are_written_with_force_so_reruns_update() {
  cd "$TEST_TMP"
  stub_bin gh <<'STUB'
case "$1 $2" in
  "auth status") exit 0 ;;
  "label list")  echo ""; exit 0 ;;
esac
printf '%s\n' "$*" >> "$TEST_TMP/calls.txt"
exit 0
STUB
  run_cmd bash "$SCRIPTS/bootstrap-labels.sh" --repo owner/repo
  assert_eq 0 "$RUN_STATUS"
  local calls; calls=$(cat "$TEST_TMP/calls.txt")
  assert_contains "$calls" "label create"
  assert_contains "$calls" "--force" \
    "without --force a re-run errors on every existing label instead of updating it"
  assert_contains "$calls" "--repo owner/repo"
}

test_a_flag_missing_its_value_is_a_usage_error() {
  cd "$TEST_TMP"
  _dry --repo
  assert_eq 2 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "--repo needs"
}

test_an_unknown_option_is_rejected() {
  cd "$TEST_TMP"
  run_cmd bash "$SCRIPTS/bootstrap-labels.sh" --nonsense
  assert_eq 2 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "unknown option"
}
