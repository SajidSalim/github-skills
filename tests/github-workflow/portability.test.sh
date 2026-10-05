#!/usr/bin/env bash
#
# Static checks on every shipped shell script. macOS still ships bash 3.2 as /bin/bash, and a
# Windows checkout can smuggle a carriage return into a script, which bash then reads as part
# of a command name. Neither shows up on the machine that wrote the script.

_shipped_scripts() {
  find "$PLUGIN_ROOT/skills" "$PLUGIN_ROOT/hooks" -type f -name '*.sh' 2>/dev/null | sort
}

test_shipped_scripts_avoid_bash_4_only_features() {
  local hits
  hits=$(_shipped_scripts | tr '\n' '\0' | xargs -0 grep -n -E \
    '(^|[^A-Za-z_])(mapfile|readarray)([^A-Za-z_]|$)|declare -A|local -A|\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^)' \
    2>/dev/null || true)
  [[ -z "$hits" ]] || { printf 'bash 4+ only (macOS /bin/bash is 3.2):\n%s\n' "$hits" >&2; return 1; }
}

_LAUNCHER="hooks/run-hook.sh"

# The scripts are bash; the hook launcher alone is POSIX sh, since hooks.json starts it as
# `/bin/sh <path>` and /bin/sh is not bash on Debian, Ubuntu or Alpine.
test_shipped_scripts_start_with_a_bash_shebang() {
  local f bad=""
  while IFS= read -r f; do
    [[ "$f" == "$PLUGIN_ROOT/$_LAUNCHER" ]] && continue
    [[ "$(head -n1 "$f")" == "#!/usr/bin/env bash" ]] || bad="$bad $f"
  done < <(_shipped_scripts)
  [[ -z "$bad" ]] || { printf 'missing #!/usr/bin/env bash:%s\n' "$bad" >&2; return 1; }
  assert_eq "#!/bin/sh" "$(head -n1 "$PLUGIN_ROOT/$_LAUNCHER")" "the launcher is POSIX sh"
}

# dash and busybox ash reject these, and macOS's bash-as-sh would hide it. Comments are skipped.
# shellcheck -s sh (in CI) and checkbashisms, when installed, check the same file more fully.
test_the_hook_launcher_has_no_bashisms() {
  local f="$PLUGIN_ROOT/$_LAUNCHER" hits
  hits=$(grep -n -v -E '^[[:space:]]*#' "$f" | grep -E \
    '\[\[|BASH_SOURCE|\$\{[A-Za-z_][A-Za-z0-9_]*(/|:[0-9-]|\^|,)|\$\{#?[A-Za-z_][A-Za-z0-9_]*\[|^[^#]*[A-Za-z_][A-Za-z0-9_]*=\(|<<<|\$'"'"'|(^|[[:space:];:])(local|declare|typeset|shopt|source|function|select|let|mapfile|readarray)([[:space:]]|$)|pipefail|==|&>|\$RANDOM|\$\(\(.*\*\*' \
    || true)
  [[ -z "$hits" ]] || { printf 'bashisms in the POSIX sh launcher:\n%s\n' "$hits" >&2; return 1; }
  if command -v checkbashisms >/dev/null 2>&1; then checkbashisms "$f"; fi
  if command -v shellcheck >/dev/null 2>&1; then shellcheck -s sh -S warning "$f"; fi
}

# Counted with tr, not grep: Git Bash drops a $'\r' written inside $(...), which turns
# `grep $'\r'` into an empty pattern that matches every file, and its grep strips CR before
# LF in text mode, so it would miss real CRLF files anyway.
test_shipped_scripts_have_no_carriage_returns() {
  local f bad=""
  while IFS= read -r f; do
    [[ $(tr -cd '\r' < "$f" | wc -c) -eq 0 ]] || bad="$bad $f"
  done < <(_shipped_scripts)
  [[ -z "$bad" ]] || { printf 'carriage returns (CRLF or a stray CR):%s\n' "$bad" >&2; return 1; }
}

# bash 3.2's read escapes \001 (CTLESC) and \177 (CTLNUL) internally and never splits on
# them, so `IFS=$'\001' read a b` leaves everything in a. Use \037 instead.
test_shipped_scripts_never_split_on_bytes_bash_3_2_escapes() {
  local hits
  hits=$(_shipped_scripts | tr '\n' '\0' | xargs -0 grep -n -F \
    -e "IFS=\$'\\001'" -e "IFS=\$'\\x01'" -e "IFS=\$'\\177'" -e "IFS=\$'\\x7f'" 2>/dev/null || true)
  [[ -z "$hits" ]] || { printf 'field separator bash 3.2 cannot split on:\n%s\n' "$hits" >&2; return 1; }
}
