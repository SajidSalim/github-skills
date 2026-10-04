# Configuration

The plugin works in every repository, in one of two modes. One committed file switches a
repository from the first to the second.

| Mode | When | What applies |
|---|---|---|
| **Guest** | no `.github/github-workflow.json` at the repository root | the rules of the protocol, adapted to the repo's own labels and conventions (SKILL.md §10); only the closing-keyword and discard gates are enforced |
| **Adopted** | the file exists, and a command's `--repo` (if any) names the repo it describes | the full protocol; every gate below is enforced |

`/github-workflow:setup` writes the file. `/github-workflow:doctor` checks it.

## The file

`<repository root>/.github/github-workflow.json` — JSON, so the hook (Node) and the scripts (`jq`)
read it without dependencies. A UTF-8 BOM and CRLF line endings are tolerated.

```json
{
  "version": 1,
  "repo": "acme/shop",
  "inFlightState": "labels",
  "areas": ["api", "ui", "db", "auth", "infra", "integrations", "docs", "ci", "checkout"],
  "gates": {
    "closingKeywords": true,
    "duplicateSearch": true,
    "labelTaxonomy": true,
    "defaultBranch": true,
    "discardChanges": true,
    "deployImpact": { "paths": ["migrations/**", "infra/**"], "doc": "docs/DEPLOY.md" }
  }
}
```

| Field | Type | When absent | Meaning |
|---|---|---|---|
| `"version"` | `1` | required | Schema version. Anything else is reported as malformed |
| `"repo"` | `"owner/name"` | — | The repository this describes. A `gh … --repo X` command gets the repo gates only when X is this repo (URL and `HOST/OWNER/REPO` forms and any case match) |
| `"inFlightState"` | `"labels"` or `"board"` | `"labels"` | `"board"`: a GitHub Projects board owns in-flight state, so `status:in-progress` and `status:needs-review` are never created or used |
| `"areas"` | string array | the generic eight | The `area:` labels `bootstrap-labels.sh` creates. Lowercase letters, digits, hyphens |
| `"gates"."closingKeywords"` | boolean | `true` | `false` switches the closing-keyword gate off for this repo |
| `"gates"."duplicateSearch"` | boolean | `true` | `false` stops requiring the `Searched:` record on `gh issue create` |
| `"gates"."labelTaxonomy"` | boolean | `true` | `false` stops linting labels after `gh issue/pr create/edit` |
| `"gates"."defaultBranch"` | boolean | `true` | `false` stops asking before an edit, a commit or a push on this repo's default branch |
| `"gates"."discardChanges"` | boolean | `true` | `false` stops asking before a git command discards uncommitted changes in this repo |
| `"gates"."deployImpact"` | `{ "paths": [glob…], "doc"?: "path" }` | off | A PR whose diff touches a matching path must carry a `Deploy impact:` line; `doc` is named in the message as where to record anything that is not `none` |

**Globs** are anchored at the repository root: `**` spans directories (`**/x` also matches `x` at
the root), `*` and `?` stay within one path segment, and a trailing `/` means everything below.

A file that is not valid JSON, has another `"version"`, or has a wrongly-typed `gates` is
**malformed**: the hook warns once per `gh` command, skips the repo gates, and never blocks
because of it.

## The gates

| Gate | Fires before | Applies | Blocks or asks when |
|---|---|---|---|
| Accidental closing keyword | `gh pr create`, `gh pr edit` | every repository, guest or adopted | blocks: a closing keyword sits in a negation, a code span, a fenced block or a blockquote |
| Duplicate-search record | `gh issue create` | adopted | blocks: the body lacks any of `Searched:`, `Candidates:`, `Verdict:` |
| Deploy impact | `gh pr create` | adopted, when configured | blocks: the branch touches a configured path and the body has no `Deploy impact:` line |
| Label taxonomy | after `gh issue/pr create/edit` | adopted | blocks: `lint-issue-labels.sh` reports a `FAIL` for the item |
| Default branch | `Edit`, `Write`, `MultiEdit`, `NotebookEdit`; `git commit`, `merge`, `cherry-pick`, `revert`, `am`; `git push` | adopted | asks: the file's checkout is on its default branch and git does not ignore the file; the commit lands on the default branch (not `merge --ff-only`, nor `--abort`, `--quit`, `--skip`); the push writes to it (`HEAD` or no refspec from it, a refspec naming it, a deletion of it, `--all`, `--mirror`) |
| Uncommitted-changes discard | `git checkout -f`, `-- <path>`, `.` or an existing path; `restore` (not `--staged` alone); `reset --hard`; `clean -f` (not `-n`); `switch -f`/`--discard-changes`; `stash drop`/`clear`; `worktree remove -f` | every repository, guest or adopted | asks: `git status` shows uncommitted work it would destroy — tracked changes, or for `clean` untracked files (and ignored ones with `-x`/`-X`), a stash for `stash`, any change in the worktree for `worktree remove` |

Closing keywords only act from PR descriptions and default-branch commit messages — never from an
issue body — so issue bodies are not checked.

**Ask** is a confirm prompt to the operator, with the reason, instead of a block. It appears in
every permission mode and for a subagent's tool call too: hooks fire for every agent, including one
that never loaded the skill. The operator's yes is the "unless the operator tells you to" that
rules 2 and 10 allow. Under headless `claude -p` the behaviour is not documented; expect the call
to be refused. A block from another gate on the same command wins.

The default-branch gate judges an edit by the checkout that holds the **file**, not the session's
directory, and a command by the directory it runs in, following `cd` and `git -C`. The default
branch is `origin/HEAD`'s target, else `main` or `master`. Anything it cannot determine — a
detached HEAD, a directory the shell expands — it lets through. The discard gate, when it cannot
tell what would be lost, asks with the command alone.

A gate that cannot run — no Node, `git`, `gh`, `jq` or `bash`, or a body it cannot read (on stdin,
or `--web`) — lets the command through. `/github-workflow:doctor` is how you find out.

## Switching a gate off

Switching a gate off is the operator's decision, never an agent's. An agent never changes the
plugin option or a `gates` key, and never reshapes a command, to get a blocked command through: it
fixes the body, or reports the block to the operator. An ask is the operator's to answer, not the
agent's to route around.

- **The closing-keyword gate, everywhere, for the operator:** the plugin option
  `closing_keyword_gate`. Inside Claude Code run
  `/plugin configure github-workflow@github-skills`; from a shell,

  ```bash
  printf '%s' '{"closing_keyword_gate":"false"}' | claude plugin configure github-workflow@github-skills --values-stdin
  ```

  `claude plugin configure github-workflow@github-skills` with no flag only shows the current
  values, and the CLI needs the full `name@marketplace` id. Claude Code passes the option to the
  hook as `CLAUDE_PLUGIN_OPTION_CLOSING_KEYWORD_GATE`; `false`, `0`, `no` or `off` disable the gate.
- **The discard gate, everywhere, for the operator:** the plugin option `discard_gate`, set the same
  way (`{"discard_gate":"false"}`). It reaches the hook as `CLAUDE_PLUGIN_OPTION_DISCARD_GATE`, with
  the same off values.
- **For one repository, for everyone:** a `gates` key in its config — `"closingKeywords": false`,
  `"discardChanges": false` or `"defaultBranch": false`. The default-branch gate has no plugin
  option: it only ever runs in a repository that adopted the protocol.

## The overlay

Decisions only one repository makes — its board's number and Status option names, which built-in
workflows it runs, severity examples in its own domain, what each area covers, deploy rules —
belong in `.github/GITHUB_WORKFLOW.md`, written from
[../assets/GITHUB_WORKFLOW.template.md](../assets/GITHUB_WORKFLOW.template.md). On a GitHub
question it outranks the skill; the repository's own engineering rules (`AGENTS.md`, `CLAUDE.md`,
`CONTRIBUTING.md`) outrank both.
