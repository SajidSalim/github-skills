# Comment templates

Post them with `gh issue comment <n> --body-file -` and a quoted heredoc so backticks survive.

## Which comments an issue actually gets

**Normally two: the pick-up and the implementation comment.** A third is written only when the issue
closes without a merged PR.

The reason is not tidiness. **Write every record at a moment you are demonstrably present for.** Rule
2 ends your involvement at PR-open — you report the number and stop. Anything the protocol asks for
after that will usually never be written, because you are gone and a human merges on their own
schedule. The implementation comment is therefore the **complete record**, not an interim note.

| Moment | Comment | Who is present |
|---|---|---|
| Claiming the issue | §1 Pick-up | You |
| PR opened | §2 Implemented — **the complete record** | You |
| PR merges, issue auto-closes | *nothing* — the merged PR is the record | Nobody |
| Closing with **no** merged PR | §3 Closing | You, because closing is your action |
| Blocked / handing over | §5, §6 | You |

This is not a loophole in rule 7. A merged PR with a real body **is** a written explanation reachable
from the issue — GitHub renders "Closed via #<pr>" right there. What rule 7 forbids is a bare closing
keyword with nothing behind it.

## Length, and not saying it three times

| Comment | Target |
|---|---|
| Pick-up | ~600 characters |
| Implemented | ~800 characters |
| Closing | ~600 characters |

**Do not restate the PR body.** It is one click away and it is where reviewers read. The
implementation comment names the PR and states what a reader of the *issue* needs — criteria met,
anything not included — and stops. Root cause, design reasoning and the full test log belong in the
PR body.

Measured failure this replaces: one issue carried 6,302 characters of comments against a 6,362-character
PR body, roughly 60% of it duplicated across two comments and the PR. Copy, fill every placeholder,
and write "none" rather than deleting a heading — but say each thing once.

---

## 1. Pick-up — posted immediately after self-assigning, before writing code

**Read the thread first.** This comment is a claim, and a claim is only meaningful if you checked
that nobody else has one. `gh issue view <n> --comments` before you write it — the assignee field
will not tell you, because every agent the operator runs shares one login.

```markdown
**Picking this up** — <agent/model name> · <YYYY-MM-DD HH:MM UTC>

**Thread checked:** <no open claim — no prior pick-up comment, no `status:in-progress`, no linked branch>

**Plan**
1. <first concrete step — usually reproduce, or read the existing implementation>
2. <…>
3. <…>

**Branch:** `<type>/<issue-numbers>-<slug>`
**Scope:** the acceptance criteria above, nothing else.
**Assumptions:** <none | the ones you are making>
**Questions blocking me:** <none | ask them here and wait>

Next comment will name the commit and PR.
```

Its job is to claim the item and expose the plan while it is still cheap to redirect. Posted after
the work, it is worthless. If the plan diverges from what the issue asks for, say so **here** and
wait for an answer — do not quietly redesign.

**Thread checked** is what proves the collision check happened, so fill it honestly. Resuming
someone's handover instead? Say so: `continuing the handover of <date> — branch <name> at <sha>`.

Multi-issue branch: check and post on every issue in the set, each naming the same shared branch and
listing the other issue numbers. One claimed issue blocks the whole branch.

---

## 2. Implemented — posted at PR-open. **The complete record.**

The last comment you will be present to write on a normally-merged issue. Write it as the final word,
not an interim note — nobody is coming after you to finish the story.

```markdown
**Implemented**

**PR:** #<pr> · **Commit:** `<sha>` <conventional commit subject>

**Acceptance criteria**
- [x] <criterion, verbatim from the issue>
- [x] <…>

**Verified by** — `<exact command>` — <n> tests, <n> failures. <the one line that proves it works>
**Not included / follow-ups:** <none | #<n>>
**Risk:** <none | migrations, data changes, config, anything needing care at deploy>
```

**~800 characters. Do not restate the PR body.** What changed, why this approach, the root cause and
the full test log go in the PR — that is where reviewers read, and it is one click from here. This
comment answers only what a reader of the *issue* needs: which PR, criteria met, what was left out.

This is the comment rule 6 requires — where "which commit or PR implements this" is written down.
Copy the acceptance criteria **verbatim**; rewording them to match what you built is how scope
quietly changes. Never tick a box you did not verify.

**Found the issue's description wrong?** Put the correction here, in §3a's format, not at close. You
know it now, and you will not be here at close.

**If the PR is later closed unmerged**, whoever closes it says so on the issue — one comment naming
the PR and why it was abandoned — and the issue goes back to unclaimed by removing the assignee. An
issue whose only claim is a pick-up comment pointing at a dead PR reads as claimed forever, and §5.1
will tell the next agent to stop.

---

## 3. Resolved — **only when there is no merged PR**

**Do not write this after a normal merge.** The merged PR is the record: GitHub links it from the
issue as "Closed via #<pr>", and repeating its contents here is the duplication this protocol exists
to avoid. Write it when the issue closes and *nothing else explains why* — a `wontfix`, a duplicate,
a cannot-reproduce, a works-as-intended, or a fix that landed without a PR.

You are present for these, because closing is your own action.

If what you found differs from what the issue describes, open with the correction block in §3a.

```markdown
**Resolved**

**Root cause** — <the actual mechanism, not the symptom. "X called Y on a value that became
nullable in Z" — not "there was a bug in X".>

**Fix** — <what changed, and why this approach over the alternative>

**Resolved by** — <commit `<sha>` | the decision below>

**Verification** — <how you know: the test that reproduces it, the environment you confirmed in>

**Residual risk / follow-ups** — <none | backfill needed, see #<n> | known limitation>
```

~600 characters.

**Rare exception:** you merged the PR yourself, at the operator's explicit instruction, in the same
session. Then you *are* present at close and the merge SHA is worth recording — but keep it to what
the PR body does not already say, and post it even though the merge closed the issue automatically.

For a feature rather than a bug, replace **Root cause** with **What was built** and keep the rest.

---

## 3a. Correction — when the issue description turned out to be wrong

**Post it as soon as you know, which is almost always at implementation time** — put it at the top of
the §2 implementation comment. Deferring it to close has the same flaw as deferring a resolution: on a
normally-merged issue you are not there at close, so a correction saved for later is a correction
never written. If the issue does get a §3 closing comment, it goes at the top of that instead.

Either way it goes **first**. A reader has to know the body is unreliable *before* they read anything
that cites it.

```markdown
**Correction — this issue's description is wrong**

**The issue said:** <what the body claimed — quote the Suspected cause, the repro steps, or the
symptom, whichever turned out wrong>
**Actually:** <what it really was, in the same amount of detail>
**Still accurate:** <the parts a future reader can still trust — symptom, impact, environment>
**Not accurate:** <the specific fields that are wrong, named: Suspected cause, Steps to reproduce,
acceptance criterion N>
**Actual terms:** <identifiers describing the real defect — `CartService.applyCoupon` · error class ·
setting key · file path>
```

Required whenever the finding differs materially from the description: a wrong hypothesis, wrong
reproduction steps, the wrong problem entirely, or the wrong scope.

Four things to get right:

- **Split accurate from inaccurate.** A blanket "the body was wrong" throws away reproduction steps
  that were fine. Say which half still holds.
- **`Actual terms` is the working part, not a flourish.** GitHub indexes issue *comments*, so this
  line is what makes the issue findable under what it actually was. Leave it out and the issue stays
  indexed under the wrong problem forever — the next duplicate check misses it and someone refiles.
  See [../references/duplicate-check.md](../references/duplicate-check.md).
- **Comment only. Never edit the issue body.** Every agent shares one `gh` login, so you cannot tell
  who wrote it — the same reason the assignee field proves nothing about who claimed an issue.
- **A different defect is a different issue.** Correct the record, close with the matching
  `resolution:` label, and *propose* a new issue for the real defect. Rule 1 applies to it.

Worked example:

```markdown
**Correction — this issue's description is wrong**

**The issue said:** the 500 came from `applyCoupon` reading `.discount` from a `null` lookup (Suspected cause).
**Actually:** the lookup never returns `null`. `CouponCode.normalise` throws on the empty string the
mobile app has sent since 3.2; the null-lookup path was a red herring.
**Still accurate:** the symptom, the reproduction steps, the impact assessment.
**Not accurate:** Suspected cause; the acceptance criterion about blank codes never being looked up.
**Actual terms:** `CouponCode.normalise` · empty string · `RangeError` · mobile 3.2
```

---

## 4. Closing without a fix

```markdown
**Closing — <duplicate | not planned | cannot reproduce | works as intended>**

<Why, in enough detail that reopening it later is an informed decision.>

<Duplicate: "Duplicate of #198 — same root cause, that one has the reproduction.">
<Not planned: "Superseded by the promotions rework, #312. Revisit if it recurs before then.">
<Cannot reproduce: "Tried: <list>. Inconclusive because <reason>. Reopen with a request ID if it recurs.">
<Works as intended: "Behaviour is correct per the pricing spec (REQ-PRC-04) — <the intent>. Filed #340 to make the UI say so.">
```

Then apply the matching `resolution:` label and close with the right `--reason`
([gh-commands.md](../references/gh-commands.md#closing)).

**The `resolution:` label is not optional here.** A future duplicate check has to tell an adjudicated
decision from an old fix when it hits this issue, and that label is the only signal it can read
without a human opening the thread. Skip it and every future hit becomes an interruption for the
operator — see [../references/duplicate-check.md](../references/duplicate-check.md).

---

## 5. Blocked

```markdown
**Blocked**

**Blocked by:** <#<n> | external party | decision needed from @<user>>
**What I completed before stopping:** <…>
**What unblocks it:** <the specific thing needed, and from whom>
**Branch:** `<branch>` — <pushed | local only>
```

Swap `status:in-progress` for `status:blocked` — an issue carries one `status:` at a time:
`gh issue edit <n> --remove-label status:in-progress --add-label status:blocked` (a board repo has
no `status:in-progress` to remove). A `status:blocked` label with no comment naming the blocker is
noise — always pair them.

---

## 6. Handover — another agent or session picks this up

```markdown
**Handover**

**State:** <what works, what does not>
**Branch:** `<branch>` @ `<sha>` — <pushed | local only>
**Done:** <…>
**Remaining:** <…>
**Gotchas:** <the thing that cost you an hour, so it does not cost them one>
**Claim:** released — this issue is free for another agent to pick up from here.
```

Post this before ending a session on an unfinished issue. Rule 4: if it is not in a comment, the
next agent does not know it.

This comment also **releases your claim** — the pick-up check reads a "Handover" (or "Blocked")
following a pick-up comment as resumable. Without it your pick-up comment reads as active work and
the next agent will stop and ask rather than continue. Drop `status:in-progress` when you post it.
