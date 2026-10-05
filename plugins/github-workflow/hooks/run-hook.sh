#!/bin/sh
#
# run-hook.sh - run the github-workflow hook under Node, or do nothing when Node is absent.
#
# hooks/hooks.json starts this file as `/bin/sh <path>`. The interpreter is an absolute path, so
# the host looks nothing up on PATH, in the session's directory, before this code runs. Keep the
# file POSIX sh: /bin/sh is dash on Debian and Ubuntu, busybox ash on Alpine, bash in sh mode on
# macOS, and Git Bash's own sh.exe on Windows. No [[ ]], arrays, ${var//...} or BASH_SOURCE.
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
  # The shell's PATH is POSIX-form, Git Bash's included (/c/Program Files/nodejs).
  case $dir in
    /*) ;;
    *) continue ;;
  esac
  for name in node node.exe; do
    if [ -f "$dir/$name" ] && [ -x "$dir/$name" ]; then
      node="$dir/$name"
      break 2
    fi
  done
done
set +f
IFS=$saved_ifs
[ -n "$node" ] || exit 0

# `sh <path>` sets $0 to the path. Claude Code may pass a Windows path with backslashes:
# normalise them to slashes, without a subprocess, before taking the directory.
src=$0
case $src in
  *\\*)
    rest=$src
    src=""
    while :; do
      case $rest in
        *\\*)
          src="$src${rest%%\\*}/"
          rest=${rest#*\\}
          ;;
        *)
          src="$src$rest"
          break
          ;;
      esac
    done
    ;;
esac
here=${src%/*}
if [ "$here" = "$src" ]; then here=.; fi

exec "$node" "$here/check-issue-workflow.mjs" "$@"
