# Writing the issue

Script paths are relative to the skill directory, written `<skill-dir>` (the skill resolves it); a repo that installed copies with `/github-workflow:setup` also has them under `.github/scripts/`.

An issue is read three times: today by whoever triages it, next month by whoever fixes it, and next
year by someone doing archaeology on a regression. Write for the third reader — they have no context
and cannot ask you anything.

## Titles

The title is the only part most people read. It states **the problem or the capability**, never the
solution and never the effort.

| Type | Formula | Good | Bad |
|---|---|---|---|
| Bug | symptom + trigger | `Checkout returns 500 when the coupon code is blank` | `Fix checkout bug` · `Checkout issue` |
| Feature | capability as a noun phrase | `Per-region shipping rates` | `Implement shipping` · `Shipping work` |
| Enhancement | the observable change | `Show the estimated delivery date on the order confirmation page` | `Improve confirmation page` |
| Security | exposure + surface | `Password-reset token is not invalidated after use` | `Security fix needed` |
| Chore | the action | `Bump the HTTP client library to 3.x` | `Deps` |
| Spike | the question | `Can the payment provider settle partial refunds without a manual reversal?` | `Investigate refunds` |

Rules:

- ≤ 70 characters where the meaning survives it
- No trailing period
- No issue number, no branch name, no assignee
- No `Fix` / `Add` / `Implement` prefix on a bug — that is the fix, not the fault
- `[SEV-1]` / `[SEV-2]` prefix on those two severities only
- One problem per title. If the title needs "and", it is two issues

**Search before you write — this is a gate, not a courtesy.** One query is not the check; the full
protocol, term selection and what to do with each kind of hit are in
[duplicate-check.md](duplicate-check.md), and the issue body must carry the `**Searched:**` block that
records it.

```bash
bash "<skill-dir>/scripts/find-duplicates.sh" "Checkout returns 500 when the coupon code is blank"
```

---

## Bug body

```markdown
## Summary
One or two sentences. What breaks, for whom, under what condition.

## Environment
- Where: production / staging / local
- Version or commit: `a1b2c3d` (or the release tag)
- Who is affected: role, tenant, region, browser/device if relevant
- First seen: date, and whether it is a regression from a known-good version

## Steps to reproduce
1. Numbered. Exact. Start from a state anyone can reach.
2. Include the data that matters — a cart whose `coupon_code` is an empty string, not "a cart"
3. …

## Expected
What should happen, and where that expectation comes from (spec, requirement ID, prior behaviour).

## Actual
What happens instead. Verbatim error, status code, stack trace in a fenced block.

## Evidence
Logs, screenshots, a failing test, a request ID. Redact tokens, PII and customer data.

## Impact
Blast radius: how many users/regions/tenants, is there a workaround, is money or data at risk.
This is what justifies the severity label — state it, do not leave it to be inferred.

## Suspected cause
Optional. Mark it clearly as a hypothesis. Never present a guess as a finding — and whoever
closes this issue must say whether the hypothesis held (see the correction block in
[../assets/comment-templates.md](../assets/comment-templates.md)).

## Acceptance criteria
- [ ] Checkout with a blank coupon code returns 200 and creates the order
- [ ] A blank coupon code is treated as no coupon — it is never looked up
- [ ] A regression test exists that fails on the default branch

## Duplicate search
**Searched:** `<query>` · `<query>` — all states
**Candidates:** <#n (state, resolution:) — why it is not this | none>
**Verdict:** file
```

**Cannot reproduce it?** Say so explicitly under Steps to reproduce, list what you tried and what
was inconclusive, and label `status:needs-info`. An honest "seen twice in prod logs, no reliable
repro, here is the request ID" is a useful issue. Fabricated steps are not.

---

## Feature / enhancement body

```markdown
## Problem
The user need, in the user's terms. Not the solution. If you cannot describe the problem without
naming your solution, the problem is not understood yet.

## Proposed solution
What you intend to build, at a level someone can disagree with.

## Scope
**In:** …
**Out:** … — the out-list prevents the scope creep argument later. Be generous with it.

## Acceptance criteria
- [ ] Each one independently testable
- [ ] Each one observable from outside the code
- [ ] Enough of them that "done" is not a judgement call

## Dependencies and risks
Blocking issues, external parties, migrations, anything touching production data.

## References
Requirement or spec IDs, design docs, related issues, prior art. If the project keeps a requirements register, cite the ID so the issue and the register stay connected.

## Duplicate search
**Searched:** `<query>` · `<query>` — all states
**Candidates:** <#n (state, resolution:) — why it is not this | none>
**Verdict:** file
```

---

## Security body

Same as bug, plus:

```markdown
## Exposure
What an attacker gains, and what they need to already have to get it.

## Affected versions
## Mitigation available now
Anything that reduces exposure before the fix ships.
```

If it is exploitable in production and not yet public, **ask before filing a public issue** — a
private security advisory (`gh api repos/{owner}/{repo}/security-advisories`) or a direct message to
the owner may be correct instead.

---

## Acceptance criteria — the part that gets skipped

Criteria are the contract. They decide when the issue closes, and they are what the closing comment
is checked against.

| Not a criterion | A criterion |
|---|---|
| Works correctly | Checkout with a blank coupon code returns 200 |
| Good performance | Order history renders in under 2s for an account with 500 orders |
| Proper error handling | An invalid coupon shows the field-level error, and no 500 is logged |
| Mobile friendly | All controls meet the 44px touch target on a 375px viewport |
| Secure | A user in tenant A receives 404, not 403, for a tenant B order URL |

Rule of thumb: if two reasonable people could disagree about whether it is met, it is not a criterion.

---

## Worked example — a bug filed properly

**Title:** `[SEV-2] Checkout returns 500 when the coupon code is blank`

**Labels:** `type:bug` `severity:sev-2` `priority:p1` `area:checkout` `area:api`

```markdown
## Summary
Submitting checkout fails with a 500 when the cart's `coupon_code` is an empty string. The mobile
app has sent `""` instead of omitting the field since version 3.2, so those customers cannot
complete a purchase.

## Environment
- Production, commit `9f2c1ab`
- Affects: mobile-app customers, all regions
- First seen: 14 Aug 2026. Regression — worked before mobile 3.2

## Steps to reproduce
1. Create a cart through the mobile API with `"coupon_code": ""`
2. Add any in-stock item
3. Submit checkout

## Expected
The order is created, payment is captured once, and the confirmation page shows.

## Actual
500. The customer retries, and every retry leaves an abandoned payment intent.

    TypeError: Cannot read properties of null (reading 'discount')
        at CartService.applyCoupon (src/cart/coupon.ts:88:31)
        at CheckoutController.submit (src/checkout/controller.ts:142:18)

## Evidence
Request ID `req_01K3F…`. Error-tracker issue SHOP-4F2. 31 occurrences across 6 regions in 48h.

## Impact
Every mobile customer who leaves the coupon field blank is stopped at the last step. Support is
placing orders by hand, which skips the confirmation email. No workaround for customers.
~340 abandoned checkouts. sev-2 rather than sev-1 because web checkout works and support has a
manual path.

## Suspected cause
Hypothesis, unverified: `CartService.applyCoupon` looks `""` up as a code, gets `null`, and reads
`.discount` from it. Needs confirmation.

## Acceptance criteria
- [ ] Checkout with `coupon_code: ""` returns 200 and creates the order
- [ ] Payment is captured exactly once
- [ ] A blank coupon code is treated as no coupon — it is never looked up
- [ ] A regression test exists that fails on the default branch and passes on the fix
- [ ] No data backfill needed, or the backfill is specified in this issue

## Duplicate search
**Searched:** `coupon_code in:title` · `checkout 500 coupon code` · `coupon_code applyCoupon` · `coupon_code` in title, body and comments — all states
**Candidates:** none
**Verdict:** file
```
