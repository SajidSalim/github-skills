---
name: github-workflow
description: >
  Use when creating, triaging, picking up, implementing, reviewing or closing a GitHub issue —
  feature, enhancement, bug, security finding or chore — or when naming a branch, writing a
  commit message, opening a pull request, applying labels or severity, or syncing a GitHub
  Projects board. Applies to any coding agent, not one vendor's.
license: MIT
---

# GitHub workflow for coding agents

Agent-neutral — "you" is whichever agent is executing, or a human following the same discipline.
**The operator** is whoever is running you right now: when a rule says *ask the operator*, ask in
your reply and wait.

Needs `git`; GitHub CLI `gh` ≥ 2.50.0 authenticated with repo scope (its `gh issue list --json` has
the `stateReason` the duplicate search needs, from cli/cli PR #9080; older builds, such as Ubuntu
24.04's 2.45.0, cannot run that gate); and the real `jq` ≥ 1.6 (`gh --jq` is a different, embedded one).

The scripts live in this skill's `scripts/` directory, and §11 gives each one's command. Run them
as `bash "${CLAUDE_SKILL_DIR}/scripts/<name>.sh"`, never `./`: git on Windows does not record the
executable bit. In `references/` and `assets/`, `<skill-dir>` means `${CLAUDE_SKILL_DIR}`. A repo
that installed copies with `/github-workflow:setup` also has them under `.github/scripts/` for
other agents.

## 0. What overrides what — and which mode you are in

1. **Repo engineering and safety rules** — `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`. **Never
   overridden by anything here.** "Never commit without asking" holds inside every procedure below.
2. **The repo's GitHub overlay** — `.github/GITHUB_WORKFLOW.md`, if it ships one. On a GitHub
   question it wins: it has already made these decisions for this repo.
3. **This skill.**

**Mode.** The repo has **adopted** this workflow when `.github/github-workflow.json` exists at its
root ([references/configuration.md](references/configuration.md)). Then everything below applies,
and the plugin's hooks enforce the duplicate-search record and the label taxonomy. Otherwise you
are a **guest**: §10 — the rules still bind, the taxonomy does not.

Paths are relative to the repository root, not your working directory, which may be a subdirectory:

```bash
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
head -80 "$ROOT/AGENTS.md" "$ROOT/CLAUDE.md" "$ROOT/CONTRIBUTING.md" 2>/dev/null  # safety rules — always apply
head -80 "$ROOT/.github/GITHUB_WORKFLOW.md" 2>/dev/null       # this repo's GitHub decisions
cat "$ROOT/.github/github-workflow.json" 2>/dev/null || echo "guest mode — see §10"
```

## 1. Non-negotiables

1. **Never create an issue without asking.** Propose it, show the title and labels you intend, wait
   for a yes. **Search before you propose (§4.0) and show what you found** — an unsearched proposal
   is incomplete, and a hit closed as a decision is not yours to overturn. §3 has the one case where
   the answer is already known.
2. **Never edit, commit to or merge into the default branch** unless the operator tells you to, for
   that change. One branch per unit of work, a PR into the default branch, report it, stop. A human
   merges. **Never switch the branch of a checkout you did not create** — if it has changes you did
   not make, ask, or work in a worktree (§5.4).
3. **Read the thread before you claim an item.** Another agent may already be on it. §5.1 is the
   check and it is not optional — the assignee field alone will not tell you.
4. **GitHub is the record.** State lives on the issue, not in your context, not in a local scratch
   file. If it isn't in a comment, it didn't happen.
5. **Comment when you start, comment when you finish** — not batched at the end. **Write every record
   at a moment you are present for:** rule 2 ends your involvement at PR-open, so the implementation
   comment is the complete record, not an interim note.
6. **Every issue you work carries the commit or PR that implemented it** before it is closed.
7. **Every issue closes with a written explanation reachable from the issue.** A merged PR with a real
   body satisfies this — GitHub links it as "Closed via #45". A bare closing keyword with nothing
   behind it does not. When an issue closes **without** a merged PR, you write the explanation,
   because closing is then your own action and you are there to do it.
8. **One issue = one problem.** A second problem is a second issue (rule 1).
9. **Never close an issue you did not verify.** "Tests pass" is verification; "should work" is not.
10. **Never run a command that discards uncommitted changes** — `git checkout -- <path>`, `restore`,
    `reset --hard`, `clean -f`, `switch --discard-changes`, `stash drop`/`clear`, `worktree remove -f`
    — unless the operator tells you to: they may not be yours. To undo your own misplaced edit, save
    a patch first (`git diff -- <paths> > <file>`) and ask. In both cases the plugin's hook asks the
    operator before such a discard, in every repository — as it does before an edit, commit or push
    on the default branch (rule 2), in adopted ones.

## 2. Session start

Run once per session, before the first GitHub action — not once per action.

```bash
gh auth status                                                    # authenticated?
gh api user -q .login                                             # who am I acting as
gh repo view --json nameWithOwner,defaultBranchRef,viewerPermission \
  -q '.nameWithOwner + "  default=" + .defaultBranchRef.name + "  permission=" + .viewerPermission'
gh label list --limit 100                                         # what labels exist
```

Then the board check. **It must be repo-scoped. Never `gh project list`, never `viewer.projectsV2`** —
both key on a login, so a board owned by someone else returns empty output and exit 0,
indistinguishable from no board. The `owner:` below is the **repository's** owner, which is why it is
derived rather than typed. Measured evidence:
[references/project-board.md](references/project-board.md) § "Why not `gh project list`".

```bash
read -r OWNER NAME <<<"$(gh repo view --json owner,name -q '.owner.login + " " + .name')"
if BOARDS=$(gh api graphql -f query="{ repository(owner: \"$OWNER\", name: \"$NAME\") {
      projectsV2(first: 10) { nodes { number title } } } }" \
      --jq '.data.repository.projectsV2.nodes[] | "#\(.number) \(.title)"' 2>&1); then
  [ -z "$BOARDS" ] && echo "no board — labels-only mode" || echo "board(s): $BOARDS"
else
  echo "UNKNOWN — could not determine board state"
fi
```

| Outcome | Means | Do |
|---|---|---|
| Exit 0, empty | No board linked to this repo | **Labels-only mode.** Skip every board step; use `status:` labels |
| Exit 0, rows | A board exists | Follow [references/project-board.md](references/project-board.md), and stop using `status:` labels |
| **Non-zero** | **Unknown** | **Not "no board" — an error is not an answer.** Report it and ask |

**Never invent a label.** If one you need does not exist, say so and offer to run
`bash "${CLAUDE_SKILL_DIR}/scripts/bootstrap-labels.sh"`; never silently substitute a near-match.
In guest mode never create labels — use the repo's own. GitHub's stock labels (`bug`,
`enhancement`, `duplicate`, `wontfix`, `documentation`, `question`) are **not** part of the
taxonomy and shadow it — never apply them.

## 3. Does this need an issue?

| Situation | Issue? |
|---|---|
| User asks for a **feature** or **enhancement** | **Yes** — propose it, get a yes, create it, then work it |
| User points you at an **existing issue** | No new issue — work that one |
| Bug **you found** reviewing or testing already-committed code | **Ask.** "Open an issue, or fix it now?" Never decide alone |
| Bug in **your own in-flight, uncommitted work** | **No issue.** It is not a defect yet. Fix it and carry on |
| Fix requested while the user is testing your uncommitted change | **No issue.** Same reason |
| Typo, formatting, comment, dependency bump with no behaviour change | No issue — but still branch + PR |
| Second problem discovered mid-implementation | **Ask.** Default is a separate issue, not scope creep. Never roll an unrelated fix into the branch because you were already in the file |

The rule under the table: **an issue records work that outlives the moment.** Work that begins and
ends inside one uncommitted change is not that. When unsure, ask.

## 4. Creating an issue

Body templates per type, worked examples, acceptance-criteria tests:
[references/issue-authoring.md](references/issue-authoring.md). Label meanings:
[references/labels.md](references/labels.md).

### 4.0 Search first — this is a gate

On a repo with a few hundred open issues, filing without searching produces a duplicate by default.
Run `bash "${CLAUDE_SKILL_DIR}/scripts/find-duplicates.sh" "<the title you intend to file>"`
**before you propose the issue**, and show the operator what it found. **Always search all states** —
the closed issues carry the decisions, and open-only is exactly what lets a settled one get refiled.
Term selection, the four-query battery and the full adjudication table:
[references/duplicate-check.md](references/duplicate-check.md).

**Three findings need different handling, and only one of them is a duplicate:**

| The search finds | It is | Do |
|---|---|---|
| An **open** issue on the same subject | A duplicate | Do not file. Add your evidence to that issue |
| A **closed-as-fixed** issue | A **regression** | File a new issue, link the original, name the commit that fixed it before |
| A closed issue with a `resolution:` label | **An adjudicated decision** | **Stop.** Show the operator the link and the stated reason, and ask what changed. Never silently refile a `wontfix` or `works-as-intended` — that asks a human to make the same decision twice without knowing they already made it |
| An issue that overlaps partially | A scope relationship | [references/relationships.md](references/relationships.md) — `--parent`, not a duplicate. Closing a partial overlap as a duplicate destroys the scope difference |

Record the search **in the proposal and in the issue body** — three required lines: `Searched:` (the
actual queries, re-runnable), `Candidates:` (every hit considered and rejected, with state and
`resolution:` label, or `none`), and `Verdict:`. Format:
[references/duplicate-check.md](references/duplicate-check.md) § "Record what you searched". Same
reason as `Thread checked:` in §5.3 — **a mandated check that leaves no trace cannot be told apart
from one that was skipped.**

**If you cannot run the search yourself** — no shell, no `gh` access, no repository yet — say so and
still show the whole draft: title, labels, body, with the `Searched:` lines marked as not yet run.
**End by asking the operator to approve it.** Nothing is created until the search has run and the
operator has said yes.

**Where the plugin's hook is active** (adopted repos, Claude Code), a `gh issue create` missing
those lines is blocked. It sees only that the block *exists*, never that you ran the searches — it
raises the cost of skipping, it does not remove the obligation. `/github-workflow:doctor` confirms
the gates are live; without `jq` the taxonomy half degrades to a silent pass.

**Title** — the problem or the capability, never the solution or the effort: symptom **and**
trigger for a bug, ≤ 70 characters where it can be, no `Fix`/`Add` prefix on a bug, and a
`[SEV-1]`/`[SEV-2]` prefix for those two severities only. **Body** — what, why it matters, and how
anyone else would confirm it; for a bug, reproduction steps, or an explicit "cannot reproduce" plus
`status:needs-info`. Every issue ends with **acceptance criteria as checkboxes**, each testable.
Formulas, templates and good/bad examples: [references/issue-authoring.md](references/issue-authoring.md).

**Labels.** Exactly one `type:`. Exactly one `priority:`. Exactly one `severity:` on every `type:bug`
and `type:security` (optional elsewhere). One or more `area:`. `status:needs-triage` if you are not
sure of priority — that is the honest label, and a guessed `priority:` is worse than an absent one.

```bash
gh issue create \
  --title "[SEV-2] Checkout returns 500 when the coupon code is blank" \
  --body-file issue.md \
  --label "type:bug,severity:sev-2,priority:p1,area:checkout"
```

Write the body to a file and pass `--body-file` — inline `--body` mangles multi-line markdown in most
shells; delete the file afterwards. Prefer `gh --label` over a web issue form, which applies only its
fixed `labels:` list and cannot set severity, priority or area ([assets/ISSUE_TEMPLATE/](assets/ISSUE_TEMPLATE/)).

## 5. Picking up an item

Four actions, in this order, before you write a line of code.

**5.1 — Read the thread and check nobody else has claimed it.** The step that stops two agents
colliding, and the one most often skipped.

```bash
gh issue view 231 --comments                                    # every comment, oldest to newest
gh issue view 231 --json assignees,labels,state \
  -q '{state, assignees: [.assignees[].login], labels: [.labels[].name]}'
gh issue develop 231 --list                                     # branches already linked to it
```

**The assignee field is not the check.** Most agents run through the *same* authenticated account, so
`@me` resolves identically for all of them and an issue another agent claimed ten minutes ago looks
assigned to *you*. Assignee proves nothing about collision; the comments do.

An item is **claimed** when the thread has a pick-up comment with no later "Implemented", "Resolved",
"Blocked" or "Handover" from the same author — regardless of who is assigned. A `status:in-progress`
label, or a linked branch from `gh issue develop --list`, also means claimed.

| What you find | Do |
|---|---|
| No pick-up comment, no `status:in-progress`, no linked branch | It is free. Continue to 5.2 |
| A pick-up comment, no closing comment after it | **Claimed. Stop and ask the operator** — do not start, do not reassign |
| A pick-up comment followed by "Blocked" or "Handover" | Resumable. Say in your own pick-up comment that you are continuing from it, and name the branch it left behind |
| A pick-up comment followed by "Implemented" | Work is done and awaiting review. Ask before touching it |
| Assigned to a **different** account, no comments | **Stop and ask.** Someone's assignment is a claim even unexplained |
| Assigned to the login **you** authenticate as, no comments | Uninformative — that is just the shared account. No comment claim means free; note the existing assignee in your pick-up comment |
| Anything ambiguous | Ask. One question costs less than two agents on one branch |

Stale claims are the operator's call, not yours. A three-week-old pick-up comment may be abandoned or
may be someone's long-running branch — you cannot tell, so ask rather than assume.

**5.2 — Assign yourself:** `gh issue edit 231 --add-assignee "@me"`. `@me` resolves to whatever
account is authenticated, so this works for a user token or a bot. Already assigned to *a different*
account? **Stop and ask** — do not reassign. Weak signal alone; 5.1 is the real check.

**5.3 — Comment that you are picking it up:** `gh issue comment 231 --body-file pickup.md`.
Immediately after assigning, **before any code** — this is what the next agent reads in 5.1, so
posted after the work it is worthless.

**~600 characters.** It must state the plan, the branch name, the scope, your assumptions, and any
question blocking you — and carry a **`Thread checked:`** line saying what 5.1 actually found,
including when you are resuming someone's handover. That line is how the operator and the next agent
see the check happened. Template: [assets/comment-templates.md](assets/comment-templates.md) §1.

If the plan differs from what the issue asks for, say so **here** and wait. Do not quietly redesign.

**5.4 — Create the branch, linked to the issue.** Run `git status` first. If the checkout has
changes you did not make, or is not yours, do not switch it (rule 2): create the branch without
`--checkout` and work in a worktree.

```bash
gh issue develop 231 --name fix/231-checkout-blank-coupon --checkout
# not your checkout, or changes in it you did not make:
gh issue develop 231 --name fix/231-checkout-blank-coupon
git fetch origin fix/231-checkout-blank-coupon
git worktree add ../231-checkout-blank-coupon fix/231-checkout-blank-coupon
```

`gh issue develop` registers the branch in the issue's Development panel; a plain `git checkout -b`
does not. Naming: `<type>/<issue-numbers>-<slug>`, types `feat` `fix` `chore` `docs` `refactor`
`test` `perf` `security` `spike`; slug lowercase kebab-case, ≤ 5 words.

⚠️ **That linkage closes the issue on merge, whatever your keywords say.** Merging a PR from a
branch created with `gh issue develop N` closes issue N automatically, **independently of any
closing keyword** — a second, invisible closing channel that leaves no trace in the PR. It has
closed an issue a PR body explicitly kept open with `Refs`
([references/gh-commands.md](references/gh-commands.md) § "Branching").

**So link an issue only if merging this PR should certainly close it.** If it might not — a
reproduction you may not achieve, a criterion you may not finish — branch with plain git
(`git worktree add -b` in a checkout not yours) and forgo the Development panel, or expect to reopen
it and say why. This is the second shape of *something other than your intent closed the issue*;
the first is §7's substring trap. Both defeat rule 7.

**Multiple issues, one branch** — allowed when the user hands you several to work together. Name it
after all of them (`feat/231-244-per-region-shipping`), post a pick-up comment on **every** issue in
the set naming the shared branch, and make sure the PR body closes all of them (§7). If the user
named exactly one issue, it is one branch and one PR.

`gh issue develop` takes exactly **one** issue number, so on a multi-issue branch exactly one issue
acquires that auto-close and the others do not. **Give it the one that will certainly close** — if
any issue in the batch might stay open, it must not be the linked one. The pick-up comment goes on
every issue either way; the comment is the claim, the link is not.

**The plugin's hook does not check this:** a branch legitimately carrying issues that stay open is
normal, and reading the real branch↔issue link costs an API round-trip per PR. The rule is yours.

**Board repos:** after the pick-up comment, move the card to the board's in-progress Status if the
overlay says agents write it — §9.

## 6. While implementing

Conventional Commits, because tooling and humans both parse them:

```
<type>(<scope>): <imperative summary, no trailing period>

<why the change was needed — not what the diff shows>

Refs #231
```

- Types: `feat` `fix` `chore` `docs` `refactor` `test` `perf` `style` `build` `ci` `revert`
- Breaking change: `feat(api)!: …` plus a `BREAKING CHANGE:` footer
- Use `Refs #231` in commits. Keep the **closing** keyword for the PR body only (§7) — in both it
  double-links, and on a non-default branch it silently does nothing.
- Commit when something works, not when everything does. Small commits survive review.
- Commit attribution — co-author trailers and the like — follows the repo's convention:
  `AGENTS.md`/`CONTRIBUTING.md` decide, not this skill.

Tests are part of the implementation, not a follow-up. An issue that changes behaviour and adds no
test is not done.

## 7. Opening the PR and reporting back

```bash
gh pr create --title "fix(checkout): treat a blank coupon code as no coupon" \
             --body-file pr.md --label "type:bug,area:checkout"
```

**Label the PR.** Exactly one `type:` and at least one `area:`, mirroring the issue it resolves.
`priority:` and `severity:` belong to the issue — they describe the problem, not the branch that
fixes it. In adopted repos the plugin enforces this on `gh pr create`/`edit`, not merely advises it.

The PR body **must** carry a closing keyword **per issue** — the keyword does not distribute across a
list: `Closes #231, closes #244` ✅ · `Closes #231, #244` ❌ (only #231 links). Keywords: `close`
`closes` `closed` `fix` `fixes` `fixed` `resolve` `resolves` `resolved`. Cross-repo:
`Closes owner/repo#100`. **The PR must target the default branch for auto-close to fire** — on any
other base the keyword is ignored entirely.

⚠️ **The scanner matches substrings and does not read negations.** `does not close #NNN` **closes
#NNN on merge**, and so does a keyword in a code span, fenced block, blockquote or quoted example,
or in a commit message once it lands on the default branch. For partial work write `Refs #NNN` or
`Part of #NNN` and explain underneath. The plugin's hook blocks these on `gh pr create`/`edit` in
every repo.

**Put the substance in the PR body** — what changed, why this approach, root cause, the full test log.
That is where reviewers read, and once it merges that body **is** the closing explanation rule 7
requires. There is no second chance: nobody is there to write one.

Then comment on the issue, and write it as **the complete record, not an interim note**.
**~800 characters, and do not restate the PR body.** The issue reader needs which PR and commit,
which acceptance criteria are met, what was left out, and the risk — everything else is one click
away. **Copy the criteria verbatim; never tick a box you did not verify.** Template:
[assets/comment-templates.md](assets/comment-templates.md) §2.

Correction needed? It goes **here**, not at close (§8) — you know it now and you will not be there
later. Then **stop**. Do not merge. Report the PR number and wait.

### 7.1 After the PR is open

Stopping does not mean the work is over — it means you do not merge. What comes back:

| What happens | Do |
|---|---|
| **A check goes red on your own PR** | Fix it on the same branch and push. This is **not** a new issue — it is your in-flight work (§3). Comment on the issue only if the fix changed what was implemented |
| **Review comments arrive** | Push fixes to the same branch, reply per thread. Never force-push over a reviewer's context without saying so in a comment first |
| **The branch conflicts with the default branch** | Resolve, re-run the repo's precommit checks, rebuild assets if CSS or JS moved. Say in a comment that you rebased or merged |
| **A reviewer asks for something outside the issue's scope** | That is a new issue — rule 1. Say so in the thread rather than quietly widening the branch |
| **The PR sits with no response** | One comment. Then it is the operator's call. Do not nudge by re-pushing |
| **The PR is closed unmerged** | Say so on every linked issue — one comment naming the PR and why it was abandoned — then **remove yourself as assignee**, so §5.1 stops reading the item as claimed |

**Labels-only mode:** on PR open swap `status:in-progress` for `status:needs-review` (never both —
§9); it stays on the issue until the PR merges. **When a board exists**, skip that label entirely —
the board's Status field owns it instead (§9). Either way, never `gh pr merge`.

## 8. Closing an issue

Close only after the fix is merged and verified, or after a decision not to do it. **Most issues you
work need no closing comment from you** — the PR merges, the keyword closes the issue, and the merged
PR is the explanation rule 7 asks for. You are not present for that moment, which is why the §7
comment had to be the complete record.

| Closing | Comment? |
|---|---|
| A merged PR with a real body | **No.** GitHub links it. Writing one repeats the PR |
| `wontfix` · `duplicate` · `cannot-reproduce` · `works-as-intended` | **Yes** — nothing else says why, and you are present because closing is your action |
| A fix that landed with no PR | **Yes** |
| You merged the PR yourself on the operator's instruction | Optional — only what the PR body does not already say |

**~600 characters when you do write one**, covering root cause (the mechanism, not the symptom), the
fix, what resolved it, verification, and residual risk. Templates and the full rationale:
[assets/comment-templates.md](assets/comment-templates.md) §3.

**If what you found differs from what the issue describes, correct the record** — a wrong hypothesis,
wrong reproduction steps, the wrong problem entirely, or the wrong scope. Post it in the §7
implementation comment as soon as you know; you will not be here at close. If the issue does get a
closing comment it goes at the *top*, before Root cause, because a reader has to know the body is
unreliable before they read anything that cites it.

Format and the four constraints — split accurate from inaccurate, the `Actual terms` line is what
re-indexes the issue for the next §4.0 search, comment only and never edit a title or body a human
wrote, and a different defect is a different issue (rule 1):
[assets/comment-templates.md](assets/comment-templates.md) §3a.

**Closed without a fix** — state which and why:

```bash
gh issue close 231 --reason "not planned" --comment "Superseded by the promotions rework — see #312."
gh issue close 231 --reason completed --comment "…"
```

`--reason` accepts `completed`, `not planned` or `duplicate`. **Every close that is not a normal fix must carry a
`resolution:` label** — `resolution:duplicate`, `resolution:wontfix`, `resolution:cannot-reproduce`
or `resolution:works-as-intended`. That label is what lets a future §4.0 search tell an adjudicated
decision from an old fix without opening the issue; without it the next agent cannot classify the hit
and has to interrupt the operator. For a duplicate prefer `--duplicate-of` and always name the
survivor: `Duplicate of #198.` `--duplicate-of` and `--reason duplicate` need `gh` ≥ 2.88.0; on an
older `gh`, use `gh issue close N --reason "not planned" --comment "Duplicate of #M."` plus the
`resolution:duplicate` label, which is required either way. **Before** closing a duplicate, move
anything the survivor lacks onto it as a comment on the survivor — a better reproduction, a second
occurrence, a wider impact — and only then close: evidence left on a closed duplicate is lost to the
next reader of the survivor ([references/relationships.md](references/relationships.md)).

Closing with **nothing reachable from the issue** is a rule-7 violation.

## 8b. Relating issues to each other

`gh` sets four kinds of link: duplicate links need `gh` ≥ 2.88.0, and `--parent`, `--add-sub-issue`
and `--add-blocked-by` need ≥ 2.94.0. Use them, not prose — a real relationship renders in the UI,
is queryable, and survives the thread scrolling away. On an older `gh`, use a cross-link comment.

| Situation | Command |
|---|---|
| Same problem, same scope | `gh issue close N --duplicate-of M` + `resolution:duplicate` |
| A narrower slice of a bigger issue | `gh issue edit N --parent M` |
| An umbrella over several | `gh issue edit M --add-sub-issue N,O,P` |
| Cannot start until another ships | `gh issue edit N --add-blocked-by M` |
| Same area, independent | Cross-link in a comment. Not every mention is a relationship |

Sub-issues are the sanctioned replacement for `wave:`/`phase:` labels. `--add-blocked-by` is for
blockers that are GitHub issues, `status:blocked` for everything else — never both for one block.
Detail: [references/relationships.md](references/relationships.md).

## 9. Project board

§2 tells you at runtime whether one exists — **repo-scoped, never `gh project list`**. When one
does, read [references/project-board.md](references/project-board.md) § "Who moves the cards"
before writing to it:

- **Decide one writer per transition**, not one per board. Built-in workflows typically own entry
  and exit, a human owns any triage column, and the agent owns what is left if it holds `project`
  scope. Enumerate the triggers first: a *Pull request linked to issue* workflow moves the card the
  instant a PR body says `Closes #231`. Two writers on one transition is the failure; two on
  different transitions is a division of labour.
- **Find out what a Status value triggers before writing it.** An *Auto-close issue* workflow
  closes the issue when Status reaches its target — a dropdown that violates rule 7.
- **Read the board's actual Status option names first.** They are per-board, rarely match the
  obvious mapping, and a value that matches no option is rejected.

In labels-only mode the equivalent is the `status:` label, which holds **one value at a time —
swap, never stack**: `gh issue edit 231 --remove-label <old> --add-label <new>`. On pick-up,
`status:in-progress` (replacing `status:needs-triage` only once the operator has set a `priority:`);
on PR open, `status:in-progress` → `status:needs-review`; when blocked, `status:in-progress` →
`status:blocked`; on close, remove it. **When a board exists, drop `status:in-progress` and
`status:needs-review`** — two sources of truth is worse than one. `status:needs-triage`,
`status:needs-info` and `status:blocked` carry meaning a Status field does not, so they survive
either way.

## 10. Guest mode — the repo has not adopted this workflow

No `.github/github-workflow.json`. The rules in §1 still bind; the taxonomy and the paperwork
adapt to the repo:

| | In guest mode |
|---|---|
| Labels | The repo's **existing** labels and conventions. Never create labels, never run `bootstrap-labels.sh` |
| Filing | Still ask first (rule 1), and still search all states first (§4.0) and show the operator what you found. Use the repo's own issue templates; the `Searched:` block goes in your proposal, and in the body only if the template has room |
| Claiming | Still read the thread (§5.1). In a repo the operator does not maintain, **ask before posting** pick-up or implementation comments — many projects have their own etiquette. The same goes for self-assigning (§5.2) and `gh issue develop` (§5.4), which creates a branch in their repository: ask first. In one they maintain, post them |
| Branches | The repo's documented naming convention, else §5.4's |
| PRs | §7's closing-keyword rules unchanged — one keyword per issue, never beside a negation, a quote or code; labels per the Labels row above (the repo's own) |
| Board | Only as the repo's own docs describe; never write a Status you were not told to |
| Adoption | Once per session, and only if `viewerPermission` is `WRITE` or above, mention: "This repo has not adopted the github-workflow protocol — `/github-workflow:setup` sets it up." |

## 11. Reference index

These are plain markdown and plain `bash`. Any agent can read and run them — nothing here is specific
to one vendor's tooling.

| File | Read it when |
|---|---|
| [references/duplicate-check.md](references/duplicate-check.md) | **Before filing anything** — the search protocol, term selection, adjudicating a hit |
| [references/relationships.md](references/relationships.md) | Two issues overlap, one blocks another, or one contains another |
| [references/labels.md](references/labels.md) | Choosing type, severity, priority or area; setting a repo's labels up |
| [references/issue-authoring.md](references/issue-authoring.md) | Writing an issue title or body — title formulas, full templates per type, good vs bad examples |
| [references/gh-commands.md](references/gh-commands.md) | You need the exact command or flag for anything above |
| [references/project-board.md](references/project-board.md) | A Projects v2 board exists and needs updating |
| [references/configuration.md](references/configuration.md) | Modes, the repo config and the gates — what is enforced where |
| [assets/comment-templates.md](assets/comment-templates.md) | Writing **any** issue comment — pick-up §1, implementation §2, resolution §3, correction §3a, closing-without-a-fix §4, blocked §5, handover §6 (which is what releases your claim) |
| [assets/ISSUE_TEMPLATE/](assets/ISSUE_TEMPLATE/) + [assets/pull_request_template.md](assets/pull_request_template.md) | What `/github-workflow:setup` installs into a repo |
| [assets/GITHUB_WORKFLOW.template.md](assets/GITHUB_WORKFLOW.template.md) | Writing a repo's overlay |
| [scripts/find-duplicates.sh](scripts/find-duplicates.sh) | Running the §4.0 duplicate check: `bash "${CLAUDE_SKILL_DIR}/scripts/find-duplicates.sh" "<title>"` |
| [scripts/lint-issue-labels.sh](scripts/lint-issue-labels.sh) | Checking issues against the taxonomy — one, or the backlog with `--all` (stops at `--limit`, default 500, and says so): `bash "${CLAUDE_SKILL_DIR}/scripts/lint-issue-labels.sh" <n> [--pr]` |
| [scripts/bootstrap-labels.sh](scripts/bootstrap-labels.sh) | The repo's labels do not exist yet: `bash "${CLAUDE_SKILL_DIR}/scripts/bootstrap-labels.sh" --dry-run` |

Run every script as `bash <path>`, never `./`. They need `gh` and the real `jq`: the duplicate and
lint scripts always, `bootstrap-labels.sh` when it reads a repo's config.
