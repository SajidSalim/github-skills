#!/usr/bin/env bash
#
# check-doc-links.sh — assert every relative markdown link in the given files and directories
# resolves. Skips absolute URLs, mailto:, pure #anchors, and *.template.md / *.snippet.md, which
# are installed into a user's repository and only resolve there.
#
#   bash check-doc-links.sh <file-or-dir>...

set -euo pipefail

[[ $# -gt 0 ]] || { echo "usage: bash check-doc-links.sh <file-or-dir>..." >&2; exit 2; }

files=()
for target in "$@"; do
  if [[ -d "$target" ]]; then
    while IFS= read -r f; do files+=("$f"); done < <(find "$target" -type f -name '*.md' | sort)
  elif [[ -f "$target" ]]; then
    files+=("$target")
  fi
done

bad=0
checked=0

for f in ${files[@]+"${files[@]}"}; do
  case "$f" in *.template.md|*.snippet.md) continue ;; esac
  dir=$(dirname "$f")
  while IFS= read -r link; do
    [[ -z "$link" ]] && continue
    case "$link" in
      http://*|https://*|mailto:*|'#'*) continue ;;
    esac
    target="${link%%#*}"
    [[ -z "$target" ]] && continue
    checked=$((checked + 1))
    if [[ ! -e "$dir/$target" ]]; then
      printf '  DEAD  %s → %s\n' "$f" "$link" >&2
      bad=$((bad + 1))
    fi
  done < <(grep -oE '\]\([^)]+\)' "$f" | sed 's/^](//; s/)$//' || true)
done

printf '\n  %s relative link(s) checked · %s dead\n\n' "$checked" "$bad"
[[ "$bad" -eq 0 ]] || { printf '  Fix the paths above; a dead pointer sends the agent back to guessing.\n\n'; exit 1; }
exit 0
