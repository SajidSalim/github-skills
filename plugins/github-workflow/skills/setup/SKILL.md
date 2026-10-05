---
name: setup
description: Adopt the github-workflow protocol in the current repository — label taxonomy, issue forms, PR template and .github/github-workflow.json. Run only when the user asks to set up, adopt or configure the GitHub workflow.
disable-model-invocation: true
argument-hint: "[--dry-run]"
---

# Set up the github-workflow protocol in this repository

Arguments: `$ARGUMENTS` — `--dry-run` stops after the plan (step 4).

Every step that changes GitHub or the working tree is **shown first, and done only after the
operator says yes**. Nothing is committed: the result goes on a branch and a PR, per rule 2 of the
`github-workflow` skill.

Plugin files used below:

- Scripts: `${CLAUDE_PLUGIN_ROOT}/skills/github-workflow/scripts/`
- Templates: `${CLAUDE_PLUGIN_ROOT}/skills/github-workflow/assets/`

## 1. Preflight

```bash
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef,viewerPermission,hasDiscussionsEnabled,visibility \
  -q '"\(.nameWithOwner) default=\(.defaultBranchRef.name) permission=\(.viewerPermission) discussions=\(.hasDiscussionsEnabled) visibility=\(.visibility)"'
gh api "repos/{owner}/{repo}/private-vulnerability-reporting" -q .enabled   # PUBLIC repositories only
git rev-parse --show-toplevel
```

**Every path below is relative to that repository root**, even when the session started in a
subdirectory: the hook reads the config only from `<root>/.github/`. Write files there and run git
from there (`cd "$(git rev-parse --show-toplevel)"`).

- Not a GitHub repository, or `gh` not authenticated → stop and say so.
- `permission` below `WRITE` (`READ`, `TRIAGE`) → warn that creating labels will probably fail, and
  ask whether to continue preparing the files for a maintainer to commit.
- Private vulnerability reporting `false`, or `visibility` not `PUBLIC` (the feature is public-only,
  and the call answers 404) → the "Security vulnerability" contact link would dead-end, and it
  tells reporters not to open a public issue. Plan (step 4) to point it at
  `https://github.com/<owner/name>/security/policy` when the repository has a `SECURITY.md` (at the
  root, in `docs/` or in `.github/`), and to drop it otherwise. A public repository whose call
  fails → unknown: report the error and ask which applies.
- `.github/github-workflow.json` already exists → this is a **re-run**: show the current file and
  treat every step as an update. Labels are idempotent; files get a diff, never a blind overwrite.

## 2. Board

```bash
read -r OWNER NAME <<<"$(gh repo view --json owner,name -q '.owner.login + " " + .name')"
gh api graphql -f query="{ repository(owner: \"$OWNER\", name: \"$NAME\") {
  projectsV2(first: 10) { nodes { number title } } } }" \
  --jq '.data.repository.projectsV2.nodes[] | "#\(.number) \(.title)"'
```

| Result | `inFlightState` |
|---|---|
| exit 0, empty | `"labels"` |
| exit 0, rows | `"board"` — and offer to record the board in the overlay (step 7) |
| non-zero | unknown — report the error and ask which applies; never assume "no board" |

## 3. Areas

Start from the generic set — `api ui db auth infra integrations docs ci` — and propose additions
from the repository's layout (`git ls-files | cut -d/ -f1 | sort -u`) and its README. Show the
list; the operator edits it. Names: lowercase letters, digits, hyphens.

## 4. Plan — show it and wait for a yes

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/github-workflow/scripts/bootstrap-labels.sh" --dry-run \
  --areas "<comma-separated areas>" [--board]
```

and the files that will be written, marking each that **already exists**:

| File | From |
|---|---|
| `.github/github-workflow.json` | generated (shape: `assets/github-workflow.example.json`) |
| `.github/ISSUE_TEMPLATE/1-bug.yml` … `4-chore.yml` | `assets/ISSUE_TEMPLATE/` |
| `.github/ISSUE_TEMPLATE/config.yml` | `assets/ISSUE_TEMPLATE/config.yml`, `OWNER/REPO` filled in |
| `.github/pull_request_template.md` | `assets/pull_request_template.md` |

GitHub also reads files the table's paths miss: a PR description file in any letter case, at the
root, in `docs/` or in `.github/`, or a `PULL_REQUEST_TEMPLATE/` directory there; and every file in
`.github/ISSUE_TEMPLATE/` appears in the issue chooser. List them, leaving out the table's paths:

```bash
git ls-files -co --exclude-standard \
  | grep -iE '^(docs/|\.github/)?(pull_request_template|issue_template)(\.[a-z]+$|/)' \
  | grep -vE '^\.github/(pull_request_template\.md|ISSUE_TEMPLATE/(1-bug|2-feature|3-enhancement|4-chore|config)\.yml)$'
```

A hit that differs from a table path **only in letter case** (`.github/PULL_REQUEST_TEMPLATE.md`)
is the same file on Windows and macOS. It is that table row's existing file: show the diff in step
6.4 and write into it under its own spelling, or first rename it to the table's spelling with
`git mv`. **Never `git rm` it** — that removes the file this run writes.

For every other hit, ask whether the new files **replace** it (`git rm` it in step 9), **sit
beside** it, or are **skipped**. Two PR description files, or two bug forms in the chooser, is the
outcome to avoid. Say too that the installed `config.yml` sets `blank_issues_enabled: false`, so
the chooser stops offering a blank issue, and what happens to its Security contact link (step 1):
kept, pointed at the security policy, or dropped.

On a **re-run** (`.github/github-workflow.json` already exists), write the proposed config (the
shape in step 6.2) to a temporary file outside the repository, and pass `--config <that file>`
instead of `--areas`/`--board`, both to this dry run and to step 6.1. No flag turns board mode
off: without `--config` the script reads the existing file, so a repository moving from `"board"`
to `"labels"` would still skip `status:in-progress` and `status:needs-review`.

With `--dry-run`, stop here.

## 5. Branch — before the first write

Nothing is written on the default branch (rule 2). Once `.github/github-workflow.json` exists, the
plugin's hook also asks the operator before every edit there, so the branch comes first. Look at
where the tree stands:

```bash
git status --short
git branch --show-current
git branch --list chore/adopt-github-workflow
git ls-remote --heads origin chore/adopt-github-workflow
```

- Uncommitted changes — this run has made none yet, so they are not its own — or a current branch
  other than the default branch (step 1): say so and ask the operator where to branch from. Do not
  assume: a PR cut from a feature branch carries that branch's commits.
- `chore/adopt-github-workflow` already exists, locally or on origin: propose a free name instead
  (add `-2`).

Then propose this, with `<branch>` the name settled above and `<base>` the default branch or the
one the operator chose, and ask before running it:

```bash
git checkout -b <branch> <base>
```

If the checkout has uncommitted changes, or the operator does not want its branch switched, do
not switch it (rule 2): offer a worktree instead, and do every later step from inside it.

```bash
git worktree add -b <branch> ../adopt-github-workflow <base>
cd ../adopt-github-workflow
```

## 6. Apply

1. Create the labels: the same command without `--dry-run`.
2. Write `.github/github-workflow.json`:

   ```json
   {
     "version": 1,
     "repo": "<owner/name>",
     "inFlightState": "<labels|board>",
     "areas": ["<area>", "..."],
     "gates": {
       "closingKeywords": true, "duplicateSearch": true, "labelTaxonomy": true,
       "defaultBranch": true, "discardChanges": true
     }
   }
   ```

   Ask whether any paths need a **deploy-impact** declaration on PRs (migrations, infrastructure,
   runtime config). If so, add `"deployImpact": { "paths": ["<glob>", "..."], "doc": "<optional
   doc path>" }` to `gates`, and add this under *Risk and rollback* in the installed PR template:

   ```markdown
   **Deploy impact:**
   <!-- What this change needs done outside the code that no deploy performs by itself — an
        environment variable, a migration, a restart. "none" is a valid answer: write it. -->
   ```

3. Copy the issue forms and the PR template. In `config.yml` replace `OWNER/REPO` with the
   repository, and **delete the Discussions contact link** when `hasDiscussionsEnabled` was false —
   a link to a disabled Discussions tab is a 404. When step 1 found the Security link would
   dead-end, repoint or delete it as planned in step 4; on a repoint, change its `about` to
   say the policy explains how to report privately. Edit with your file tools, not `sed -i` (its
   flags differ between GNU and BSD).
4. Any file that already existed: show the diff and get a yes for that file. Never overwrite blind.
   For the other PR and issue files step 4 found, do what the operator chose there.

## 7. Optional extras — ask about each

- **Repo overlay** `.github/GITHUB_WORKFLOW.md` from `assets/GITHUB_WORKFLOW.template.md` — the
  place for decisions only this repo makes. Fill in what you know (repository, default branch, the
  board's number and its Status options read with the query in the skill's
  `references/project-board.md`); leave the rest marked for the operator.
- **Script copies** in `.github/scripts/` (the three scripts) — for Codex, Cursor, Copilot, CI or
  a human, none of whom can see the plugin.
- **AGENTS.md pointer** — append `assets/AGENTS.snippet.md` to `AGENTS.md` (create it if absent).
  Then, if the repository has a `CLAUDE.md` with no line reading `@AGENTS.md`, propose appending
  that import line to it, and say why: Claude Code reads `AGENTS.md` on its own only when there is
  no `CLAUDE.md`, so without the import the pointer never reaches Claude in this repository. Ask
  first, as for every file:

  ```bash
  [ -f CLAUDE.md ] && ! grep -qE '^@(\./)?AGENTS\.md[[:space:]]*$' CLAUDE.md && echo "CLAUDE.md does not import AGENTS.md"
  ```

## 8. Stock labels

The bootstrap run lists any of GitHub's stock labels (`bug`, `enhancement`, `duplicate`, `wontfix`,
`documentation`, `question`, `invalid`) still present; they shadow the taxonomy. Report them. **Never
delete a label yourself**: deleting a label strips it from every issue carrying it. If the operator
wants them gone, print the loop from the skill's `references/labels.md`, with only the names the
run reported, for the operator to run themselves:

```bash
for l in <the stock labels reported>; do
  gh label delete "$l" --yes
done
```

## 9. Hand off

Nothing is committed. Propose the commands below, on `<branch>` from step 5, and
ask before running any of them. The `git add` names **exactly the files this run wrote**, by path:
add each step 7 extra that was written (`.github/GITHUB_WORKFLOW.md`, the three scripts in
`.github/scripts/`, `AGENTS.md`, `CLAUDE.md`), drop anything that was skipped, and add a
`git rm <path>` for each file step 4 replaced. A case variant kept under its own spelling is staged
under that spelling: `git add` of the table's spelling stages nothing there. Label the PR with one
of the configured areas, `ci` if it was kept:

```bash
git add \
  .github/github-workflow.json \
  .github/ISSUE_TEMPLATE/1-bug.yml .github/ISSUE_TEMPLATE/2-feature.yml \
  .github/ISSUE_TEMPLATE/3-enhancement.yml .github/ISSUE_TEMPLATE/4-chore.yml \
  .github/ISSUE_TEMPLATE/config.yml .github/pull_request_template.md
git commit -m "chore: adopt the github-workflow protocol"
git push -u origin <branch>
gh pr create --fill --label "type:chore,area:<a configured area>"
```

Then run the hook's self-check and show its output. The mode row should now read `adopted`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/check-issue-workflow.mjs" --self-check --cwd "$(git rev-parse --show-toplevel)"
```

Finally, tell the operator to type `/github-workflow:doctor` for the full report (tools, auth
scopes, config, labels). It is user-only, so you cannot start it yourself.
