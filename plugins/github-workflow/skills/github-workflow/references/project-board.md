# GitHub Projects (v2) board

**This is conditional.** Whether a repo has a board is a runtime question. Detect it, and do not
assume in either direction — a summary that states the answer goes stale the day a board is created.

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

**Three outcomes, not two. An error is not an answer.**

- **Exit 0, no output** → labels-only mode. Skip this file entirely. Use `status:` labels
  ([labels.md](labels.md)) and carry on. Do not create a board unprompted — that is a
  human decision about how the team works.
- **Exit 0, rows** → follow the rest of this file, and **stop using `status:` labels**. The board's
  Status field becomes the single source of truth; keeping both is how state goes stale.
- **Non-zero exit** → **unknown, and you must not treat it as "no board".** Report it and ask.

## Why not `gh project list`

`gh project list --owner X` enumerates projects **owned by X and visible to you**. That is a
different question from *does this repo have a board*, and the gap between them is silent.

A board owned by someone else and linked to this repo returns **empty output and exit code 0** —
byte-identical to having no board. Project-level visibility is granted per project and is *not*
inherited from repository collaboration, so being a repo collaborator is no help.

This is not hypothetical. On a real private repository whose board belongs to the repository owner, queried by a collaborator:

```
$ gh project list --owner OWNER
                                    # empty, exit 0  →  "no board"

$ gh api graphql -f query='{ repository(owner:"OWNER", name:"REPO") {
    projectsV2(first:10){ nodes{ number title } } } }'
{"number":1,"title":"Team board"}     # a board with 200+ cards
```

**No owner-keyed query can find this board, and that is the point.** All four measured on that repository, authenticated as a collaborator rather than the board's owner:

| Query | Keyed on | Result |
|---|---|---|
| `repository.projectsV2` | the **repo** | `#1 Team board` ✅ |
| `gh project list --owner OWNER` | board owner | empty, exit 0 |
| `gh project list --owner YOUR-LOGIN` | your login | empty, exit 0 |
| `viewer.projectsV2` | your login | empty — it lists only boards you **own** |

`repository.projectsV2` asks the question you actually mean and is indifferent to ownership. Use it.

**The `owner:` argument is the repo's owner, not the board's** — half of the coordinate `owner/name`.
The detection snippet above derives it from `gh repo view` for that reason; a hand-typed login reads
as "the board belongs to this person" and sends the next reader back to `gh project list`.

**`viewer.projectsV2` is the sharpest of the four.** It returns boards the authenticated user
**owns**, not boards they can reach — so it omits board #1 even though #1 reports
`viewerCanUpdate: true` for the same token. GitHub exposes no "boards I have access to" listing at
all: ownership and access are decoupled, collaborators are not owners, and on any repo where that is
true — the normal case — repo linkage is the only handle that survives.

**The one blind spot to know about.** This finds boards *linked to the repo*. A board tracking this
repo's work that was never linked returns empty and exit 0, the same false negative from the other
direction, and no query closes it since `viewer.projectsV2` cannot see boards owned by others. That
is why the board number belongs in the repo's overlay, `.github/GITHUB_WORKFLOW.md` (template: [../assets/GITHUB_WORKFLOW.template.md](../assets/GITHUB_WORKFLOW.template.md)), rather than being rediscovered.

Scopes: reading a board needs `read:project`; **moving cards needs `project`**. An agent with only
`read:project` can report board state but cannot change it — which is a legitimate configuration, not
a fault. See "Who moves the cards" below.

Check once per session and cache the answer. Do not re-probe on every action.

**`jq` required.** The node-ID lookups below pipe to real `jq`, which is a separate binary from the
one embedded in `gh --jq`. `jq --version` to confirm; `winget install jqlang.jq` on Windows.

---

## Who moves the cards

Decide this once per repo, and record the answer where agents will read it:

**Assign a writer per transition, not per board.** The question is never "may agents touch the board"
— it is "who sets *this* value".

| Transition | Usual writer | Why |
|---|---|---|
| → first column (item added) | Built-in workflow | Fires on creation, before any agent is involved |
| → triage column (`Ready`, `Next`) | A human | A scheduling decision, not a mechanical one |
| → in-progress | **The agent** | No default workflow has an "assigned" or "branch created" trigger |
| → in-review | **Built-in workflow**, if *Pull request linked to issue* is enabled | It fires the instant a PR body says `Closes #231` — the same moment an agent would set it |
| → last column (item closed) | Built-in workflow | Fires on close |

**Enumerate every trigger before you claim a column for the agent.** The in-review row looks like the
agent's and usually is not. Ask *what else fires at this moment*, not just *is this column empty*.

**The mistake is two writers on one transition**, which is exactly what `status:` labels alongside a
board amount to. Two writers on *different* transitions is a division of labour, and it is the normal
shape: automation handles entry and exit, people and agents move things through the middle. Where a
built-in workflow owns a transition, the agent *reports* that card's state and never sets it.

**Check before assuming the automations cover it.** If the enabled workflows only set the first and
last columns — the common default — then a board where nobody writes the middle shows every card
jumping from `Backlog` to `Done`, and it is useless for seeing what is in flight. That is a real
outcome, not a hypothetical: it is the common state of a board nobody configured.

**Which workflows are on is readable, and needs no write access:**

```bash
gh api graphql -f query='{ node(id: "<project-id>") { ... on ProjectV2 {
  workflows(first: 20) { totalCount nodes { number name enabled updatedAt } } } } }'
```

It returns **only the enabled ones**, so `totalCount` is the count that is on.

**What the API will not tell you is what each one does.** `ProjectV2Workflow` exposes `name`,
`enabled`, `number`, `updatedAt` and nothing about the trigger or the action — no Status target, no
filter. The only mutation is `deleteProjectV2Workflow`; there is no create or update, so **reading and
changing a workflow's behaviour are both UI-only**.

Two consequences worth planning around:

- A human has to read the targets out of the settings page once, and they must be **written down** —
  they cannot be rediscovered from outside the UI.
- `updatedAt` is the one hook you get. Record it alongside the targets; if it has moved, the recorded
  behaviour is suspect and needs re-reading.

The default set worth recognising: *Auto-add to project*, *Auto-add sub-issues to project*, *Item
added to project*, *Item closed*, *Item reopened*, *Pull request merged*, *Pull request linked to
issue*, *Code review approved*, *Code changes requested*, *Auto-close issue*, *Auto-archive items*.
**`Auto-add to project` being on is the one that changes agent behaviour most** — every new issue is
carded without anyone doing it, so a hand-run `item-add` is at best redundant and at worst a duplicate.

## When to sync — exactly four moments

Applies when **agents** own Status. Under built-in workflows this table describes what the board does
for you, not a checklist to execute.

| Moment | Status becomes |
|---|---|
| Issue created | `Todo` |
| You self-assign and post the pick-up comment | `In Progress` |
| PR opened | `In Review` |
| Issue closed | `Done` |

Nothing else moves the card. In particular, do not move a card to `Done` on PR *creation* — a PR is
not a merge.

**Option names are per-board and rarely match this table.** Read them before writing any value —
one common board uses `Backlog` / `Ready` / `In progress` / `In review` / `Done`, with lowercase
`progress` and `review`. A value that does not match an option is rejected.

```bash
gh api graphql -f query='{ node(id: "<project-id>") { ... on ProjectV2 {
  fields(first: 20) { nodes { ... on ProjectV2SingleSelectField { name options { name } } } } } } }'
```

A card already in `In Progress` is a **claim signal**, exactly like `status:in-progress` is in
labels-only mode. Read it during the pick-up check alongside the comment thread — but never *instead*
of the thread, since only a comment says who claimed it and what they intended.

If the board's Status options are named differently (`Backlog` / `Ready` / `Blocked` …), map to the
nearest equivalent and **say in your report which mapping you used**. Never create a new option.

---

## Adding an item

**Check for an existing card first.** A board with the auto-add workflow enabled has already carded
the issue, so a blind `item-add` is at best redundant:

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
PROJ=1                                                     # project *number*, from the detection query above
ISSUE=231

# already on the board?
gh project item-list "$PROJ" --owner "$OWNER" --format json --limit 500 \
  | jq -r --argjson n "$ISSUE" '.items[] | select(.content.number == $n) | "already carded: \(.id)"'

gh project item-add "$PROJ" --owner "$OWNER" \
  --url "https://github.com/$REPO/issues/$ISSUE"
```

`gh issue create --project "<Project title>"` also works and saves a step, but it matches on the
project's title string and fails confusingly when the title has changed. `item-add` by URL is more robust.

### Features — check the board for the capability, not just the number

The issue-number check above catches the *same issue* added twice. It does not catch **the same
capability carded twice under two issue numbers**, which is the duplicate that actually happens with
features, because two people describe one capability in different words.

```bash
# What is already on the board, by title — read it before adding a feature card
gh project item-list "$PROJ" --owner "$OWNER" --format json --limit 500 \
  | jq -r '.items[] | "\(.content.number // "-")\t\(.title)"'
```

On overlap, **do not add a second card** — relate the issues instead:
`gh issue edit <new> --parent <existing>` ([relationships.md](relationships.md)). A sub-issue renders
nested under its parent, so the board cannot show the work twice as independent items. Closing one as
a duplicate would instead destroy the scope difference, which is usually the only interesting thing
about the pair.

**Best of all, do not hand-add cards.** Configure the board's built-in **auto-add** workflow so every
new issue is carded automatically. A duplicate card cannot arise from a step nobody performs.

---

## Moving a card

`item-edit` selects by name — project number plus `--owner`, the issue `--url`, the field by `--field`
and the option by `--value`. **Verified on `gh` 2.97.** Reach for this and nothing else:

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

gh project item-edit 1 --owner "$OWNER" \
  --url "https://github.com/$REPO/issues/231" \
  --field "Status" --value "In progress"
```

Three things that bite:

- **`--url` is the *issue* URL**, not a project URL. One field per invocation.
- **The value must match an option exactly**, including case and spaces. `In progress` is not
  `In Progress`. Read the options first — they are per-board.
- **`--owner` works here even where `gh project list --owner` returns nothing.** Listing a login's
  projects and editing a project you have access to are different permissions; do not infer from a
  failed `list` that `item-edit` will fail, or the reverse.
- **`unknown owner type` is usually a transient API failure, not an owner problem.** `gh` prints it
  when the call behind owner resolution fails, so during a GitHub incident it appears and disappears
  on identical commands — measured 2026-08-17 on `item-edit` (failed, then succeeded unchanged on the
  next attempt) and on `item-list` (`--limit 100` fine, `--limit 50` a 503, `--limit 200` this error).
  **Retry two or three times before concluding the command form is wrong**, and do not rewrite a
  working `--owner` invocation into the node-ID form on the strength of one failure.

Read a card's current value back — the check that proves a move landed:

```bash
gh api graphql -f query='{ node(id: "<item-id>") { ... on ProjectV2Item {
  fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } }' \
  --jq '.data.node.fieldValueByName.name // "(none)"'
```

### The node-ID form — older `gh`, or scripting

Only needed if the name-based form above is unavailable — older builds have no name-based selection,
so `item-edit` takes node IDs and every move needs four of them: project, item, field, and the option
within the field. Do not reach for this by default.

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
PROJ=1
ISSUE=231

# 1. Project ID
PROJECT_ID=$(gh project view "$PROJ" --owner "$OWNER" --format json -q .id)

# 2. Status field ID + the option ID for the value you want
FIELD_JSON=$(gh project field-list "$PROJ" --owner "$OWNER" --format json)
FIELD_ID=$(jq -r '.fields[] | select(.name=="Status") | .id' <<<"$FIELD_JSON")
# Option names are per-board and case-sensitive — this one is `In progress`, not `In Progress`.
# Read them out of FIELD_JSON rather than typing one from memory; a miss yields an empty
# OPTION_ID and step 4 then fails for a reason that does not mention the name.
OPTION_ID=$(jq -r '.fields[] | select(.name=="Status") | .options[] | select(.name=="In progress") | .id' <<<"$FIELD_JSON")
[[ -n "$OPTION_ID" ]] || { echo "no such Status option — check the exact spelling" >&2; exit 1; }

# 3. Item ID for this issue's card
ITEM_ID=$(gh project item-list "$PROJ" --owner "$OWNER" --format json --limit 500 \
  | jq -r --argjson n "$ISSUE" '.items[] | select(.content.number == $n) | .id')

# 4. Move it
gh project item-edit \
  --project-id "$PROJECT_ID" \
  --id "$ITEM_ID" \
  --field-id "$FIELD_ID" \
  --single-select-option-id "$OPTION_ID"
```

Field and option IDs are stable for the life of the board — resolve them once per session and reuse.
Item IDs are per-card; resolve per issue.

Other field types:

```bash
gh project item-edit --project-id … --id … --field-id … --text "…"          # text field
gh project item-edit --project-id … --id … --field-id … --number 3          # number field
gh project item-edit --project-id … --id … --field-id … --date 2026-09-01   # date field
gh project item-edit --project-id … --id … --field-id … --iteration-id …    # iteration
gh project item-edit --project-id … --id … --field-id … --clear             # clear a value
```

---

## Inspecting

```bash
gh project view 1 --owner "$OWNER"
gh project view 1 --owner "$OWNER" --web
gh project field-list 1 --owner "$OWNER"                              # field names and options
gh project item-list 1 --owner "$OWNER" --limit 100

# Everything currently In Progress and who owns it
gh project item-list 1 --owner "$OWNER" --format json --limit 500 \
  | jq -r '.items[] | select(.status=="In Progress")
           | "\(.content.number)\t\(.title)\t\(.content.assignees // "unassigned")"'
```

---

## When the board arrives

If a board is created later, one thing needs doing once, by a human or on explicit instruction:

1. **Turn on the built-in "auto-add" workflow first.** It cards new issues from then on, so the rest
   of this list stays a one-time backfill instead of an ongoing chore.
2. Add existing open issues: `gh issue list --state open --json url -q '.[].url'` piped into
   `gh project item-add`
3. Set each card's Status from its current `status:` label
4. Strip the `status:` labels from every issue — the board owns state from then on
5. Record in the repo's overlay `.github/GITHUB_WORKFLOW.md` (from [../assets/GITHUB_WORKFLOW.template.md](../assets/GITHUB_WORKFLOW.template.md)):
   the board **number**, its **Status option names verbatim**, which **built-in workflows are enabled**
   with their triggers and targets, and whether agents have `project` write scope. All four
   are things the next agent otherwise has to rediscover, and two of them it cannot discover at all.

Built-in workflows in the board's own settings ("auto-add items", "item closed → Done") reduce how
much of this an agent has to do. Prefer configuring those over scripting the same behaviour.

## Changing a single-select field

**Only on the operator's explicit instruction.** This rewrites a field on a shared board, and no
hook asks first: the plugin's discard gate covers git commands, not GraphQL mutations.

`updateProjectV2Field` needs **`project`** write scope — `read:project` is not enough and the failure
is an explicit `INSUFFICIENT_SCOPES`, not a silent no-op.
`gh auth refresh -s project` grants it, and only the operator runs it; note it **replaces**
`read:project` in the scope list rather than adding to it; `project` is a superset, so nothing is
lost.

**The mutation replaces the whole option set; it does not append.** List every option you want to keep
or you will delete the ones you omit — along with that value on every card carrying it.

**Before running it, read the current options and count what would be lost:**

```bash
gh api graphql -f query='{ node(id: "<project-id>") { ... on ProjectV2 {
  items(first: 100) { nodes { fieldValueByName(name: "Priority") {
    ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }' \
  --jq '[.data.node.items.nodes[] | .fieldValueByName.name // "(none)"] | group_by(.) | map("\(.[0]): \(length)") | .[]'
```

All `(none)` means the field is unused and the change is free. Anything else is data you are about to
put at risk, and the option names in your mutation must match the existing ones exactly.

```bash
gh auth refresh -s project   # interactive, and changes the token's scopes: the operator runs it, not you

FIELD_ID=$(gh api graphql -f query='{ node(id: "<project-id>") { ... on ProjectV2 {
  fields(first: 30) { nodes { ... on ProjectV2SingleSelectField { id name } } } } } }' \
  --jq '.data.node.fields.nodes[] | select(.name=="Priority") | .id')

gh api graphql -f query="
mutation {
  updateProjectV2Field(input: {
    fieldId: \"$FIELD_ID\"
    singleSelectOptions: [
      <every current option, verbatim, plus the new one — each {name: \"…\", color: <its existing colour>, description: \"…\"}>
    ]
  }) { projectV2Field { ... on ProjectV2SingleSelectField { name options { name } } } }
}"
```

Colours: `GRAY` `BLUE` `GREEN` `YELLOW` `ORANGE` `RED` `PINK` `PURPLE`. Read the current options
first and echo them back in full — that is the only safe way to add one.

## Recommended fields, if you are asked to design the board

| Field | Type | Options |
|---|---|---|
| Status | single select | Todo · In Progress · In Review · Blocked · Done |
| Priority | single select | P0 · P1 · P2 · P3 |
| Severity | single select | Sev-1 · Sev-2 · Sev-3 · Sev-4 |
| Area | single select | mirrors the `area:` labels |

Mirroring the labels rather than replacing them keeps `gh issue list --label` working for anyone not
using the board.
