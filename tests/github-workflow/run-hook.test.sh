#!/usr/bin/env bash
#
# Tests for hooks/run-hook.sh and hooks/hooks.json -- the wiring between Claude Code and the
# Node hook. The hook itself is tested by the node suite.

_payload() {
  printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"gh pr create --title t --body \"This does not close #12\""}}'
}

_need_node() { command -v node >/dev/null 2>&1 || { echo "skipped: node not on PATH"; return 1; }; }

test_without_node_the_hook_does_nothing() {
  mkdir -p "$TEST_TMP/empty"
  # $BASH is this bash's absolute path, so the script still runs with node off PATH.
  run_cmd env PATH="$TEST_TMP/empty" "$BASH" "$PLUGIN_ROOT/hooks/run-hook.sh" <<<"$(_payload)"
  assert_eq 0 "$RUN_STATUS" "a hook that errors on every Bash call is worse than a gate that is off"
  assert_eq "" "$RUN_OUT"
}

test_with_node_a_block_comes_through_with_its_exit_code() {
  _need_node || return 0
  run_cmd bash "$PLUGIN_ROOT/hooks/run-hook.sh" <<<"$(_payload)"
  assert_eq 2 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "BLOCKED"
}

test_a_plugin_installed_under_a_path_with_spaces_still_runs() {
  _need_node || return 0
  local dest="$TEST_TMP/Jane Doe/plugins/github-workflow"
  mkdir -p "$dest/hooks"
  cp "$PLUGIN_ROOT/hooks/run-hook.sh" "$PLUGIN_ROOT/hooks/check-issue-workflow.mjs" "$dest/hooks/"
  run_cmd bash "$dest/hooks/run-hook.sh" <<<"$(_payload)"
  assert_eq 2 "$RUN_STATUS"
}

test_hooks_json_wires_both_events_through_run_hook() {
  local f="$PLUGIN_ROOT/hooks/hooks.json"
  jq -e '.hooks.PreToolUse[0].matcher == "Bash"' "$f" >/dev/null
  jq -e '.hooks.PostToolUse[0].matcher == "Bash"' "$f" >/dev/null
  jq -e '[.hooks.PreToolUse[0].hooks[0].command, .hooks.PostToolUse[0].hooks[0].command]
         | all(. == "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh\"")' "$f" >/dev/null
}

test_hooks_json_wires_the_edit_tools_to_the_same_hook() {
  # The branch gate must see every file edit, a subagent's included: hooks are the one mechanism
  # that fires for every agent, whether or not it ever loads the skill.
  local f="$PLUGIN_ROOT/hooks/hooks.json"
  jq -e '.hooks.PreToolUse[1].matcher == "Edit|Write|MultiEdit|NotebookEdit"' "$f" >/dev/null
  jq -e '.hooks.PreToolUse[1].hooks[0].command == "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh\""' "$f" >/dev/null
  jq -e '.hooks.PreToolUse[1].hooks[0].timeout == 15' "$f" >/dev/null
}

test_with_node_an_ask_comes_through_on_stdout_with_exit_0() {
  _need_node || return 0
  command -v git >/dev/null 2>&1 || { echo "skipped: git not on PATH"; return 0; }
  local repo="$TEST_TMP/Jane Doe/repo" cwd payload
  mkdir -p "$repo/lib"
  git -C "$repo" init -q
  printf 'a\n' >"$repo/lib/a.txt"
  git -C "$repo" add -A
  git -C "$repo" -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -q -m seed --no-verify
  printf 'b\n' >"$repo/lib/a.txt"
  # Claude Code hands the hook a native path; on Windows that is not Git Bash's /tmp/... form.
  cwd="$repo"
  if command -v cygpath >/dev/null 2>&1; then cwd=$(cygpath -w "$repo"); fi
  payload=$(jq -cn --arg cwd "$cwd" \
    '{hook_event_name:"PreToolUse",tool_name:"Bash",cwd:$cwd,tool_input:{command:"git checkout -- lib"}}')
  run_cmd bash "$PLUGIN_ROOT/hooks/run-hook.sh" <<<"$payload"
  assert_eq 0 "$RUN_STATUS" "an ask is not a block"
  assert_contains "$RUN_OUT" '"permissionDecision":"ask"'
  assert_contains "$RUN_OUT" "lib/a.txt"
}

test_hooks_json_has_no_conditional_filter() {
  # An `if` filter such as Bash(gh pr create*) may not match `cd x && gh pr create`, which
  # would bypass the gate silently. The hook's own cheap substring test does that job.
  local n; n=$(jq '[.. | objects | select(has("if"))] | length' "$PLUGIN_ROOT/hooks/hooks.json")
  assert_eq 0 "$n"
}

# A `node` committed to the repository must never run: an empty or relative PATH entry names the
# working directory, and the launcher runs on every Bash and Edit call without the model choosing.
_plant_node() {
  mkdir -p "$TEST_TMP/repo" "$TEST_TMP/empty"
  printf '#!/bin/sh\necho PLANTED-NODE-RAN\n' >"$TEST_TMP/repo/node"
  chmod +x "$TEST_TMP/repo/node"
}

test_a_planted_node_behind_an_empty_path_entry_never_runs() {
  _plant_node
  run_cmd bash -c 'cd "$1" && PATH="$2:" "$3" "$4"' _ \
    "$TEST_TMP/repo" "$TEST_TMP/empty" "$BASH" "$PLUGIN_ROOT/hooks/run-hook.sh" <<<"$(_payload)"
  assert_not_contains "$RUN_OUT" "PLANTED-NODE-RAN"
  assert_eq 0 "$RUN_STATUS" "no absolute node: the hook does nothing"
}

test_a_relative_path_entry_is_skipped_for_the_real_node_after_it() {
  _need_node || return 0
  _plant_node
  local real; real=$(command -v node)
  run_cmd bash -c 'cd "$1" && PATH=".:$2" "$3" "$4"' _ \
    "$TEST_TMP/repo" "${real%/*}" "$BASH" "$PLUGIN_ROOT/hooks/run-hook.sh" <<<"$(_payload)"
  assert_not_contains "$RUN_OUT" "PLANTED-NODE-RAN"
  assert_eq 2 "$RUN_STATUS" "the real node runs the hook"
}

test_the_launcher_runs_when_invoked_through_a_windows_backslash_path() {
  _need_node || return 0
  command -v cygpath >/dev/null 2>&1 || { echo "skipped: cygpath not on PATH"; return 0; }
  local dest="$TEST_TMP/Jane Doe/plugins/github-workflow"
  mkdir -p "$dest/hooks"
  cp "$PLUGIN_ROOT/hooks/run-hook.sh" "$PLUGIN_ROOT/hooks/check-issue-workflow.mjs" "$dest/hooks/"
  local windows_path; windows_path=$(cygpath -w "$dest/hooks/run-hook.sh")
  local payload; payload="$(_payload)"
  # Run from a different directory to ensure the launcher correctly finds its sibling hook.
  run_cmd bash -c "cd '$TEST_TMP' && bash '$windows_path'" <<<"$payload"
  assert_eq 2 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "BLOCKED"
}
