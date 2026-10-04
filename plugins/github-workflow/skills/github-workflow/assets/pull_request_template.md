<!--
  One PR per unit of work. Every issue it resolves needs its OWN closing keyword below —
  "Closes #NNN, #MMM" only links #NNN. And the PR must target the default branch or the
  keyword is ignored entirely.
-->

## What

<!-- The change, in one or two sentences. -->

## Why

Closes #

<!-- Each additional issue needs its own keyword on its own line, e.g. Closes #NNN -->

## How

<!-- The approach, and the alternative you rejected. Reviewers need the road not taken. -->

## Testing

- [ ] Automated tests added or updated
- [ ] Full suite passes locally — command and result:
- [ ] Manually verified — what you actually did, in which environment:

## Risk and rollback

<!-- Migrations, data changes, config, feature flags, anything needing care at deploy.
     "None" is a valid answer — write it rather than deleting the section. -->

**Risk:**
**Rollback:**

## Screenshots

<!-- UI changes only. Before and after. -->

## Checklist

- [ ] Branch is named `<type>/<issue-numbers>-<slug>` and targets the default branch
- [ ] Every linked issue has its own closing keyword above
- [ ] Commits follow Conventional Commits
- [ ] Acceptance criteria from the issue are all met, and ticked on the issue
- [ ] No secrets, tokens, PII or customer data in the diff
- [ ] An "Implemented" comment naming this PR is posted on each linked issue
