# Issue relationships

GitHub tracks four kinds of link between issues, and `gh` sets all of them. Use them instead of
describing the relationship in prose, because a real relationship renders in the UI, is queryable,
and survives the comment thread scrolling away.

Needs `gh` **2.94+** for the relationship flags on `gh issue edit` (`--parent`, `--add-sub-issue`,
`--add-blocked-by` and the matching removals); on an older `gh`, record the relationship as a
cross-link comment instead. Needs `gh` **2.88+** for `gh issue close --duplicate-of` and
`--reason duplicate`; on an older `gh`, close with `--reason "not planned"`, a `Duplicate of #M.`
comment and the `resolution:duplicate` label. Checked against 2.97.
`gh issue edit --help` if a flag is rejected.

This file is plain markdown. Any agent can read it — it is not a Claude-specific format.

---

## Which one

| Situation | Relationship | Command |
|---|---|---|
| Same problem, same scope | duplicate | `gh issue close N --duplicate-of M` **plus** `resolution:duplicate` |
| A narrower slice of a bigger issue | sub-issue | `gh issue edit N --parent M` |
| An umbrella covering several issues | parent | `gh issue edit M --add-sub-issue N,O,P` |
| Cannot start until another ships | blocked-by | `gh issue edit N --add-blocked-by M` |
| It is what blocks another | blocking | `gh issue edit N --add-blocking M` |
| Same area, independent work | *none* | Cross-link in a comment. Not every mention is a relationship |

```bash
gh issue edit 231 --parent 300                 # 231 becomes a sub-issue of 300
gh issue edit 300 --add-sub-issue 231,244      # the same link, set from the parent
gh issue edit 231 --remove-parent
gh issue edit 300 --remove-sub-issue 231

gh issue edit 231 --add-blocked-by 244         # 231 waits on 244
gh issue edit 231 --add-blocking 250           # 250 waits on 231
gh issue edit 231 --remove-blocked-by 244

gh issue close 231 --duplicate-of 198 --comment "Duplicate of #198 — same root cause."
gh issue edit 231 --add-label "resolution:duplicate"
```

Read them back:

```bash
gh api repos/{owner}/{repo}/issues/300/sub_issues --jq '.[] | "#\(.number)\t\(.state)\t\(.title)"'
```

---

## Sub-issues are the replacement for `wave:` and `phase:` labels

[labels.md](labels.md) removed `wave:` and `phase:` and forbids reintroducing them, because planning
metadata has no fixed cardinality: nobody knows how many phases a project ends up with, and every
value ever used stays in the label picker forever, undeletable without orphaning the issues carrying
it.

**Sub-issue hierarchy gives the same grouping and creates no labels.** An umbrella issue named
`Phase 3 — promotions rework` with fifteen sub-issues shows a progress bar GitHub maintains for free, is
navigable from either end, and disappears cleanly when the work closes. It is the sanctioned way to
express "these belong together".

So: grouping work is a hierarchy question, never a label question.

---

## `--add-blocked-by` versus `status:blocked`

Both exist. They split by **what kind of thing is blocking**, so exactly one applies:

| The blocker is | Use | Why |
|---|---|---|
| Another GitHub issue, any repo | `gh issue edit N --add-blocked-by M` | Renders on both issues, queryable, updates itself when the blocker closes |
| Anything else — a vendor, a pending decision, an API key, an answer from a human | `status:blocked` label | There is no issue to point at. The existing rule stands: **the comment must name the blocker** |

Never use both for the same block. Two records of one fact is how state goes stale — the same reason
[project-board.md](project-board.md) drops `status:` labels once a board exists.

---

## Duplicate — mechanics

```bash
gh issue close 231 --duplicate-of 198 --comment "$(cat /tmp/resolution.md)"
gh issue edit 231 --add-label "resolution:duplicate"
```

`--duplicate-of` sets the close reason **and** records a link GitHub renders on both issues, which a
label alone cannot. Add `resolution:duplicate` as well so label queries still find it. On older `gh`,
fall back to `--reason "not planned"` plus the label.

Three rules:

- **Name the survivor in the comment**, not just the flag. `Duplicate of #198.`
- **Keep the older issue** unless the newer one is materially better written — the older one carries
  the discussion history and whatever it is already linked from.
- **Move anything the survivor lacks** before closing: a better reproduction, a second occurrence, a
  wider impact assessment. A duplicate closed with unique evidence still on it loses that evidence.

**Do not close as duplicate when the scope differs.** Partial overlap is a hierarchy, not a
duplicate — see [duplicate-check.md](duplicate-check.md). Collapsing "per-region shipping rates" and
"free-shipping thresholds by country" into one issue destroys the difference between them, which is usually
the only interesting thing about the pair.

---

## What a relationship is not

- **Not every mention.** Referencing an issue in a comment is a cross-link, and that is often the
  right amount of connection. Reserve relationships for real dependency or containment.
- **Not a substitute for the pick-up check.** A sub-issue with a parent still needs its own
  §5.1 thread read before you claim it.
- **Not a priority signal.** A blocked issue is not automatically lower priority; it is blocked. The
  `priority:` label is still a scheduling decision the operator owns.
