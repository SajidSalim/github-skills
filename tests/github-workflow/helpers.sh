#!/usr/bin/env bash
#
# Assertions and stubs for the github-workflow bash test suite.
#
# No third-party framework, deliberately. The scripts under test need bash, gh and jq and
# nothing else; a harness needing more would mean an agent that can run them cannot verify
# them.
#
# Every test runs in its own subshell under `set -e` (see run-tests.sh), so an assertion
# only has to write a diagnostic and return non-zero -- that aborts its own test and no
# other. Nothing here needs to track state.
#
# Available inside a test:
#   TEST_TMP     a fresh directory, removed afterwards
#   PLUGIN_ROOT  absolute path to plugins/github-workflow
#   REPO_ROOT    absolute path to the marketplace repository
#   SCRIPTS      absolute path to the skill's scripts/ directory

assert_eq() {
  local expected="$1" actual="$2" msg="${3:-}"
  if [[ "$expected" != "$actual" ]]; then
    printf 'assert_eq failed%s\n  expected: %q\n  actual:   %q\n' \
      "${msg:+ — $msg}" "$expected" "$actual" >&2
    return 1
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'assert_contains failed%s\n  looking for: %s\n  in:\n%s\n' \
      "${msg:+ — $msg}" "$needle" "$(sed 's/^/    | /' <<<"$haystack")" >&2
    return 1
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf 'assert_not_contains failed%s\n  must not contain: %s\n  in:\n%s\n' \
      "${msg:+ — $msg}" "$needle" "$(sed 's/^/    | /' <<<"$haystack")" >&2
    return 1
  fi
}

assert_status() {
  local expected="$1"; shift
  run_cmd "$@"
  if [[ "$RUN_STATUS" != "$expected" ]]; then
    printf 'assert_status failed — expected %s, got %s\n  command: %s\n  output:\n%s\n' \
      "$expected" "$RUN_STATUS" "$*" "$(sed 's/^/    | /' <<<"$RUN_OUT")" >&2
    return 1
  fi
}

# Run a command without tripping `set -e`, leaving its status in RUN_STATUS and its
# combined output in RUN_OUT. Assertions about failure need the failure to survive.
run_cmd() {
  set +e
  RUN_OUT=$("$@" 2>&1)
  RUN_STATUS=$?
  set -e
  return 0
}

# Put an executable named $1 on PATH for this test, with its body read from stdin.
# The shebang is supplied, so callers pass only the script.
stub_bin() {
  local name="$1"
  mkdir -p "$TEST_TMP/bin"
  { echo '#!/usr/bin/env bash'; cat; } >"$TEST_TMP/bin/$name"
  chmod +x "$TEST_TMP/bin/$name"
  case ":$PATH:" in
    *":$TEST_TMP/bin:"*) ;;
    *) PATH="$TEST_TMP/bin:$PATH" ;;
  esac
  export PATH
}

# Convenience for the common case. `gh` is stubbed rather than mocked at the HTTP layer
# because that is the seam the scripts actually use, and it keeps the suite offline.
stub_gh() { stub_bin gh; }

# Write a file, creating parent directories. Saves three lines in every fixture.
write_file() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  cat >"$path"
}
