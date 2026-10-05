# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-10-05

Hook edge cases (#23, #24, #25), the directory-listing icon (#28), and a record of the follow-ups
to the first 1.0.0 commit (#22, #26). The `github-workflow--v1.0.0` tag includes #22 and #26, but
the 1.0.0 section below did not list them, and installs taken from `main` under the version string
`1.0.0` before they merged lack them. Claude Code updates a plugin by its version string, so 1.0.1
is the first version that guarantees them.

### Fixed

- The default-branch gate in a reftable repository, which has no ref files to read (#23): a branch
  switch earlier in the same command (`git checkout main && git commit`) is followed, asking git
  whether the branch exists (`show-ref --verify`); and a default branch other than `main` or
  `master` is read from `origin/HEAD` through git, so a commit, push, edit or switch on it asks.
- `GH_REPO` set earlier in the same command is followed: `export GH_REPO=…`, `declare -x`, a bare
  `GH_REPO=…` and `unset GH_REPO`, scoped as `cd` is. A value the shell expands leaves the
  repository unknown, and the command is treated as guest unless `--repo` or an edit URL names it.
  After `unset GH_REPO`, the label linter no longer inherits the hook's own `GH_REPO` (#25).
- Hook follow-ups (#26): the deploy gate diffs the branch `--head` names; an edit by URL,
  `GH_REPO` as a prefix and a preceding `cd` decide which repository's gates apply; the
  closing gate catches `Closes: #N` and `owner/repo#N`, no longer lets a negation in an earlier
  sentence block a real closer, and checks an inline `--body` holding `$VAR` or a backtick; gh is
  found inside `$( )`, backticks, subshells and wrappers, and every gh create or edit in a
  command is judged; `run-hook.sh` takes `node` from absolute `PATH` entries only; a commit, push
  or edit on the current branch of a reftable repository asks when it is the default; the git
  probes share a deadline inside the hook timeout and run with `core.fsmonitor` off; an
  unexpected error exits 0.
- Script, skill-doc and setup follow-ups (#22): `lint-issue-labels.sh --all` no longer stops at
  500 issues; `bootstrap-labels.sh` applies a found config only to the repository it describes;
  the skill's examples use the real default branch, quote `<skill-dir>` paths, ask before
  self-assigning in guest mode and warn before destructive commands; setup finds existing PR
  templates and issue forms at every path GitHub reads and checks private vulnerability
  reporting before adding a security link.

### Added

- The self-check, and so `/github-workflow:doctor`, has a `PATH` row that warns about an empty or
  relative entry: Claude Code looks up `bash` for the hook there before any plugin code runs. The
  README gains a Security section (#24).
- A 1024px icon, `.claude-plugin/icon.png`, for the plugin directory listing; the docs test no
  longer `eval`s the pipeline it reads from the setup skill, which the directory validator flagged
  (#28).
- `docs/publishing.md` runs setup and doctor live before a release (#22).

### Changed

- The marketplace README is a full landing page (#27), and compares the plugin with the Claude
  GitHub App (#29).

## [1.0.0] - 2026-10-04

Initial release, extracted from the GitHub workflow of a production repository and generalized.

### Added

- `github-workflow` skill: the ten-rule issue-to-PR protocol — duplicate search before filing,
  claiming through the comment thread, branch + PR without merging, the label taxonomy, comment
  templates, relationships and Projects boards — with adopted and guest modes.
- Rule 2 covers edits on the default branch as well as commits and merges, and forbids switching
  the branch of a checkout the agent did not create; rule 10 forbids discarding uncommitted
  changes that may not be the agent's. The AGENTS.md snippet carries both.
- `/github-workflow:setup` to adopt the protocol in a repository and `/github-workflow:doctor`
  to verify it.
- Hooks: an accidental-closing-keyword gate on PRs in every repository, and — in repositories
  with `.github/github-workflow.json` — a duplicate-search record gate, a label-taxonomy lint
  and an optional deploy-impact gate.
- Two hook gates that ask the operator to confirm rather than block, so they also hold a coding
  subagent that never loads the skill: a default-branch gate (adopted repositories) before an
  `Edit`, `Write`, `MultiEdit` or `NotebookEdit` of a file whose checkout is on its default branch,
  and before a commit, merge, cherry-pick, revert, `am` or push that lands there; and a discard gate
  (every repository) before `git checkout -- <path>`, `restore`, `reset --hard`, `clean -f`,
  `switch --discard-changes`, `stash drop`/`clear` or `worktree remove -f` would destroy
  uncommitted work. Switches: the plugin option `discard_gate`, and `gates.defaultBranch` and
  `gates.discardChanges` in the repo config. The self-check reports both.
- Scripts: `find-duplicates.sh`, `lint-issue-labels.sh`, `bootstrap-labels.sh` (bash 3.2+).
- Templates: issue forms, PR template, repo overlay template, example config, AGENTS.md snippet.
- Test suites (bash and `node:test`) and an eval suite.

### Changed from the original workflow

- The closing-keyword gate checks pull requests only — an issue body cannot close anything.
- Repo-specific gates are opt-in per repository instead of always on.
- Areas and board mode come from the repo config (`--areas`, `--board`) instead of a
  project-specific flag and a deliberately divergent copy of the bootstrap script.
- The deploy-impact gate's paths are configured globs instead of hard-coded paths.
- Commit attribution defers to each repository's convention; the attribution guard was dropped.
- The installed-copy drift checker was dropped: the plugin is the single source.
