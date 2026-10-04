# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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
