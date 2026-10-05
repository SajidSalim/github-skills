---
name: doctor
description: Check whether the github-workflow plugin is fully working in this repository — tools, auth scopes, config, labels and hook health — and say how to fix anything that is not.
disable-model-invocation: true
---

# github-workflow doctor

**Read-only:** change nothing, create nothing. Run each check, then print one table — `ready`,
`warning`, `NOT RUNNING` or `n/a` per row, with the fix for every row that is not ready — and end
with a one-line verdict.

## 1. The hook's self-check

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/check-issue-workflow.mjs" --self-check --cwd "$(pwd)"
```

It reports Node, the mode (adopted / guest / config malformed), each gate, and whether `bash`,
`gh`, `jq` and the linter are reachable. **`node: command not found` means every gate is off** —
the hook exits quietly without Node rather than erroring on every command. Fix: install Node ≥ 18.

Two rows are for the gates that ask the operator rather than block. `branch gate` — before an edit,
commit or push on the default branch — reads `inactive here (guest mode)`, `off -- repo config` or
`on`. `discard gate` — before a git command discards uncommitted changes, in every repository —
reads `off -- plugin option discard_gate`, `off -- repo config` or `on`. Both need `git`:
`NOT RUNNING  git not found` means that gate lets everything through. Fix: put git's directory on
`PATH` as an absolute entry.

The `PATH` row reads `warning` when `PATH` has an empty or relative entry, and names it. Claude
Code starts the hook as `bash` by name, looked up on `PATH` in the session's directory before any
plugin code runs, so a program planted in the working directory could run in place of bash, node
or git. That happens when the entry (`.`, a leading `:`, a `::`) comes before bash's own
directory, or anywhere when bash is not installed; a trailing `:` is searched last. The gates still
work; the risk is the user's environment. Fix: remove those entries from `PATH` where it is set — a
shell profile, or the environment variables on Windows. The row reads the Bash tool's `PATH`, which
can differ from the one Claude Code itself has.

## 2. Tools

```bash
gh --version | head -1       # ≥ 2.50.0
jq --version                 # the real binary, ≥ 1.6 — `gh --jq` does not count
node --version               # ≥ 18
git --version
bash --version | head -1
```

`gh` has three tiers, so that no install is called ready for a flag it lacks. ≥ 2.50.0 is the floor
for the protocol (the duplicate search needs it). `--duplicate-of` and `--reason duplicate` need
≥ 2.88.0. `--parent`, `--add-sub-issue` and `--add-blocked-by` need ≥ 2.94.0. Report which tier the
installed version reaches.

Windows: `jq` installed with winget but "not found" means the process inherited a `PATH` from
before the install — restarting the editor usually does not fix it. Copy the binary into a
directory already on `PATH` (the skill's `references/gh-commands.md`, § NOT RUNNING).

## 3. Auth and scopes

```bash
gh auth status        # repo; read:project to read a board, project to move cards
gh api user -q .login
```

## 4. The repository and its config

```bash
gh repo view --json nameWithOwner,viewerPermission -q '.nameWithOwner + " " + .viewerPermission'
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cat "$ROOT/.github/github-workflow.json" 2>/dev/null || echo "no config — guest mode"
```

When the config exists, check it by reading it:

| Field | Ready when |
|---|---|
| `version` | `1` |
| `repo` | equals `nameWithOwner` above (any case) — otherwise `gh … --repo` commands lose the repo gates |
| `inFlightState` | `"labels"` or `"board"`, and matches reality — run the board query in `references/project-board.md` |
| `areas` | a non-empty array of lowercase names |
| `gates` | booleans; `deployImpact.paths` an array of globs |
| `gates.defaultBranch` | `true` or absent (on) — `false` stops the ask before an edit, commit or push on the default branch |
| `gates.discardChanges` | `true` or absent (on) — `false` stops the ask before a git command discards uncommitted changes here |
| any other key | unknown — warn; it is ignored |

## 5. Labels (adopted repos)

```bash
gh label list --limit 300 --json name -q '.[].name' | sort
bash "${CLAUDE_PLUGIN_ROOT}/skills/github-workflow/scripts/bootstrap-labels.sh" --dry-run
```

Every label the dry run lists must exist. A board repo must **not** have `status:in-progress` or
`status:needs-review`. List any stock labels that shadow the taxonomy. Fix for missing labels:
`/github-workflow:setup` (idempotent).

## 6. The closing-keyword gate

On unless the plugin option `closing_keyword_gate` is off, or the config sets
`"gates": { "closingKeywords": false }`. The self-check's `closing gate` row shows the repo switch
only: run from the Bash tool it is outside the hook, so the plugin option never reaches it. Read
the option with `claude plugin configure github-workflow@github-skills` (display only) and report
both — on/off, and whether by user option or repo config. To change it:
`/plugin configure github-workflow@github-skills` inside Claude Code, or pipe
`{"closing_keyword_gate":"false"}` to `claude plugin configure github-workflow@github-skills --values-stdin`.

## 7. The discard gate

On unless the plugin option `discard_gate` is off, or the config sets
`"gates": { "discardChanges": false }`. It asks the operator before `git checkout -- <path>`,
`restore`, `reset --hard`, `clean -f`, `switch --discard-changes`, `stash drop`/`clear` or
`worktree remove -f` would destroy uncommitted work, in every repository. As in §6, the self-check's
`discard gate` row shows the repo switch only: read the option with
`claude plugin configure github-workflow@github-skills` (display only) and report both — on/off,
and whether by user option or repo config. To change it: `/plugin configure
github-workflow@github-skills` inside Claude Code, or pipe `{"discard_gate":"false"}` to
`claude plugin configure github-workflow@github-skills --values-stdin`.

## 8. The AGENTS.md pointer reaches Claude

```bash
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
grep -q '^## GitHub workflow' "$ROOT/AGENTS.md" 2>/dev/null && [ -f "$ROOT/CLAUDE.md" ] \
  && ! grep -qE '^@(\./)?AGENTS\.md[[:space:]]*$' "$ROOT/CLAUDE.md" && echo "CLAUDE.md does not import AGENTS.md"
```

When `AGENTS.md` holds the snippet and a `CLAUDE.md` exists without an `@AGENTS.md` line, report it:
Claude Code reads `AGENTS.md` on its own only when there is no `CLAUDE.md`, so the pointer never
reaches Claude here. Fix: add the line `@AGENTS.md` to `CLAUDE.md` (`/github-workflow:setup`
proposes it). `n/a` when there is no snippet or no `CLAUDE.md`.

## Report

| Check | Status | Detail / fix |
|---|---|---|
| … | ready / warning / NOT RUNNING / n/a | … |

Verdict: **all gates live**, or the single most important fix first.
