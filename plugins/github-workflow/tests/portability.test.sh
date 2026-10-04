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

test_shipped_scripts_start_with_a_bash_shebang() {
  local f bad=""
  while IFS= read -r f; do
    [[ "$(head -n1 "$f")" == "#!/usr/bin/env bash" ]] || bad="$bad $f"
  done < <(_shipped_scripts)
  [[ -z "$bad" ]] || { printf 'missing #!/usr/bin/env bash:%s\n' "$bad" >&2; return 1; }
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
