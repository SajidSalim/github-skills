# Label taxonomy

Script paths are relative to the skill directory, written `<skill-dir>` (the skill resolves it); a repo that installed copies with `/github-workflow:setup` also has them under `.github/scripts/`.

Five prefixed dimensions plus a resolution marker. Prefixes exist so a label list stays readable at
200 labels, and so `gh issue list --label "severity:sev-1"` is unambiguous.

| Dimension | Cardinality | Applies to |
|---|---|---|
| `type:` | exactly one | every issue |
| `severity:` | exactly one | required on `type:bug` and `type:security`; optional elsewhere |
| `priority:` | exactly one | every issue (use `status:needs-triage` instead if genuinely unknown) |
| `area:` | one or more | every issue |
| `status:` | zero or one | in-flight state, and only in labels-only mode |
| `resolution:` | zero or one | set at close, when the close was not a normal fix |

---

## `type:` — what kind of work this is

| Label | Meaning | Not this |
|---|---|---|
| `type:feature` | A capability that does not exist today | Improving something that already works |
| `type:enhancement` | Existing behaviour made better, faster or clearer | Anything the user would call broken |
| `type:bug` | Behaviour differs from documented or intended behaviour | "I'd prefer it worked differently" — that's an enhancement |
| `type:security` | Vulnerability, exposure, or hardening | A crash with no security consequence |
| `type:chore` | Dependencies, build, tooling, config, release plumbing | Anything a user would notice |
| `type:docs` | Documentation only | Code changes that happen to touch docs |
| `type:refactor` | Internal restructuring, no behaviour change | Anything with a user-visible diff |
| `type:test` | Test coverage or test infrastructure only | Tests written alongside a fix — those belong to the fix |
| `type:spike` | Timeboxed investigation; the deliverable is a decision or another issue | Open-ended research with no timebox |

**feature vs enhancement** is the boundary people get wrong. Ask: if this ships, does the product
do something it could not do before? Yes → feature. No, it does the same thing better → enhancement.

---

## `severity:` — how bad it is when it happens

Severity is a property of the defect. It does not move because the schedule is busy.

| Label | Name | Definition | Examples |
|---|---|---|---|
| `severity:sev-1` | Critical | Production down, data loss or corruption, money moves incorrectly, security breach, or a core flow is impossible. **No workaround.** | Checkout down for every customer; a payment captured twice; account A sees account B's orders |
| `severity:sev-2` | High | A core flow is broken for a customer segment, tenant, role or platform. A workaround exists but is painful or manual. Reporting or reconciliation is wrong but recoverable. | Order-export totals wrong; one region cannot check out; login fails for one role |
| `severity:sev-3` | Medium | A feature misbehaves in a bounded way. Clear workaround. Limited blast radius. | Filter ignores one option; timestamp shows in the wrong timezone on one screen |
| `severity:sev-4` | Low | Cosmetic, copy, minor UX friction, or a rare edge case with negligible impact. | Misaligned badge; typo in a tooltip |

Titles for `sev-1` and `sev-2` carry a `[SEV-1]` / `[SEV-2]` prefix so they are visible without
opening the list filter. `sev-3` and `sev-4` carry the label only — prefixing everything makes the
prefix meaningless.

**Data loss, money, and leakage across accounts or tenants are always sev-1**, regardless of how few users hit them.

---

## `priority:` — when we act on it

Priority is a scheduling decision and *may* be changed by a human at any time. Severity may not.
A sev-1 in a feature nobody has enabled yet can legitimately be p2. A sev-4 that a paying client
complains about weekly can legitimately be p1. Do not collapse the two.

| Label | Meaning |
|---|---|
| `priority:p0` | Drop everything. Someone is working on it now. |
| `priority:p1` | Committed, current cycle. |
| `priority:p2` | Planned, next cycle. |
| `priority:p3` | Backlog. Will be done if it stays relevant. |

If you cannot justify a priority, apply `status:needs-triage` and leave priority off. A guessed
priority is worse than an absent one — it looks like a decision was made.

---

## `area:` — which part of the system

Repo-specific. Keep them mutually intelligible, not mutually exclusive: an issue may carry two or
three. Generic starter set:

`area:api` `area:ui` `area:db` `area:auth` `area:infra` `area:integrations` `area:docs` `area:ci`

Repo-specific areas live in `.github/github-workflow.json` (`"areas"`), and `bootstrap-labels.sh` creates exactly that set; the generic eight are its default when no config or `--areas` names others. A store might use `area:checkout` `area:catalog` `area:payments` `area:search` alongside `area:ci` and `area:docs`.

Add an area label rather than stretching an existing one. Areas are cheap; wrong areas are not.

---

## `status:` — in-flight state, labels-only mode

**`status:in-progress` and `status:needs-review` are for labels-only mode only.** Once a board
exists, the board's Status field is the single source of truth and those two are removed — two places
to look for the same fact is how state goes stale.

The other three survive a board, because they express things a Status column does not: *this has not
been triaged*, *this is waiting on an answer*, *this is blocked by something outside GitHub*. A card
sitting in `Backlog` does not distinguish "nobody has looked at it" from "looked at, deliberately
deferred".

| Label | Survives a board? |
|---|---|
| `status:in-progress` | No — the board's `In progress` says it |
| `status:needs-review` | No — the board's `In review` says it |
| `status:needs-triage` | **Yes** |
| `status:needs-info` | **Yes** |
| `status:blocked` | **Yes**, for non-GitHub blockers — see [relationships.md](relationships.md) |

A repo whose config says `"inFlightState": "board"` never carries those two — `bootstrap-labels.sh` (and `--board`) skips them.

| Label | Meaning |
|---|---|
| `status:needs-triage` | Filed, not yet prioritised |
| `status:needs-info` | Blocked on an answer from the reporter or the user |
| `status:blocked` | Blocked on something that is **not** a GitHub issue — a vendor, a decision, an API key, an answer. **The comment must say what by.** When the blocker *is* an issue, use `gh issue edit N --add-blocked-by M` instead ([relationships.md](relationships.md)) — never both |
| `status:in-progress` | Someone is actively working it (set at pick-up) |
| `status:needs-review` | PR is open, awaiting human review |

`status:blocked` without a comment naming the blocker is useless. Always pair them.

---

## `resolution:` — why it closed, when it wasn't a normal fix

| Label | Use when |
|---|---|
| `resolution:duplicate` | Another issue tracks it. **Name the survivor in the closing comment.** |
| `resolution:wontfix` | Real, understood, deliberately not being fixed. Say why. |
| `resolution:cannot-reproduce` | Tried and failed to reproduce. List what you tried. |
| `resolution:works-as-intended` | Behaviour is correct; the expectation was wrong. Explain the intent. |

A normal fix needs no resolution label — the merged PR says everything.

**Every other close must carry one, and this is load-bearing.** The duplicate check
([duplicate-check.md](duplicate-check.md)) has to tell an *adjudicated decision* from an *old fix*
when it hits a closed issue, and the `resolution:` label is the only signal it can read without a
human opening the issue and reading the thread. A close missing one turns every future search hit
into an interruption for the operator.

```bash
bash "<skill-dir>/scripts/lint-issue-labels.sh" --all --state all    # flags closes with no resolution:
```

---

## No delivery-planning labels

There is deliberately no `wave:`, `phase:`, `sprint:` or `release:` dimension. **Do not add one.**

Planning metadata has no fixed cardinality. The five dimensions above are closed sets — there will
never be a sixth severity — but nobody knows how many phases a project ends up with, and every value
ever used stays in the label picker forever, un-deletable without orphaning the issues that carry it.
Repos that try `wave:` and `phase:` labels end up removing them for exactly that reason.

Where the planning context goes instead:

| Need | Use |
|---|---|
| "These issues belong together" | **Sub-issues** — `gh issue edit N --parent M` ([relationships.md](relationships.md)). Hierarchy with no cardinality problem, and GitHub draws the progress bar |
| "This belongs to the Phase 3 work" | Say it in the issue body or a comment — it is prose, and prose scales |
| A dated slice of work with a progress bar | A **milestone**. GitHub closes it out for you and it does not pollute the label list |
| Which requirement it implements | The requirement or spec ID (e.g. `REQ-CHK-04`) under References |

Sub-issues are the direct replacement for what `wave:` and `phase:` were reaching for: an umbrella
issue with sub-issues expresses the grouping, is navigable from either end, and disappears cleanly
when the work closes. **Grouping is a hierarchy question, never a label question.**

An agent never invents a planning label, and never reintroduces these.

---

## Creating the labels

[../scripts/bootstrap-labels.sh](../scripts/bootstrap-labels.sh) creates or updates every label
above in one run. It is idempotent (`gh label create --force`), so re-running after adding an area
is safe and non-destructive.

Invoke it through `bash`, not `./…` — git does not record the executable bit on repos checked out
with `core.filemode=false` (any Windows checkout), so `./` fails with "Permission denied" elsewhere.

```bash
bash "<skill-dir>/scripts/bootstrap-labels.sh" --dry-run                   # print, change nothing
bash "<skill-dir>/scripts/bootstrap-labels.sh"                             # areas + mode from the repo's config
bash "<skill-dir>/scripts/bootstrap-labels.sh" --areas api,ui,checkout     # an explicit area set
bash "<skill-dir>/scripts/bootstrap-labels.sh" --board                     # a Projects board owns in-flight state
bash "<skill-dir>/scripts/bootstrap-labels.sh" --repo owner/name           # a specific repo
```

`/github-workflow:setup` runs it for you with the right flags.

## What it does not do — GitHub's stock labels

A new repo ships with `bug`, `enhancement`, `documentation`, `duplicate`, `wontfix`, `question`,
`invalid`, `help wanted` and `good first issue`. The script leaves them alone, because deleting
labels is destructive and may orphan filters on existing issues.

Six of them shadow this taxonomy — `bug`, `enhancement`, `documentation`, `duplicate`, `wontfix`,
`question`. **Never apply them.** Use `type:bug`, `type:enhancement`, `type:docs`,
`resolution:duplicate`, `resolution:wontfix`, `status:needs-info`. If the operator wants them gone,
that is their call to make explicitly:

```bash
for l in bug enhancement documentation duplicate wontfix question invalid; do
  gh label delete "$l" --yes           # destructive — ask first, it is not idempotent
done
```

Colour convention, so severity and priority never read as the same axis at a glance:
type = mixed hues · severity = red→green ramp · priority = purple ramp · area = one teal ·
status = signal colours · resolution = grey.
