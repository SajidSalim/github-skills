# GitHub Workflow

A disciplined issue-to-PR protocol for coding agents working on GitHub, extracted from the
workflow of a production repository and generalized for any repository. The agent searches for
duplicates before it proposes an issue, asks before it files one, claims work through the comment
thread, branches and opens a PR but never merges, labels to a strict taxonomy, and closes every
issue with a written record. That prevents the usual failures of agents on a shared tracker:
duplicate issues, two agents on one issue, issues closed by accident (a PR saying "does not close
#12" closes #12), issues closed with no explanation, agents merging their own work, and label
drift — and an agent editing or committing on the default branch, or discarding uncommitted work
that was not its own. Opt-in hooks enforce the parts that can be checked mechanically.

## What it does

The skill holds the agent to ten rules:

1. **Never create an issue without asking** — search for duplicates first and show what was found.
2. **Never edit, commit to or merge into the default branch** unless the operator says so, for that change — one branch and one PR per unit of work; a human merges. Never switch the branch of a checkout the agent did not create: if it has changes the agent did not make, ask, or work in a worktree.
3. **Read the thread before you claim an item** — the assignee field alone will not show that another agent is on it.
4. **GitHub is the record** — state lives on the issue, not in the agent's context or a scratch file.
5. **Comment when you start, comment when you finish** — every record is written at a moment the agent is present for.
6. **Every issue worked carries the commit or PR that implemented it** before it is closed.
7. **Every issue closes with a written explanation reachable from the issue.**
8. **One issue = one problem** — a second problem is a second issue.
9. **Never close an issue you did not verify** — "tests pass" is verification, "should work" is not.
10. **Never run a command that discards uncommitted changes** — `git checkout -- <path>`, `git restore`, `git reset --hard`, `git clean -f` and the like — unless the operator says so: the changes may not be the agent's. To undo its own misplaced edit, it saves a patch first and asks.

The full protocol — labels, comment templates, relationships, Projects boards, closing — is in
[skills/github-workflow/SKILL.md](skills/github-workflow/SKILL.md) and its references.

## Install

In Claude Code:

```text
/plugin marketplace add SajidSalim/github-skills
/plugin install github-workflow@github-skills
```

Or from a shell:

```bash
claude plugin marketplace add SajidSalim/github-skills
claude plugin install github-workflow@github-skills
```

Restart Claude Code to load it. Update later with
`claude plugin update github-workflow@github-skills`.

## Requirements

| Tool | Version | Why |
|---|---|---|
| `git` | any recent version | Branches; the changed-file list for the deploy-impact gate; the default branch, ignored files and `git status` for the default-branch and discard gates |
| GitHub CLI `gh` | ≥ 2.50.0, authenticated (`gh auth login`) with the `repo` scope; `read:project` to read a Projects board, `project` to move its cards | 2.50.0 is the first release whose `gh issue list --json` has `stateReason`, which the duplicate search needs. `--duplicate-of` and `--reason duplicate` need ≥ 2.88.0; `--parent`, `--add-sub-issue` and `--add-blocked-by` need ≥ 2.94.0. On an older `gh` the skill falls back to a "Duplicate of #N" comment or a cross-link comment |
| `jq` | ≥ 1.6, the real binary | The scripts and the label-taxonomy gate pipe to it. `gh --jq` is a different, embedded implementation and does not count |
| Node.js | ≥ 18 | Runs the hook. Without Node the hook exits quietly and **every gate is off**; `/github-workflow:doctor` says so. Claude Code's native installer does not bring Node with it |
| `bash` | ≥ 3.2 | The scripts and the hook launcher. macOS's stock `/bin/bash` works; on Windows, Git Bash |

## Quick start

In a repository you maintain, start Claude Code and run:

```text
/github-workflow:setup --dry-run
```

It checks `gh`, looks for a Projects board linked to the repository, proposes `area:` labels from
the repository's layout, and shows the plan: the labels it would create and the files it would
write (`.github/github-workflow.json`, the issue forms, the PR template). Nothing is written. When
the plan looks right, run it for real:

```text
/github-workflow:setup
```

Setup asks before every write. Before the first one it proposes a branch for the change, so
nothing lands on the default branch. Once you say yes it creates the labels on GitHub and writes
the files into the working tree, then offers the extras (a repository overlay, script copies, an
`AGENTS.md` pointer — see [Using it with other agents](#using-it-with-other-agents)). It never
commits, pushes or deletes anything on its own. It reports any of GitHub's stock labels that would
shadow the taxonomy and prints the delete loop for you to run if you want them gone. Last, it
proposes the commit, push and `gh pr create` commands for the files it wrote and asks before running
them: say yes, review the PR, and merge it yourself. Then check that everything is live:

```text
/github-workflow:doctor
```

Then just work. "File an issue for the checkout 500", "pick up #231", "open the PR" — the skill
loads itself whenever the task touches issues, branches, commits, PRs, labels or a board.

## Modes

Plugin hooks run in every repository you open, so enforcement is opt-in: a repository adopts the
protocol by committing `.github/github-workflow.json`, and everywhere else the plugin is a guest.

| Mode | When | What applies |
|---|---|---|
| **Guest** | no `.github/github-workflow.json` at the repository root | the ten rules, adapted to the repository's own labels and conventions — no labels are created, and protocol comments in a repository you do not maintain are posted only after asking; only the closing-keyword and discard gates are enforced |
| **Adopted** | the file exists, and a command's `--repo` (if any) names the repository it describes | the full protocol; every gate below is enforced |

The config is read from the root of the git repository the command runs in, after any `cd` before
`gh` in the same command, so commands run from a subdirectory are covered. A `gh … --repo X` command gets the repository gates only when `X` is the configured
repository (URL and `HOST/OWNER/REPO` forms and any case match). An edit target given by URL, and
`GH_REPO`, name the repository the same way. `GH_REPO` counts from the environment, as a prefix on
`gh`, or set earlier in the same command with `export GH_REPO=…` or `GH_REPO=…` (and cleared with
`unset GH_REPO`), scoped as `cd` is. When the shell expands its value, the repository cannot be known
and the command is treated as guest.

## Gates

| Gate | Fires | Applies | Stops the agent when | Switch it off |
|---|---|---|---|---|
| Accidental closing keyword | before `gh pr create` and `gh pr edit` | every repository | a closing keyword sits beside a negation, in a code span, a fenced block or a blockquote — GitHub would act on it | the plugin option `closing_keyword_gate`, or `"closingKeywords": false` in the repository's `gates` |
| Duplicate-search record | before `gh issue create` | adopted repositories | the body lacks any of `Searched:`, `Candidates:`, `Verdict:` | `"duplicateSearch": false` |
| Deploy impact | before `gh pr create` | adopted repositories that configure it | the branch touches a configured path and the body has no `Deploy impact:` line | leave `gates.deployImpact` out (it is off unless configured) |
| Label taxonomy | after `gh issue/pr create/edit` | adopted repositories | `lint-issue-labels.sh` reports a `FAIL` for the item; the item exists, so the agent is told to fix its labels | `"labelTaxonomy": false` |
| Default branch | before `Edit`, `Write`, `MultiEdit` and `NotebookEdit`; before `git commit`, `merge`, `cherry-pick`, `revert`, `am` and `push` | adopted repositories | **asks you** when the edited file's checkout is on its default branch (git-ignored files excepted), a commit lands on the default branch, or a push writes to it | `"defaultBranch": false` |
| Uncommitted-changes discard | before `git checkout -- <path>` (or `-f`, `.`), `restore`, `reset --hard`, `clean -f`, `switch --discard-changes`, `stash drop`/`clear` and `worktree remove -f` | every repository | **asks you** when `git status` shows uncommitted work the command would destroy, naming up to five of the files | the plugin option `discard_gate`, or `"discardChanges": false` |

The closing-keyword gate checks pull requests only: closing keywords act from PR descriptions and
default-branch commit messages, never from an issue body.

**The last two ask; they do not block.** Claude Code shows you a confirm prompt with the reason, in
every permission mode — `bypassPermissions` included — and for a subagent's tool call too, the
prompt surfacing in your session. That is the point: hooks fire for every agent, including a coding
subagent that never loads the skill, and your yes is the "unless the operator says so" the rules
allow. Headless `claude -p` has no one to ask, and its behaviour is not documented: expect the call
to be refused. When another gate blocks the same command, the block wins.

The default-branch gate judges an edit by the checkout that holds the file, not the session's
directory: a subagent working in a worktree can still write into your main checkout. It judges a
command by the directory it runs in, following `cd` and `git -C`, and takes the default branch from
`origin/HEAD`, else `main` or `master`. A detached HEAD, or a directory it cannot determine, passes.
The discard gate asks only when something would be lost; when it cannot tell — a path or directory
the shell expands — it asks with the command alone.

**Limits.** The default-branch gate does not cover `git pull`, `git rebase`, `git reset --soft` or
`--mixed`, or `git branch -f` on the default branch, and a fast-forward (`git merge --ff-only`) adds
no commit and passes. Neither gate sees git that the command text does not show: `bash -c "…"`, a
script, `find -exec`.

**A gate that cannot run never blocks or asks.** No Node, `git`, `gh`, `jq` or `bash`, or a body the
hook cannot read: the command goes through. `/github-workflow:doctor` is how you find out whether
every gate is live.

The hook judges the body `gh` will send. A heredoc counts: `--body "$(cat <<'EOF' … EOF)"`,
`--body-file -` fed by a heredoc, and a `--body-file` the same command first writes with
`cat > FILE <<'EOF'`. These bodies it cannot read, so they go through unchecked: one piped on stdin
without a heredoc, `--web`, a `--body` the shell builds without a heredoc (`"$(cat FILE)"`,
`"$BODY"`; the closing-keyword gate still judges its literal text), and a `--body-file` the same
command writes some other way (`echo … > FILE`, a `tee` not fed by a heredoc).
On Windows, Git Bash paths such as `/tmp/pr.md` are translated before the file is read.

The block and ask messages deliberately do not say how to switch a gate off. The switches are
for you:

- **The closing-keyword gate, everywhere, for you** — the plugin option `closing_keyword_gate`.
  Inside Claude Code run `/plugin configure github-workflow@github-skills`. From a shell:

  ```bash
  printf '%s' '{"closing_keyword_gate":"false"}' | claude plugin configure github-workflow@github-skills --values-stdin
  ```

  The CLI needs the full `name@marketplace` id, and without `--values-stdin` it only displays the
  current values. Set it back with `"true"`.
- **The discard gate, everywhere, for you** — the plugin option `discard_gate`, set the same way:
  `{"discard_gate":"false"}`.
- **Any gate, for one repository, for everyone working in it** — its `gates` keys in
  `.github/github-workflow.json`: `"closingKeywords": false`, `"duplicateSearch": false`,
  `"labelTaxonomy": false`, `"defaultBranch": false`, `"discardChanges": false`, or no
  `"deployImpact"` entry.

## Commands

| Command | What it does |
|---|---|
| `/github-workflow:setup [--dry-run]` | Adopts the protocol in the current repository: labels, `.github/github-workflow.json`, issue forms, PR template, optional extras. Asks before every write; `--dry-run` stops after showing the plan. Safe to re-run — it shows a diff for every file that already exists |
| `/github-workflow:doctor` | Read-only health check: tools and their versions, `gh` auth scopes, the mode, the config, the labels, and each gate — `ready`, `NOT RUNNING` or `n/a`, with the fix for anything not ready |
| `/github-workflow:github-workflow` | The protocol itself. You rarely type it: Claude loads it whenever a task involves GitHub issues, branches, commits, PRs, labels or a board |

`setup` and `doctor` are user-only: Claude never runs them on its own.

## Configuration

`.github/github-workflow.json` at the repository root (setup writes it). A fuller example,
[skills/github-workflow/assets/github-workflow.example.json](skills/github-workflow/assets/github-workflow.example.json):

```json
{
  "version": 1,
  "repo": "acme/shop",
  "inFlightState": "labels",
  "areas": ["api", "ui", "db", "auth", "infra", "integrations", "docs", "ci", "checkout", "catalog", "payments"],
  "gates": {
    "closingKeywords": true,
    "duplicateSearch": true,
    "labelTaxonomy": true,
    "defaultBranch": true,
    "discardChanges": true,
    "deployImpact": {
      "paths": ["migrations/**", "infra/**", "config/production.*"],
      "doc": "docs/DEPLOY.md"
    }
  }
}
```

`inFlightState` is `"board"` when a GitHub Projects board tracks work in progress (then the
`status:in-progress` and `status:needs-review` labels are never created or used); `areas` is the set
of `area:` labels; every gate defaults to on except `deployImpact`. A UTF-8 BOM and CRLF line
endings are fine. Every field, the glob syntax and what counts as malformed:
[skills/github-workflow/references/configuration.md](skills/github-workflow/references/configuration.md).

Decisions only one repository makes — its board's number and Status options, severity examples in
its own domain, what each area covers, deploy rules — go in an overlay, `.github/GITHUB_WORKFLOW.md`,
written from
[skills/github-workflow/assets/GITHUB_WORKFLOW.template.md](skills/github-workflow/assets/GITHUB_WORKFLOW.template.md)
(setup offers to start it). On a GitHub question the overlay outranks the skill; the repository's
own `AGENTS.md`, `CLAUDE.md` and `CONTRIBUTING.md` outrank both.

## Using it with other agents

The protocol is not tied to Claude: the skill and its references are plain markdown, and the
scripts are plain bash. Setup can make a repository's copy of the workflow visible to every agent
and every human who works in it — Codex, Cursor, Copilot, CI:

- `.github/scripts/` — copies of `find-duplicates.sh`, `lint-issue-labels.sh` and
  `bootstrap-labels.sh`, run as `bash .github/scripts/<name>.sh`;
- `.github/GITHUB_WORKFLOW.md` — the repository overlay;
- `AGENTS.md` — a short pointer to the protocol, appended from
  [skills/github-workflow/assets/AGENTS.snippet.md](skills/github-workflow/assets/AGENTS.snippet.md).
  When the repository also has a `CLAUDE.md`, setup offers to add an `@AGENTS.md` import line to it:
  Claude Code reads `AGENTS.md` on its own only when there is no `CLAUDE.md`, so without the import
  the pointer never reaches Claude.

The issue forms and the PR template work for everyone anyway. The hooks are Claude Code only:
other agents follow the protocol because their instructions say so, not because a gate checks it.

## Security

The hooks run in whatever repository you open, before you approve anything, so they never run a
program from it. The launcher and the hook find `node`, `git` and `bash` only in absolute `PATH`
entries, and git runs with `core.fsmonitor` off.

One lookup is out of the plugin's reach. `hooks/hooks.json` starts the launcher as `bash`, and
Claude Code looks that name up on `PATH`, in the session's directory, before any plugin code runs.
If your `PATH` has an empty or relative entry (a trailing `:`, or `.`),
a program planted in the working directory could run in place of bash, node or git.
`/github-workflow:doctor` shows a `PATH  warning` row naming such entries; remove them from `PATH`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| A gate never fires, and doctor or `node --version` shows no Node | The hook needs Node ≥ 18; without it every gate is off. Install Node, then restart Claude Code |
| A `gh issue create` without `Searched:` went through | Only adopted repositories have that gate. Run `/github-workflow:doctor` to see the mode; a `--repo` naming another repository, or a body the hook cannot read (see [Gates](#gates)), is not checked |
| `taxonomy check  NOT RUNNING` with `not on PATH: jq` | Until it is fixed the taxonomy gate passes silently. Install `jq` ≥ 1.6. On Windows, if `jq` was installed with winget and is still not found, Claude Code inherited a `PATH` from before the install, and restarting the editor usually does not fix it: copy `jq.exe` into a directory already on `PATH`, e.g. `cp "$LOCALAPPDATA/Microsoft/WinGet/Packages/jqlang.jq_"*/jq.exe ~/bin/` when `~/bin` is on it |
| `bash not found` or `git not found` in the self-check | The hook only runs `bash` and `git` from absolute `PATH` entries, never from the working directory or a relative entry. Put their directory on `PATH` as an absolute path |
| `PATH  warning  relative to the working directory: …` in the self-check | `PATH` has an empty or relative entry, so a program in the repository could run in place of `bash` when Claude Code starts the hook (see [Security](#security)). Remove the named entries from `PATH` |
| `invalid issue format: "208\r"` | CRLF from the Windows `jq` build: every captured value but the last ends in a carriage return. Pipe the capture through `tr -d '\r'` |
| `missing required scopes [read:project]` | The token cannot read Projects boards — this is **not** "no board". Run `gh auth refresh -s read:project` (or `-s project` to move cards) |
| `Permission denied` running a script | Git on Windows does not record the executable bit. Run scripts as `bash <path>`, never `./<path>` |
| Claude Code asks you to confirm an edit, a `git commit` or a `git push`, naming the default branch | The default-branch gate: that checkout is on its default branch. Approve if you asked for this change there; otherwise decline, and the agent should work on a branch or in a worktree. The prompt names a subagent when one made the call |
| A tool writing plans, specs or ledgers into the main checkout asks on every write | Those are edits on the default branch. Have the tool branch first, or git-ignore the paths it writes: ignored files never ask |
| Claude Code asks you to confirm a `git checkout`, `restore`, `reset --hard`, `clean` or `stash drop`, listing files | The discard gate: approving discards the uncommitted changes listed, which may be yours rather than the agent's. Approve only if you want them gone; an agent undoing its own edit can save a patch with `git diff` first |
| `github-workflow: <root>/.github/github-workflow.json is not valid (…) -- repo gates skipped; run /github-workflow:doctor` | The config is not valid JSON, has another `version`, or has a wrongly-typed `gates`. The repository gates are off until it is fixed; nothing is blocked because of it. Run `/github-workflow:doctor` |

## Token cost

Measured with `claude --plugin-dir plugins/github-workflow plugin details github-workflow` on
Claude Code 2.1.289, plugin 1.0.0:

```text
Projected token cost
  Always-on:   ~275 tok   added to every session

Per-component (rounded)
  component        always-on  on-invoke
  doctor                 ~70      ~1.4k
  github-workflow       ~130     ~11.8k
  setup                  ~80        ~3k
```

The hooks are harness-only and cost no model context; a gate's message reaches Claude only when it
blocks, and an ask's reason is shown to you. They do cost a little time: every Bash call and every
file edit starts the hook (bash, then Node). An edit outside an adopted checkout on its default
branch is settled by reading a few files; git runs only when it is. The ~11.8k for
`github-workflow` is paid each time the skill loads for GitHub work, and its references are read
only when a step needs them.

`plugin details` counts all three skill descriptions as always-on. `setup` and `doctor` are
user-only, though (`disable-model-invocation: true`): Claude cannot invoke them, and their bodies
(~3k and ~1.4k) load only when you type the command. Claude Code's skills documentation says a
user-only skill's description is not in the model's context either, so ~275 is an upper bound and
the primary skill's ~130 is what every session carries. All figures are estimates.

## Running the tests

From a clone of the marketplace repository:

```bash
bash plugins/github-workflow/tests/run-tests.sh                 # bash + jq only; gh is stubbed
node --test plugins/github-workflow/tests/hooks/*.test.mjs      # Node >= 20
claude plugin validate plugins/github-workflow --strict
```

`run-tests.sh --filter <text>` runs the files or tests whose name contains the text. To try a local
checkout without installing it, start Claude Code with
`claude --plugin-dir plugins/github-workflow`.

The eval suite in `plugins/github-workflow/evals/` runs the skill against two cases, with and
without the plugin:

```bash
claude plugin eval plugins/github-workflow --runs 2 --no-publish --trust-plugin --max-cost-usd 5 --judge-model sonnet --threshold 1 --json plugins/github-workflow/evals/results/latest.json
```

- It makes billed model calls (the agent runs and the judge), about $1.50 for the two cases.
- It grants the cases no Bash or other gated tool: the CLI grants those only through `--allow-tools`,
  which must never be passed, so no run can reach GitHub.
- A case passes only if every grader passes in every run: `--threshold 1` requires a case score
  of 1.0.

## License

MIT — see [LICENSE](LICENSE).
