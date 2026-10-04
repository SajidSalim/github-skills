#!/usr/bin/env bash
#
# run-hook.sh - run the github-workflow hook under Node, or do nothing when Node is absent.
#
# Claude Code's native installer does not bring Node with it, and a hook that errors on every
# Bash call is worse than a gate that is off. /github-workflow:doctor reports the gap.

command -v node >/dev/null 2>&1 || exit 0

# Claude Code may pass a Windows path with backslashes; normalise before taking the directory.
bs='\'
src="${BASH_SOURCE[0]//"$bs"//}"
here="${src%/*}"
[[ "$here" == "$src" ]] && here="."

exec node "$here/check-issue-workflow.mjs" "$@"
