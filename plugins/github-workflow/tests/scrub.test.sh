#!/usr/bin/env bash
#
# The plugin was extracted from a private repository. Nothing identifying it may ship. This
# file checks the shapes that are safe to write down: its board-ID and requirement-ID formats,
# its tooling, and the numbers of the issues whose lessons the docs retell. The words that would
# name it -- its owner, its name, its board, its domain terms -- would ship by being listed here,
# so tests/hooks/privacy.test.mjs checks those by hash instead. Patterns are word-bounded so
# `bash` is not `Ash` and `#2081` is not `#208`. This file is excluded from its own scan.
#
# The owner-login and email checks run file by file and judge the matched TEXT only. A path
# is never an exemption: a clone at .../github.com/SajidSalim/github-skills/... must not make
# a stray login or address look allowed.

_SCRUB='\bPVT_[A-Za-z0-9_]+|\bFR-[A-Z]{3}-[0-9]+\b|\bBRD\b|\bmix (precommit|assets\.build|ash\.codegen|scripts\.test|hooks\.test)\b|#(399|276|272|213|209|211|217|218|219|220|233|235|242|245|221|238|293|318|339|447|463|208)\b'

_targets() {
  find "$PLUGIN_ROOT" -type f ! -path '*/tests/scrub.test.sh' ! -path '*/evals/results/*' | sort
  local f
  for f in "$REPO_ROOT/README.md" "$REPO_ROOT/.claude-plugin/marketplace.json"; do
    [[ -f "$f" ]] && echo "$f"
  done
}

test_no_identifier_from_the_source_repository_ships() {
  local hits
  hits=$(_targets | tr '\n' '\0' | xargs -0 grep -n -H -i -E "$_SCRUB" 2>/dev/null || true)
  [[ -z "$hits" ]] || { printf 'private identifiers found:\n%s\n' "$hits" >&2; return 1; }
}

# The login may appear only in plugin.json (author), marketplace.json (owner), LICENSE, and
# inside github.com/SajidSalim or SajidSalim/github-skills. Each allowed occurrence is cut out
# of the line's text; a line that still holds the login afterwards has a stray one.
test_the_owner_login_appears_only_as_authorship() {
  local hits="" f base line text
  while IFS= read -r f; do
    base=$(basename "$f")
    [[ "$base" == LICENSE ]] && continue
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      text="${line#*:}"
      text=$(printf '%s\n' "$text" | sed -e 's#github\.com/SajidSalim##g' -e 's#SajidSalim/github-skills##g')
      case "$base" in
        plugin.json|marketplace.json)
          text=$(printf '%s\n' "$text" | sed -E 's/"name": *"SajidSalim"//g') ;;
      esac
      if printf '%s\n' "$text" | grep -q 'SajidSalim'; then
        hits="${hits}${f}:${line}"$'\n'
      fi
    done < <(grep -n 'SajidSalim' "$f" 2>/dev/null || true)
  done < <(_targets)
  [[ -z "$hits" ]] || { printf 'unexpected owner login:\n%s' "$hits" >&2; return 1; }
}

# Each matched address is judged on its own, so an allowed address on a line never excuses
# another address beside it.
test_no_email_address_ships() {
  local hits="" f line addr
  while IFS= read -r f; do
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      addr="${line#*:}"
      case "$addr" in
        someone@example.com|t@example.com|noreply@anthropic.com) ;;
        *) hits="${hits}${f}:${line}"$'\n' ;;
      esac
    done < <(grep -n -o -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$f" 2>/dev/null || true)
  done < <(_targets)
  [[ -z "$hits" ]] || { printf 'email addresses found:\n%s' "$hits" >&2; return 1; }
}
