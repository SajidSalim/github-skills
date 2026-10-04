# gh command cookbook

Script paths are relative to the skill directory, written `<skill-dir>` (the skill resolves it); a repo that installed copies with `/github-workflow:setup` also has them under `.github/scripts/`.

Checked against `gh` 2.97 (Jul 2026). Flags marked **(gh 2.88+)** or **(gh 2.94+)** are unavailable on older builds —
`gh --version` if a flag is rejected.

## Orientation

```bash
gh auth status
gh api user -q .login                                          # the login "@me" resolves to
gh repo view --json nameWithOwner,defaultBranchRef -q '.nameWithOwner + " default=" + .defaultBranchRef.name'
gh label list --limit 100

# board check — repo-scoped. NOT `gh project list`, which misses a board owned by someone else.
read -r OWNER NAME <<<"$(gh repo view --json owner,name -q '.owner.login + " " + .name')"
gh api graphql -f query="{ repository(owner: \"$OWNER\", name: \"$NAME\") {
  projectsV2(first: 10) { nodes { number title id } } } }" \
  --jq '.data.repository.projectsV2.nodes[] | "#\(.number) \(.title) \(.id)"'
```

## Finding work

```bash
gh issue list --assignee "@me" --state open
gh issue list --label "type:bug,severity:sev-1" --state open
gh issue list --label "status:needs-triage" --state open

# status:in-progress nobody has touched in 14 days — a stale claim is the operator's call, never yours
gh issue list --label "status:in-progress" --state open --json number,title,updatedAt \
  --jq '[.[] | select(.updatedAt < (now - 14*86400 | todate))] | .[] | "\(.number)\t\(.updatedAt)\t\(.title)"'
```

`--label a,b` is **AND** (both labels). For OR, run separate queries or use `--search`.

## Duplicate check — run before filing anything

```bash
bash <skill-dir>/scripts/find-duplicates.sh "<the title you intend to file>"
```

Or by hand — four queries, **always `--state all`**, because the closed issues carry the decisions:

```bash
gh issue list --state all --search "coupon_code in:title"          # 1. title only, per term
gh issue list --state all --search "checkout 500 coupon code"      # 2. full text, whole title
gh issue list --state all --search "coupon_code applyCoupon"       # 3. full text, terms together
gh search issues --repo "$R" --match title,body,comments "coupon_code"   # 4. includes COMMENTS
```

Query 4 is the only one that sees a **correction comment**, so it is the only one that finds
an issue under what it actually turned out to be rather than what it was first believed to be.

Search identifiers, not English — `CartService.applyCoupon`, `coupon_code`, `TypeError`, a file
path. Words like *fails*, *wrong*, *admin* or *user* match everything and find nothing. Full
protocol and the adjudication table: [duplicate-check.md](duplicate-check.md).

## Relationships — **(gh 2.94+)**

```bash
gh issue edit 231 --parent 300                 # 231 becomes a sub-issue of 300
gh issue edit 300 --add-sub-issue 231,244      # the same link, set from the parent
gh issue edit 231 --remove-parent
gh issue edit 231 --add-blocked-by 244         # 231 waits on 244
gh issue edit 231 --add-blocking 250           # 250 waits on 231
gh issue edit 231 --remove-blocked-by 244

gh api repos/{owner}/{repo}/issues/300/sub_issues \
  --jq '.[] | "#\(.number)\t\(.state)\t\(.title)"'
```

Sub-issues replace `wave:`/`phase:` labels. `--add-blocked-by` is for blockers that *are* GitHub
issues; `status:blocked` is for everything else. Never both. See [relationships.md](relationships.md).

## Collision check — run before claiming anything

```bash
gh issue view 231 --comments                                   # the actual check: read every comment
gh issue view 231 --json assignees,labels,state \
  -q '{state, assignees: [.assignees[].login], labels: [.labels[].name]}'
gh issue develop 231 --list                                    # branches already linked to it
```

**`--assignee` and `@me` are useless for detecting collisions.** Every agent an operator runs
authenticates as the same login, so an issue another agent claimed minutes ago reports as assigned to
you. Only the comment thread, the `status:in-progress` label and linked branches distinguish them.

Claimed = a pick-up comment with no later "Implemented" / "Resolved" / "Blocked" / "Handover" from
the same author. Anything ambiguous → stop and ask.

## Creating

```bash
cat > issue.md <<'EOF'
## Summary
…
EOF

gh issue create \
  --title "[SEV-2] Checkout returns 500 when the coupon code is blank" \
  --body-file issue.md \
  --label "type:bug,severity:sev-2,priority:p1,area:checkout" \
  --assignee "@me"

rm issue.md
```

Always `--body-file`, never a multi-line `--body` — quoting eats the markdown. Use a heredoc with a
quoted delimiter (`<<'EOF'`) so backticks and `$` in code blocks survive. Write the file in the
working directory, as above, and delete it afterwards so it is never committed.

Other flags: `--template <name>` to start from an issue form, `--milestone <name>`,
`--project <name>`, `--web` to open the browser instead.

## Assigning and labelling

```bash
gh issue edit 231 --add-assignee "@me"
gh issue edit 231 --remove-assignee "@me"
gh issue edit 231 --add-label "status:in-progress"                    # labels-only mode, on pick-up
gh issue edit 231 --remove-label "status:in-progress" --add-label "status:needs-review"   # PR open
gh issue edit 231 --remove-label "status:needs-triage" --add-label "priority:p1"
gh issue edit 231 --milestone "2026-Q4"          # milestones, not labels, for dated delivery slices
```

`status:` holds one value at a time: move it with `--remove-label <old> --add-label <new>`, never by
adding a second one, and remove it on close. An issue still carrying `status:needs-triage` gets its
`priority:` from the operator before you swap that for `status:in-progress`.

`@me` = the authenticated account, so this is portable across agent identities and bot tokens — but
for the same reason it does **not** identify *which* agent, so never treat assignment as a claim
check. Assignment fails silently on some repos if the account lacks write access — verify with
`gh issue view 231 --json assignees`.

Never apply GitHub's stock labels (`bug`, `enhancement`, `duplicate`, `wontfix`, `documentation`,
`question`). They are not part of the taxonomy and shadow `type:bug`, `type:enhancement`,
`resolution:duplicate`, `resolution:wontfix`, `type:docs`.

## Commenting

```bash
gh issue comment 231 --body-file /tmp/pickup.md
gh issue comment 231 --body "One-liner is fine when it really is one line"
gh issue comment 231 --body-file - <<'EOF'                     # stdin, no temp file
**Picking this up** — …
EOF
gh issue comment 231 --edit-last --body-file /tmp/updated.md   # amend your own last comment
```

## Branching

```bash
gh issue develop 231 --name fix/231-checkout-blank-coupon --base main --checkout
gh issue develop 231 --list                                    # branches already linked to it
# WARNING: the link this creates closes #231 when a PR from that branch merges, whatever
# your closing keywords say. Link an issue only if it should certainly close; otherwise use
# `git checkout -b`. On a multi-issue branch only ONE issue can be linked -- pick the certain one.

# Not your checkout, or it holds changes you did not make: never switch it -- use a worktree.
gh issue develop 231 --name fix/231-checkout-blank-coupon --base main
git fetch origin fix/231-checkout-blank-coupon
git worktree add ../231-checkout-blank-coupon fix/231-checkout-blank-coupon
```

This registers the branch in the issue's **Development** panel; `git checkout -b` does not.
For a multi-issue branch, run this for the one issue that should certainly close — the PR's closing keywords link the rest.

**Evidence that the link closes on its own.** A batch PR deliberately left one of its issues open, said so in its body and used `Refs` for it, and that issue closed on merge anyway. The control was clean: another issue in the same batch, with the same `Refs`, stayed open, and the only difference was that the branch had been created with `gh issue develop` on the first. The PR body was correct, so no check on the PR's text could have caught it.

## Pull requests

```bash
gh pr create --base main \
  --title "fix(checkout): treat a blank coupon code as no coupon" \
  --body-file pr.md \
  --label "type:bug,area:checkout" \
  --reviewer someuser

rm pr.md
```

```bash
gh pr status
gh pr view --json number,url,state,mergeable -q '{number,state,mergeable}'
gh pr checks --watch                                           # block until CI settles
gh pr diff
gh pr comment 45 --body-file /tmp/note.md
gh pr ready 45                                                 # draft → ready
```

Do not run `gh pr merge`. Merging is a human decision.

## Closing keywords — exact rules

- Keywords: `close` `closes` `closed` `fix` `fixes` `fixed` `resolve` `resolves` `resolved`
- Case-insensitive; a trailing colon is allowed (`Closes: #231`)
- Same repo: `Closes #231` · Cross-repo: `Closes owner/repo#100`
- **Each issue needs its own keyword.** `Closes #231, closes #244` ✅ · `Closes #231, #244` ❌
- **The PR must target the default branch.** On any other base the keyword is ignored and merging
  does nothing to the issue
- In a **commit message** the keyword works when the commit lands on the default branch, but the PR
  is then *not* recorded as the linked PR. Prefer the keyword in the PR body and `Refs #231` in commits
- Manual linking via the UI caps at 10 issues per PR

## Closing

```bash
gh issue close 231 --reason completed --comment "$(cat /tmp/resolution.md)"
gh issue close 231 --reason "not planned" --comment "Superseded by #312."
gh issue close 231 --duplicate-of 198 --comment "Duplicate of #198."       # then add resolution:duplicate
gh issue reopen 231 --comment "Reopening: reproduced again on 2026-08-20, see #340."
```

`--reason` takes `completed`, `not planned` or, **(gh 2.88+)**, `duplicate`. **(gh 2.88+)** `--duplicate-of <number|url>`
sets the reason and records the link GitHub renders on both issues — prefer it over `not planned`
plus a label, and add `resolution:duplicate` as well so label queries still find it. On older `gh`,
fall back to `--reason "not planned"` and the label alone.

Note `--comment` takes a string, not a file — `"$(cat file)"` is the reliable way to pass a long one.

## Labels

```bash
gh label list --limit 200
gh label create "type:feature" --color "0E8A16" --description "New capability" --force
gh label edit "type:bug" --color "D73A4A"
gh label delete "wontfix" --yes
gh label clone owner/other-repo                                # copy a whole label set across repos
```

`--force` makes `create` idempotent — it updates colour and description if the label exists. That is
what makes [../scripts/bootstrap-labels.sh](../scripts/bootstrap-labels.sh) safe to re-run.

## Bulk / reporting

```bash
# Open sev-1 and sev-2, oldest first
gh issue list --state open --label "type:bug" --json number,title,labels,createdAt \
  --jq '[.[] | select(.labels[].name | test("severity:sev-[12]"))] | sort_by(.createdAt)
        | .[] | "\(.number)\t\(.title)"'

# What did each closed issue get resolved by?
gh issue list --state closed --limit 50 --json number,title,closedAt

# Everything assigned to me across repos
gh search issues --assignee "@me" --state open

# Check the whole backlog against the label taxonomy
bash <skill-dir>/scripts/lint-issue-labels.sh --all --state all
```

## CRLF — the trap on Windows

**The Windows `jq` build writes CRLF.** So a capture like this carries a carriage return into every
element but the last:

```bash
NUMS=$(jq -r '.[].number' file.json)     # "208\r", "209\r", "210"
gh issue view "$n"                       # invalid issue format: "208\r"
```

Command substitution strips the final newline and its `\r` with it, so **the last element works and
everything before it fails**. A one-item test passes; a three-item run does not. If the error is
suppressed — `2>/dev/null` — nothing is reported at all and the caller silently gets an empty result.

**Any `$(jq …)` whose value becomes a shell argument, a numeric comparison, or a loop variable needs
`| tr -d '\r'`.** Values consumed straight back into `jq` are safe, since JSON treats `\r` as
whitespace. `gh --jq` is unaffected — it is embedded in `gh` and writes LF.

```bash
NUMS=$(jq -r '.[].number' file.json | tr -d '\r')
[[ "$n" =~ ^[0-9]+$ ]] || continue        # cheap guard: never hand a malformed value to gh
```

This once broke `find-duplicates.sh`'s close-reason lookup: it resolved only the last candidate for weeks, and looked correct because it was verified against a search returning exactly one.

## `--jq` versus `jq`

`gh --jq` / `-q` uses a **jq implementation embedded in `gh`**, so it works with no `jq` on `PATH`.
Anything that *pipes* to `jq` needs the real binary installed — including the board node-ID lookups
in [project-board.md](project-board.md) and both workflow scripts. Check with `jq --version`;
`winget install jqlang.jq` on Windows, or the platform package manager elsewhere.

Prefer `--jq` where one command can do it. Reach for piped `jq` only when combining several calls.

### `NOT RUNNING` from the hook self-check

`/github-workflow:doctor` (or `node <skill-dir>/../../hooks/check-issue-workflow.mjs --self-check`) reports `NOT RUNNING` when the label linter cannot find `jq` — the state the taxonomy gate otherwise **degrades to a silent pass** on, so a green issue create proves nothing until it reports ready.

Restarting the editor will probably not fix it. A winget install lands on the *persisted* user
`PATH`, but a process inherits its environment from whatever launched it, and on Windows that parent
keeps handing out the pre-install copy across an app restart. Measured on a Windows machine: the persisted
`PATH` contained `jq`, the process `PATH` did not, and a full VS Code restart changed nothing.

Copy the binary somewhere already on `PATH` instead of chasing the environment — logging out or
restarting `explorer.exe` also work, and cost more than a copy:

```bash
cp "$LOCALAPPDATA/Microsoft/WinGet/Packages/jqlang.jq_"*/jq.exe ~/bin/   # ~/bin is on PATH
```

## Failure modes

| Symptom | Cause |
|---|---|
| `could not add label: 'severity:sev-2' not found` | Label does not exist. Run `bootstrap-labels.sh` (or `/github-workflow:setup`) — do not substitute a different label |
| Two agents on one issue | Assignee was used as the collision check. Every agent shares one login — read the comments instead |
| `Permission denied` running `./…/bootstrap-labels.sh` | Executable bit not recorded (`core.filemode=false` on Windows checkouts). Run it as `bash <path>` |
| Assignment appears to do nothing | Account lacks write access, or the assignee is not a repo collaborator |
| Issue not closed after PR merge | PR targeted a non-default branch, or the keyword lacked its own `closes` |
| Markdown mangled in a comment | Used `--body` for multi-line. Use `--body-file` |
| `gh: Not Found (HTTP 404)` on a project command | Wrong `--owner` (user vs org), or the token lacks the scope: `gh auth refresh -s read:project` to read, `-s project` to move cards |
| `missing required scopes [read:project]` | The token cannot read boards. **This is not "no board"** — do not fall back to labels-only on it. Refresh the scope, or report that board state is unknown |
| `gh project list` returns nothing, but a board exists | **Expected, not a bug.** It lists projects owned by a login *and visible to you*; a board owned by someone else returns empty and exit 0. Never use it as the board check — use the repo-scoped query below |
| `Status` value rejected on `item-edit` | The option name does not match. Option names are per-board — read them first ([project-board.md](project-board.md)) |
| `jq: command not found` | The scripts and the board node-ID lookups need real `jq`. `gh --jq` is embedded and unaffected |
| `invalid issue format: "208\r"` | CRLF from the Windows `jq` build. Pipe the capture through `tr -d '\r'` — see the CRLF section above. Everything but the **last** element is affected, so a one-item test will not show it |
| Duplicate check returns dozens of candidates | Generic terms. Search identifiers instead; `find-duplicates.sh` discards any term matching more than 15 issues and says which |
| Duplicate check prints `N of M searches FAILED — INCOMPLETE` | A query errored: rate limit, 5xx, or expired auth. The run is **unknown**, not empty. Re-run before filing, and never record it as `**Candidates:** none` |
