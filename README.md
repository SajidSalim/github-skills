# github-skills

[![CI](https://github.com/SajidSalim/github-skills/actions/workflows/ci.yml/badge.svg)](https://github.com/SajidSalim/github-skills/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Claude Code plugin marketplace. Its plugin, **github-workflow**, makes a coding agent work a
GitHub tracker the way a careful teammate would, and puts guardrails in front of the mistakes
agents actually make.

> A GitHub connector lets an agent **act** on GitHub. github-workflow decides **when and how** it
> should: search before filing, ask before creating, claim before starting, never merge its own
> work, close with a written record. It also enforces the parts a machine can check.

**Contents:**
- [Why this exists](#why-this-exists)
- [How it differs from a GitHub connector](#how-it-differs-from-a-github-connector)
- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Installation](#installation)
- [Setting up a repository](#setting-up-a-repository)
- [Day-to-day use](#day-to-day-use)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Development](#development)

## Why this exists

Give a coding agent access to GitHub, and sooner or later these things happen:

| What goes wrong | What github-workflow does about it |
|---|---|
| It files a duplicate of an open issue, or reopens a question that was closed as won't-fix last month | Searches open **and closed** issues before proposing one, and shows you what it found |
| It creates issues nobody asked for | Never creates an issue without asking you first |
| Two agents pick up the same issue. They share one GitHub login, so the assignee field tells them nothing | Reads the comment thread before claiming, then posts a pick-up comment saying what it checked |
| A PR description saying "this does **not** close #12" closes #12 when it merges | Blocks the PR before it is created when a closing keyword sits beside a negation, in code or in a quote |
| Issues get closed with no explanation | Every issue closes with a written record that can be reached from the issue |
| It merges its own PR | Opens the PR, reports it and stops. A human merges |
| Labels drift: `bug`, `Bug`, `type: bug`, `kind/bug` | Uses one strict taxonomy, and checks every issue and PR after it is created or edited |
| It edits files or commits straight onto `main` | Asks you before any edit, commit, merge or push on the default branch |
| It "undoes" its own mistake with `git checkout -- .` and wipes your uncommitted work | Asks you before any command that would throw away uncommitted changes, and lists the files at risk |

## How it differs from a GitHub connector

GitHub connectors and the `gh` CLI give an agent **capabilities**: tools to read and write issues,
pull requests, labels and branches. The connectors include the GitHub MCP server, the `github`
plugin in Claude Code's official marketplace, and claude.ai's GitHub integration.

They are neutral about how those tools get used. A connector will file the duplicate, apply the
wrong label or merge the PR as readily as it does the right thing.

github-workflow is a **process and guardrail layer** that sits on top of those capabilities. It
does not replace a connector, and it does not need one: it drives GitHub through `gh`, the official
GitHub CLI.

| | A connector or `gh` on its own | With github-workflow |
|---|---|---|
| Create, edit, label and close issues and PRs | Yes | Yes, through `gh` |
| Search open **and closed** issues before filing, and show the results | Only if your prompt asks for it | Always. In repositories that adopt the workflow, a gate checks for the search record |
| Ask before creating an issue | Depends on the prompt | Always |
| Notice that another agent already claimed an issue | No: agents usually share one login | Reads the thread, and follows a pick-up comment protocol |
| Catch "does not close #12" before GitHub acts on it | No | Blocks the PR, in every repository |
| Keep labels consistent | No | A strict taxonomy, a script that creates it, and a check after every create or edit |
| Never merge its own work | No | A rule: open the PR, then stop |
| Leave a written record on every close | No | A rule, plus comment templates |
| Protect the default branch and your uncommitted work | No | Asks you first, including for subagents and in bypass-permissions mode |
| Issue forms, PR template, comment templates | No | Installed by setup |
| Treat a GitHub Projects board as the source of truth | Raw API access | Board mode: reads and moves cards by their Status |

You can use both together. The one caveat is about enforcement:
- **What the gates watch:** `gh` and `git` commands run through Claude Code's Bash tool, and edits to
  files.
- **What they don't:** a connector's own tools, such as an MCP "create issue" tool, are separate
  calls.
- **What that means:** the skill's rules still guide the agent on those calls, but nothing enforces
  them. Let the agent use `gh` when you want the guarantees.

## What you get

### A protocol for the whole issue-to-PR loop

The skill loads itself whenever a task touches issues, branches, commits, PRs, labels or a project
board. It walks the agent through every stage:

- **Deciding whether something needs an issue.** A new feature does. A bug in its own uncommitted
  work does not. A second problem found halfway through a task means asking you.
- **Filing an issue:**
  - a duplicate search across open and closed issues, with a helper script;
  - a `Searched:` / `Candidates:` / `Verdict:` record of that search;
  - a body written to a template, with labels proposed for your approval.
- **Picking up an issue:**
  - read the whole thread, then assign itself;
  - post a pick-up comment giving its plan, branch, scope and assumptions;
  - create a branch named `<type>/<issue>-<slug>` and linked to the issue. If the checkout isn't the
    agent's to switch, it uses a worktree instead.
- **Implementing:** Conventional Commits with `Refs #N`. Tests are part of the work, not a
  follow-up.
- **Opening the PR:**
  - the PR template, with one closing keyword per issue, each on its own line;
  - report the PR, then stop;
  - handle review requests, conflicts and abandoned PRs.
- **Closing:** when a closing comment is needed and what it says (the root cause, the fix, and how
  it was verified). `wontfix`, `duplicate`, `cannot-reproduce` and `works-as-intended` closes
  each get a `resolution:` label.
- **Relating issues:** duplicates, sub-issues and blocked-by, using GitHub's own relationship
  fields, with fallbacks for an older `gh`.
- **Projects boards:** when a board owns the in-progress state, the agent moves cards rather than
  setting status labels.
- **Guest mode:** in a repository you don't maintain, the same rules apply with that repository's
  own labels and conventions. No labels are created, and comments are posted only after asking.

### A label taxonomy

| Family | Rule | Values |
|---|---|---|
| `type:` | exactly one | `feature`, `enhancement`, `bug`, `security`, `chore`, `docs`, `refactor`, `test`, `spike` |
| `priority:` | exactly one, or `status:needs-triage` | `p0`–`p3` |
| `severity:` | exactly one on bugs and security issues | `sev-1`–`sev-4`, each with examples |
| `area:` | one or more | your repository's parts, proposed from its layout |
| `status:` | zero or one | `needs-triage`, `needs-info`, `blocked`; plus `in-progress` and `needs-review` when no board tracks them |
| `resolution:` | at close, when the close was not a normal fix | `duplicate`, `wontfix`, `cannot-reproduce`, `works-as-intended` |

### Six gates, enforced by hooks

The gates are hooks that run on every tool call that matters, including calls made by
subagents that never load the skill. Four of them **block** the command and tell the agent why.
The other two **ask you**: Claude Code shows a confirm prompt in every permission mode, and
your yes is the explicit permission the rules require.

| Gate | Applies in | What it does |
|---|---|---|
| Accidental closing keyword | every repository | **Blocks** a PR whose body would close an issue by accident |
| Duplicate-search record | adopted repositories | **Blocks** `gh issue create` without a `Searched:` / `Candidates:` / `Verdict:` record |
| Label taxonomy | adopted repositories | **Blocks** after an issue or PR is created or edited with labels that break the taxonomy, so the agent fixes them |
| Deploy impact | adopted repositories that configure it | **Blocks** a PR that touches deploy-sensitive paths without a `Deploy impact:` line |
| Default branch | adopted repositories | **Asks you** before an edit, commit, merge or push on the default branch |
| Uncommitted-changes discard | every repository | **Asks you** before `checkout --`, `restore`, `reset --hard`, `clean -f`, `stash drop` and the like, when there is something to lose |

A gate that can't run, for example because Node or `jq` is missing, never blocks or asks.
`/github-workflow:doctor` tells you whether each gate is live. [Every gate in detail, with its
limits](plugins/github-workflow/README.md#gates).

### Commands, scripts and templates

**Commands:**
- `/github-workflow:setup`: adopts the workflow in a repository.
- `/github-workflow:doctor`: a read-only health check.

You type both yourself; Claude never runs them on its own.

**Scripts:** plain bash, runnable by anyone.
- `find-duplicates.sh`: ranked duplicate candidates for a title.
- `lint-issue-labels.sh`: checks one issue, or the whole backlog.
- `bootstrap-labels.sh`: creates the taxonomy.

**Templates:**
- issue forms for bugs, features, enhancements and chores;
- a PR template;
- comment templates for pick-up, implemented, resolved, correction, closing without a fix,
  blocked and handover;
- a repository overlay template and an `AGENTS.md` snippet.

**It works beyond Claude.** The protocol is plain markdown and the scripts are plain bash. Setup can
put copies in the repository, so Codex, Cursor, Copilot and human contributors follow the same
workflow. The hooks are Claude Code only.

## Requirements

| Tool | Version | Used for |
|---|---|---|
| [Claude Code](https://code.claude.com) | recent | Plugins, skills and hooks |
| [GitHub CLI](https://cli.github.com) `gh` | ≥ 2.50.0, authenticated with the `repo` scope | Everything on GitHub. Version 2.88.0 adds native duplicate closing, and 2.94.0 adds sub-issues and blocked-by. Older versions fall back to comments |
| `git` | any recent version | Branches, and the default-branch and discard gates |
| [`jq`](https://jqlang.org) | ≥ 1.6, the real binary | The scripts and the label gate (`gh --jq` doesn't count) |
| [Node.js](https://nodejs.org) | ≥ 18 | The hooks. **Without Node every gate is off**, and doctor says so |
| `bash` | ≥ 3.2 | Scripts and the hook launcher. macOS's `/bin/bash` works; on Windows, use Git Bash |

For a GitHub Projects board, also grant `read:project` (to read it) or `project` (to move cards):
`gh auth refresh -s project`.

## Installation

**1. Check the prerequisites:**

```bash
gh --version && gh auth status
git --version && jq --version && node --version
```

**2. Add the marketplace and install the plugin.** Inside Claude Code:

```text
/plugin marketplace add SajidSalim/github-skills
/plugin install github-workflow@github-skills
```

Or from a shell:

```bash
claude plugin marketplace add SajidSalim/github-skills
claude plugin install github-workflow@github-skills
```

**3. Restart Claude Code** so that it loads the plugin.

**4. Verify it.** Open Claude Code in any repository and run:

```text
/github-workflow:doctor
```

It reports Node, the mode (guest or adopted) and every gate, as `ready`, `NOT RUNNING` with a
fix, or `n/a`. Outside an adopted repository, only the closing-keyword and discard gates apply.

**Updating, disabling and removing:**

```bash
claude plugin update github-workflow@github-skills      # then restart Claude Code
claude plugin disable github-workflow@github-skills     # turn it off, keep it installed
claude plugin uninstall github-workflow@github-skills
```

Removing the plugin leaves every repository you set up as it was. The labels, config and templates
are ordinary files and labels in those repositories.

## Setting up a repository

There are two ways to use the plugin.

- **As a guest, with nothing to set up.** Once the plugin is installed, the rules apply in every
  repository, using that repository's own labels and conventions. Only the closing-keyword and
  discard gates are enforced. This suits repositories you contribute to but don't maintain.
- **Adopted, recommended for repositories you maintain.** Run setup once. Every gate is then
  enforced, for everyone working in the repository with the plugin installed.

To adopt a repository:

**1. Preview.** Open Claude Code in the repository and run:

```text
/github-workflow:setup --dry-run
```

Setup checks `gh` and its scopes, finds the default branch, looks for a linked Projects board, and
proposes `area:` labels from the repository's layout. It also finds any existing issue forms and PR
templates. It shows the labels it would create and the files it would write, and writes nothing.

**2. Apply:**

```text
/github-workflow:setup
```

Setup asks before every step. In order, it:

1. proposes a branch (`chore/adopt-github-workflow`) before its first write, or a worktree if you
   would rather not switch your checkout;
2. creates the labels on GitHub;
3. writes `.github/github-workflow.json`, the issue forms and the PR template. For a file that
   already exists, it shows the diff and asks whether to replace it, keep it alongside, or skip it;
4. offers the extras:
   - a repository overlay, `.github/GITHUB_WORKFLOW.md`, for decisions only this repository makes;
   - copies of the scripts in `.github/scripts/`;
   - an `AGENTS.md` pointer, and an `@AGENTS.md` import in an existing `CLAUDE.md` so that Claude
     reads it;
5. lists GitHub's stock labels (`bug`, `enhancement` and so on) that would shadow the taxonomy, and
   prints a loop you can run to delete them;
6. proposes the commit, push and `gh pr create` commands for the files it wrote.

It never commits, pushes or deletes anything without your yes.

**3. Review and merge the setup PR** yourself.

**4. Run `/github-workflow:doctor`** again. In the adopted repository, every gate should read
`ready`.

Re-running setup later is safe: it shows a diff for every file that already exists.

## Day-to-day use

You don't call the skill by name. Ask in plain words, and it loads when the task involves GitHub:

| You say | The agent |
|---|---|
| "File an issue: checkout returns 500 when the coupon code is blank" | Searches open and closed issues, shows you the candidates, and proposes a title, body and labels. It creates the issue only after your yes |
| "Pick up #231" | Reads the whole thread. If someone else is on it, it stops and asks. Otherwise it assigns itself, posts a pick-up comment and creates `fix/231-checkout-blank-coupon` |
| "Open the PR" | Fills in the PR template with `Closes #231`, opens the PR, comments on the issue, reports the PR number and stops |
| "Close #244 as a duplicate of #231" | Links the two, applies `resolution:duplicate` and says which issue survives |
| "Check the backlog's labels" | Runs the label check over every open issue and proposes fixes |

When a gate asks you to confirm something, the prompt names who is asking, including which
subagent, and what is at stake. Approve it only if you meant it.

## Configuration

An adopted repository is configured by `.github/github-workflow.json`, which setup writes:

```json
{
  "version": 1,
  "repo": "acme/shop",
  "inFlightState": "labels",
  "areas": ["api", "ui", "db", "auth", "infra", "docs", "ci"],
  "gates": {
    "deployImpact": { "paths": ["migrations/**", "infra/**"], "doc": "docs/DEPLOY.md" }
  }
}
```

- **`inFlightState`:** `"board"` when a GitHub Projects board tracks work in progress.
- **Gates:** every gate defaults to on, except `deployImpact`, which runs only when configured.
  Turn one off for the repository with, for example, `"gates": { "labelTaxonomy": false }`.
- **Per user:** two plugin options apply to every repository: `closing_keyword_gate` and
  `discard_gate`. Change them with `/plugin configure github-workflow@github-skills`.

The gates' messages never say how to turn a gate off. That decision belongs to you, not the agent.

[Every field](plugins/github-workflow/skills/github-workflow/references/configuration.md) ·
[the overlay
template](plugins/github-workflow/skills/github-workflow/assets/GITHUB_WORKFLOW.template.md)

## Documentation

| Document | What's in it |
|---|---|
| [Plugin README](plugins/github-workflow/README.md) | The full reference: modes, every gate and its limits, switches, troubleshooting, token cost |
| [The skill](plugins/github-workflow/skills/github-workflow/SKILL.md) | The protocol itself, the text the agent follows |
| [References](plugins/github-workflow/skills/github-workflow/references/) | Labels, the duplicate check, issue authoring, relationships, `gh` commands, Projects boards, configuration |
| [Changelog](plugins/github-workflow/CHANGELOG.md) | What changed in each release |
| [Publishing](docs/publishing.md) | How releases are cut |

## Development

```text
.claude-plugin/marketplace.json     the marketplace manifest
plugins/github-workflow/
  .claude-plugin/plugin.json        the plugin manifest and its options
  hooks/                            the gates: a zero-dependency Node hook and its launcher
  skills/github-workflow/           the protocol, references, templates and scripts
  skills/setup/, skills/doctor/     the two commands
  tests/                            bash tests (gh stubbed) and Node tests for the hook
  evals/                            the model-behaviour eval suite
```

Run the tests:

```bash
bash plugins/github-workflow/tests/run-tests.sh
node --test plugins/github-workflow/tests/hooks/*.test.mjs
claude plugin validate plugins/github-workflow --strict && claude plugin validate . --strict
```

To try a local checkout without installing it, run `claude --plugin-dir plugins/github-workflow`.
The [plugin README](plugins/github-workflow/README.md#running-the-tests) covers the eval suite,
which makes billed model calls.

Bug reports and ideas are welcome in [issues](https://github.com/SajidSalim/github-skills/issues).
CI runs on Ubuntu and Windows with Node 20 and 22, on macOS with `/bin/bash` 3.2, and runs
shellcheck.

## License

[MIT](LICENSE)
