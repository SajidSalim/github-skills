# GitHub workflow — <repository name>

**Binding on every agent working this repo** — Claude, Codex, Gemini, Copilot, Cursor, Aider —
and on humans. If you are an agent and you have read this file, follow it without being reminded.

> **"The operator" means whoever is running you right now** — the person whose prompt you are
> executing. When a rule below says *ask the operator*, ask in your reply and wait.

This file is the **delta**: what is true of *this* repository. The workflow itself — the ten
rules, the duplicate search, claiming, branching, PRs, closing — is the `github-workflow` skill
(Claude Code plugin `github-workflow`; plain markdown, readable by any agent at
https://github.com/SajidSalim/github-skills/tree/main/plugins/github-workflow/skills/github-workflow).
On a GitHub question this file wins over the skill. The repository's engineering rules
(`AGENTS.md`, `CONTRIBUTING.md`) win over both.

## Repo constants

| | |
|---|---|
| Repository | `<owner>/<name>` |
| Default branch | `<main>` |
| Production | <what is live, and what data it holds — so agents know what "careful" means here> |
| Merges | <who merges; agents never do> |
| Commit attribution | <the convention for co-author trailers, if any> |

## Project board

<!-- Delete this section if the repo has no board (config "inFlightState": "labels"). -->

| | |
|---|---|
| Board | `#<number>` "<title>" — owner `<owner>` |
| Status options (verbatim) | `<Backlog>` · `<Ready>` · `<In progress>` · `<In review>` · `<Done>` |
| Agents have `project` write scope | <yes / no — read-only agents report state, never change it> |

Built-in workflows — the API returns only name and enabled state, never trigger or target, so
this table is the only record. Read them from the board's settings page; re-read when an
`updatedAt` moves.

| # | Workflow | Trigger | Effect | `updatedAt` |
|---|---|---|---|---|
| <n> | <Item added to project> | <issue or PR added> | <Status → Backlog> | <timestamp> |

**Who writes each Status value** — exactly one writer per transition:

| Moment | Status | Written by |
|---|---|---|
| Issue created | `<Backlog>` | <workflow / agent> |
| Triaged | `<Ready>` | a human |
| Picked up | `<In progress>` | <the agent, right after the pick-up comment> |
| PR opened | `<In review>` | <workflow "Pull request linked to issue", or the agent> |
| Closed | `<Done>` | <workflow> |

<If a Status value triggers a side effect — e.g. an "Auto-close issue" workflow on Done — say here
that agents never write it.>

## Severity in this domain

| | Definition | Examples here |
|---|---|---|
| sev-1 | Production down, data loss or corruption, money wrong, security breach, no workaround | <…> |
| sev-2 | Core flow broken for a segment, tenant or role; painful workaround | <…> |
| sev-3 | Bounded misbehaviour, clear workaround | <…> |
| sev-4 | Cosmetic, copy, rare edge case | <…> |

## Areas

| Label | Covers |
|---|---|
| `area:<name>` | <the directories, services or features it means> |

## Deploy rules

<What a PR touching deploy-sensitive paths must declare (the config's gates.deployImpact), where
production preconditions are recorded, and who marks them done. Delete if not applicable.>

## Failure modes seen here

<Repo-specific mistakes agents have made, each with the rule that now prevents it. Start empty.>
