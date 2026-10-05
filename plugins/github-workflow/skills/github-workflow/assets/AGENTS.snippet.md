## GitHub workflow

All GitHub work — issues, branches, commits, pull requests, labels, the project board — follows
the github-workflow protocol
(https://github.com/SajidSalim/github-skills/tree/main/plugins/github-workflow/skills/github-workflow).
Read `.github/GITHUB_WORKFLOW.md`, if present (this repository's decisions), before creating an
issue, picking one up, opening a PR or closing anything. The short version:

- **Never create an issue without asking the person running you.** Search first, all states —
  `bash .github/scripts/find-duplicates.sh "<title>"` if the scripts are installed — and show what
  you found. A hit closed with a `resolution:` label is a decision: ask, never refile.
- **Never edit, commit to or merge into the default branch** unless the person running you says so,
  for that change. One branch per unit of work, a PR, report the number, stop. A human merges.
  Never switch the branch of a checkout you did not create: if it has changes you did not make,
  ask, or work in a `git worktree`.
- **Never run a command that discards uncommitted changes** — `git checkout -- <path>`,
  `git restore`, `git reset --hard`, `git clean -f`, `git stash drop` — they may not be yours. To
  undo your own edit, save `git diff -- <paths> > <file>` first, and ask.
- **Before claiming an issue, read its comments.** The assignee field is not the check — agents
  often share one login.
- **Labels:** exactly one `type:`, one `priority:` (or `status:needs-triage`), one `severity:` on
  bugs and security issues, at least one `area:`. Never invent a label; never use GitHub's stock ones.
- **One closing keyword per issue in the PR body — and never one next to a negation, a quote or
  code:** "does not close #NNN" closes #NNN.
- **Every issue closes with a written explanation reachable from it.**
