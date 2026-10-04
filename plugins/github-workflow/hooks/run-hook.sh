#!/usr/bin/env bash
#
# run-hook.sh - run the github-workflow hook under Node, or do nothing when Node is absent.
#
# Claude Code's native installer does not bring Node with it, and a hook that errors on every
# Bash call is worse than a gate that is off. /github-workflow:doctor reports the gap.
#
# Node is found in ABSOLUTE PATH entries only, as the hook finds git and bash. An empty or
# relative entry (a trailing `:` is enough) names the working directory, and a `node` committed
# to the repository there would run on every tool call without anyone choosing to run it.

node=""
saved_ifs=$IFS
IFS=:
set -f
for dir in $PATH; do
  case $dir in
    /* | [A-Za-z]:[\\/]*) ;;
    *) continue ;;
  esac
  for name in node node.exe; do
    if [[ -f "$dir/$name" && -x "$dir/$name" ]]; then
      node="$dir/$name"
      break 2
    fi
  done
done
set +f
IFS=$saved_ifs
[[ -n "$node" ]] || exit 0

# Claude Code may pass a Windows path with backslashes; normalise before taking the directory.
bs='\'
src="${BASH_SOURCE[0]//"$bs"//}"
here="${src%/*}"
[[ "$here" == "$src" ]] && here="."

exec "$node" "$here/check-issue-workflow.mjs" "$@"
