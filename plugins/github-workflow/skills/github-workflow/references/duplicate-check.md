# The duplicate check

Script paths are relative to the skill directory, written `<skill-dir>` (the skill resolves it); a repo that installed copies with `/github-workflow:setup` also has them under `.github/scripts/`.

Run this **before you propose an issue**, every time. It is a gate, not a courtesy: on a repo with a
few hundred open issues, filing without searching produces a duplicate by default.

This file is plain markdown. Any agent can read it — it is not a Claude-specific format.

---

## Why a label filter is the wrong first move

The instinct is to narrow by label first: same `type:`, same `area:`, then compare. It does not work,
and it fails in the specific way that matters.

**Labels record a judgement *about* an issue. Duplicates collide on *subject*.** Two agents looking
at the same thing routinely reach different judgements, so a label pre-filter hides exactly the
overlap you most want to find.

A worked example — both issues are about the rate limiter:

| Issue | Title | `type:` |
|---|---|---|
| #159 | `Rate limiter is per-process with no shared counter` | `type:bug` |
| #178 | `[SEV-2] The rate-limit counters are global state no test resets` | `type:test` |

One agent saw a defect, the other saw a test gap. Filter on `type:bug` and #178 is invisible; filter
on `type:test` and #159 is. Neither filter finds both — but a text search for `rate limiter` finds
them in one query, because they collide on subject even though they diverge on judgement.

Labels are worth reading **after** you have candidates, to understand how a subject was previously
judged. They are useless for finding those candidates.

---

## Choose terms the way the index does

Search **identifiers, not English.** The highest-signal duplicate key is the code artifact, because
it survives rephrasing — where an English description does not.

`Order confirmation email hard-codes colours in three templates` (#197) and `Order confirmation email is sent twice when a payment retries` (#171) share almost no *descriptive* vocabulary — one is about styling, the other about event handling. They share the component name, and that is the only term that finds both.

| High signal — search these | Low signal — skip these |
|---|---|
| Function and method names — `CartService.applyCoupon` (TS/Java), `cart.apply_coupon()` (Python), `Cart.apply_coupon/2` (Elixir), `(*Cart).ApplyCoupon` (Go) | Verbs: *fails*, *breaks*, *renders*, *shows* |
| Field and setting names — `coupon_code`, `MAX_COUPONS_PER_ORDER` | Adjectives: *wrong*, *incorrect*, *broken*, *missing* |
| Error and exception classes — `TypeError`, `KeyError`, `NullPointerException` | Generic nouns: *page*, *screen*, *list*, *user*, *data* |
| File paths — `src/cart/coupon.ts` | Severity and priority words: *critical*, *urgent* |
| Domain identifiers — `coupon_code`, `idempotency_key`, `payment_intent` | Anything that would match a hundred issues |
| Literal strings the code emits, and HTTP status codes | Articles, prepositions, filler |

Two or three high-signal terms beat ten low-signal ones. If a term returns more than about fifteen
hits it is not distinctive — narrow it or drop it.

---

## The query battery

Four queries. **Always `--state all`** — a closed issue is often the more important hit, and the
default of open-only is what lets a settled decision get refiled.

```bash
R=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# 1. Title-only, per distinctive term. Precise, few false positives.
gh issue list --repo "$R" --state all --search "coupon_code in:title"

# 2. Full text on the proposed title. GitHub ranks by relevance, so read the top few.
gh issue list --repo "$R" --state all --search "checkout 500 coupon code"

# 3. Full text on two terms together. Catches issues that describe it differently.
gh issue list --repo "$R" --state all --search "coupon_code applyCoupon"

# 4. Across title, body and comments — the only one that sees corrections (see below).
gh search issues --repo "$R" --match title,body,comments "coupon_code"
```

Or run all four at once:

```bash
bash "<skill-dir>/scripts/find-duplicates.sh" "Checkout returns 500 when the coupon code is blank"
bash "<skill-dir>/scripts/find-duplicates.sh" "Per-region shipping rates" shipping rate region   # explicit terms
```

Two things the script does that are worth understanding before you read its output:

- **It discards terms that are too broad.** A term matching more than fifteen issues is not
  distinctive, so its results are thrown away and the term is reported as skipped. That is the rule
  in the table above, enforced rather than merely documented — without it, one word like `admin` or
  `user` buries every real candidate.
- **It ranks by agreement, shown as `N×`.** That is how many of the searches independently found the
  same issue. A candidate found by one broad search and nothing else is usually noise; two searches
  agreeing is a real signal. Single-search hits are suppressed once there are at least three
  corroborated ones, and the count of what was hidden is always printed — never silently.

It ranks text. It does not understand the problem, so it cannot tell you an issue *is* a duplicate —
only which ones are worth your reading.

**Query 4 matters more than it looks.** Comments are an indexed, searchable field. When an issue's
description turned out to be wrong, the correction lives in a comment — so query 4 is the only one
that finds an issue under what it *actually* was rather than what it was first believed to be. See
the correction block in [../assets/comment-templates.md](../assets/comment-templates.md).

---

## Adjudicate what you find

Finding a hit is not the answer. **The question is not "does a similar issue exist" — it is "has this
already been adjudicated".** Four different findings, four different actions.

| What you find | What it is | Do |
|---|---|---|
| **Open**, same subject | Duplicate | Do not file. Add your evidence as a comment on the existing issue — new reproduction, a second occurrence, a wider blast radius. That is more valuable than a second issue |
| **Closed as fixed** (`completed`, no `resolution:`) | **A regression — not a duplicate** | File a new issue. Say it is a regression, link the original, and name the commit that fixed it the first time. Regressions deserve their own record; reopening loses the history of the first fix |
| Closed `not planned` · `works-as-intended` · `wontfix` · `cannot-reproduce` | **An adjudicated decision** | **Stop.** Show the operator the link and the reason it was closed, and ask what has changed. Do not file without an explicit yes |
| **Open**, overlapping but broader or narrower | A scope relationship | Not a duplicate. See [relationships.md](relationships.md) — `--parent` or `--add-sub-issue` |
| Nothing | Clear | File, with the `Searched:` block in the body |

**The third row is the one that costs the most when it is skipped.** A closed issue carrying a
`resolution:` label is a human decision. Refiling it silently overrides that decision and asks
someone to make it a second time — usually without them realising they already made it. The right
move is never to file quietly; it is to surface the prior decision and let the operator say whether
circumstances moved.

A closed issue with **no** `resolution:` label and no clear resolution comment is ambiguous. Treat it
as the third row — ask — rather than guessing it was a normal fix.

---

## Record what you searched

Post a `**Searched:**` block **with the proposal**, and ship the same block in the issue body.

```markdown
**Searched:** `"coupon_code" in:title` · `coupon_code 500` · `applyCoupon checkout` — all states
**Candidates:** #88 (open, type:bug) — same module, different call path
               #142 (closed, resolution:works-as-intended) — a blank code was deliberately rejected before the promotions rework
**Verdict:** new issue — #142's decision predates the promotions rework
```

Three lines, all required:

- **Searched** — the actual queries, not a description of them. "I searched for duplicates" is not
  this. Someone must be able to re-run them.
- **Candidates** — every hit you considered and rejected, with its state, its `resolution:` label if
  it has one, and one clause on why it is not this. An empty candidate list is a legitimate result;
  write `none`.
- **Verdict** — file, do not file, or stop and ask.

This mirrors the `**Thread checked:**` line in the pick-up comment, and exists for the same reason:
**a mandated check that leaves no trace cannot be distinguished from one that was skipped.** A
proposal without this block is incomplete, and the operator is right to reject it.

---

## Features and enhancements search differently

Bugs duplicate on **symptom**. Features duplicate on **capability** — and they usually overlap
partially rather than exactly, which changes both the search and the resolution.

**Search the domain noun, not the behaviour.** For `Per-region shipping rates`, search
`shipping`, `rate`, `region`, `zone`, `carrier`, `delivery fee` — the vocabulary someone else might have
used for the same capability. Feature titles vary far more than bug titles, so cast wider and accept
more false positives.

**Then judge overlap, not identity:**

| Relationship to the existing issue | Action |
|---|---|
| Same capability, same scope | Duplicate. Do not file |
| A narrower slice of it | File, then `gh issue edit <new> --parent <existing>` |
| Broader — it contains the existing one and more | File, then `gh issue edit <new> --add-sub-issue <existing>` |
| Adjacent, independent | File. Cross-link in a comment |

Closing a partial overlap as a duplicate destroys the scope difference, which is usually the only
interesting thing about it. `Per-region shipping rates` and `Free-shipping thresholds by country` are not
the same issue — one is a subset — and collapsing them loses that. Hierarchy is the right answer, and
it has the side benefit that a project board cannot then show the work twice as independent cards.

Details in [relationships.md](relationships.md).
