#!/usr/bin/env bash
#
# Tests for lint-issue-labels.sh.
#
# `gh` is stubbed on PATH rather than mocked at the HTTP layer: that is the seam the script
# actually uses, and it keeps the suite offline and deterministic. Real jq does the work, so
# these tests exercise the actual rule set rather than a paraphrase of it.

# Stub `gh` to return one item with the given labels. $1 title, $2 state, $3 stateReason,
# then any number of label names.
_stub_item() {
  local title="$1" state="$2" reason="$3"; shift 3
  local labels_json="[]"
  if [[ $# -gt 0 ]]; then
    labels_json=$(printf '%s\n' "$@" | jq -R '{name: .}' | jq -s -c .)
  fi
  local json
  json=$(jq -n -c --arg t "$title" --arg s "$state" --arg r "$reason" --argjson l "$labels_json" \
    '{number: 42, title: $t, state: $s, stateReason: $r, labels: $l}')

  stub_gh <<STUB
case "\$1 \$2" in
  "auth status") exit 0 ;;
  "repo view")   echo "owner/repo"; exit 0 ;;
  "issue view")  echo '$json'; exit 0 ;;
  "pr view")     echo '$json'; exit 0 ;;
esac
echo "unexpected gh call: \$*" >&2
exit 1
STUB
}

_lint() { run_cmd bash "$SCRIPTS/lint-issue-labels.sh" "$@"; }

# ---------------------------------------------------------------- issue mode

test_a_fully_labelled_issue_passes() {
  _stub_item "A normal bug" OPEN "" type:bug priority:p2 severity:sev-3 area:ci
  _lint 42
  assert_eq 0 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "ok"
  assert_contains "$RUN_OUT" "1 issue(s) checked · 1 clean"
  assert_not_contains "$RUN_OUT" "FAIL" "the hook blocks on a FAIL line, so a clean item must print none"
}

# The plugin's hook tells a violation from an environment failure by this exact token: a line
# starting `FAIL` (check-issue-workflow.mjs, postToolUse). Reword it and the taxonomy gate
# passes every violation silently.
test_a_missing_type_is_a_violation() {
  _stub_item "No type" OPEN "" priority:p2 area:ci
  _lint 42
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "no type: label"
  assert_contains "$RUN_OUT" "  FAIL  #42" "the FAIL line is the hook's discriminator"
}

# The skill moves status: by swapping, because this rule rejects a stacked pair.
test_two_status_labels_are_a_violation() {
  _stub_item "Stacked" OPEN "" type:chore priority:p2 area:ci status:in-progress status:needs-review
  _lint 42
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "multiple status: labels"
}

test_two_type_labels_are_a_violation() {
  _stub_item "Two types" OPEN "" type:bug type:chore priority:p2 area:ci
  _lint 42
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "multiple type: labels"
}

test_a_missing_area_is_a_violation() {
  _stub_item "No area" OPEN "" type:chore priority:p2
  _lint 42
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "no area: label"
}

test_needs_triage_stands_in_for_a_priority() {
  _stub_item "Untriaged" OPEN "" type:chore area:ci status:needs-triage
  _lint 42
  assert_eq 0 "$RUN_STATUS" "needs-triage is the documented alternative to guessing a priority"
}

test_carrying_both_a_priority_and_needs_triage_is_a_violation() {
  _stub_item "Both" OPEN "" type:chore area:ci priority:p2 status:needs-triage
  _lint 42
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "both a priority: label and status:needs-triage"
}

test_a_bug_without_a_severity_is_a_violation() {
  _stub_item "Bug with no severity" OPEN "" type:bug priority:p2 area:ci
  _lint 42
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "no severity: label on type:bug"
}

test_a_chore_needs_no_severity() {
  _stub_item "Chore" OPEN "" type:chore priority:p2 area:ci
  _lint 42
  assert_eq 0 "$RUN_STATUS" "severity applies to bugs and security findings only"
}

test_a_sev_1_label_requires_the_title_prefix() {
  _stub_item "Data loss on close" OPEN "" type:bug severity:sev-1 priority:p0 area:db
  _lint 42
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "without the [SEV-1] title prefix"
}

test_a_sev_1_prefix_requires_the_label() {
  _stub_item "[SEV-1] Data loss on close" OPEN "" type:bug severity:sev-3 priority:p0 area:db
  _lint 42
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "[SEV-1] title prefix without"
}

test_matching_prefix_and_label_pass() {
  _stub_item "[SEV-1] Data loss on close" OPEN "" type:bug severity:sev-1 priority:p0 area:db
  _lint 42
  assert_eq 0 "$RUN_STATUS"
}

test_github_stock_labels_are_rejected() {
  _stub_item "Shadowed" OPEN "" type:bug severity:sev-3 priority:p2 area:ci bug
  _lint 42
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "stock label"
}

test_closed_as_not_planned_needs_a_resolution() {
  _stub_item "Abandoned" CLOSED NOT_PLANNED type:chore priority:p3 area:ci
  _lint 42
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "with no resolution: label"
}

test_closed_as_completed_needs_no_resolution() {
  _stub_item "Done" CLOSED COMPLETED type:chore priority:p3 area:ci
  _lint 42
  assert_eq 0 "$RUN_STATUS"
}

# ---------------------------------------------------------------- pr mode

test_a_pr_needs_no_priority_or_severity() {
  _stub_item "fix(ci): something" OPEN "" type:bug area:ci
  _lint --pr 42
  assert_eq 0 "$RUN_STATUS" \
    "priority and severity describe the problem, so they live on the issue"
  assert_not_contains "$RUN_OUT" "no priority:"
  assert_not_contains "$RUN_OUT" "no severity:"
}

test_a_pr_still_needs_a_type() {
  _stub_item "fix(ci): something" OPEN "" area:ci
  _lint --pr 42
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "no type: label"
}

test_a_pr_still_needs_an_area() {
  _stub_item "fix(ci): something" OPEN "" type:bug
  _lint --pr 42
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "no area: label"
}

test_pr_mode_reports_in_pr_nouns() {
  _stub_item "fix(ci): something" OPEN "" area:ci
  _lint --pr 42
  assert_contains "$RUN_OUT" "PR(s) checked"
  assert_contains "$RUN_OUT" "gh pr edit" \
    "gh issue edit rejects a PR number, so the remedy has to match the mode"
}

test_pr_mode_reads_through_gh_pr_view() {
  stub_gh <<'STUB'
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo view")   echo "owner/repo"; exit 0 ;;
  "issue view")  echo "ISSUE VIEW MUST NOT BE USED FOR A PR" >&2; exit 1 ;;
  "pr view")     echo '{"number":42,"title":"t","state":"OPEN","labels":[{"name":"type:chore"},{"name":"area:ci"}]}'; exit 0 ;;
esac
exit 1
STUB
  _lint --pr 42
  assert_eq 0 "$RUN_STATUS"
}

test_pr_all_is_rejected_rather_than_silently_wrong() {
  _stub_item "x" OPEN "" type:chore area:ci
  _lint --pr --all
  assert_eq 2 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "gh issue list excludes pull requests"
}

test_no_arguments_prints_usage() {
  _stub_item "x" OPEN "" type:chore area:ci
  _lint
  assert_eq 2 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "usage:"
}

# ---------------------------------------------------------------- --all and --limit

# Stub `gh issue list` to return $1 clean issues, whatever --limit asked for.
_stub_list() {
  local n="$1" json
  json=$(jq -n -c --argjson n "$n" \
    '[range(1; $n + 1) | {number: ., title: "t", state: "OPEN", stateReason: "",
       labels: [{name: "type:chore"}, {name: "priority:p2"}, {name: "area:ci"}]}]')
  stub_gh <<STUB
case "\$1 \$2" in
  "auth status") exit 0 ;;
  "repo view")   echo "owner/repo"; exit 0 ;;
  "issue list")  echo '$json'; exit 0 ;;
esac
echo "unexpected gh call: \$*" >&2
exit 1
STUB
}

# A full page means the sweep may have stopped short. A clean summary must not read as a
# complete audit of the backlog.
test_all_says_when_it_stopped_at_the_limit() {
  _stub_list 3
  _lint --all --limit 3
  assert_eq 0 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "3 issue(s) checked"
  assert_contains "$RUN_OUT" "stopped at --limit 3, there may be more"
}

test_all_under_the_limit_claims_nothing_extra() {
  _stub_list 2
  _lint --all --limit 3
  assert_eq 0 "$RUN_STATUS"
  assert_not_contains "$RUN_OUT" "stopped at --limit"
}
