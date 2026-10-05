#!/usr/bin/env bash
#
# Content checks for the shipped docs: the parts other files and the hook rely on are present,
# and the parts that belonged to the source repository are gone.

_SKILL="$PLUGIN_ROOT/skills/github-workflow"

test_every_reference_exists() {
  local f
  for f in configuration duplicate-check gh-commands issue-authoring labels project-board relationships; do
    [[ -s "$_SKILL/references/$f.md" ]] || { echo "missing references/$f.md" >&2; return 1; }
  done
}

test_references_run_the_plugins_scripts() {
  local hits
  hits=$(grep -n -H -E 'bash \.github/scripts/' "$_SKILL"/references/*.md | grep -v -i 'install' || true)
  [[ -z "$hits" ]] || { printf 'bare .github/scripts path (not every repo installs them):\n%s\n' "$hits" >&2; return 1; }
  assert_contains "$(cat "$_SKILL"/references/*.md)" "<skill-dir>/scripts/find-duplicates.sh"
}

# A plugin path can hold a space (`/c/Users/Jane Doe/...`); SKILL.md quotes every script path,
# and an agent substituting `<skill-dir>` literally needs the references to do the same.
test_the_skills_quote_the_skill_dir_in_commands() {
  local hits; hits=$(grep -r -n -E '(bash|node) <skill-dir>' "$PLUGIN_ROOT/skills" || true)
  [[ -z "$hits" ]] || { printf 'unquoted <skill-dir> in a command:\n%s\n' "$hits" >&2; return 1; }
}

# An agent copies examples. The two irreversible ones say whose call they are, and the board
# mutation shows no partial option list that would delete the options it leaves out.
test_destructive_examples_carry_an_ask_first_warning() {
  local board; board=$(cat "$_SKILL/references/project-board.md")
  assert_contains "$board" "**Only on the operator's explicit instruction.**"
  assert_contains "$board" "<every current option, verbatim, plus the new one"
  assert_not_contains "$board" '{name: \"P0\"'
  assert_contains "$board" "color: <its existing colour>"
  # every `gh auth refresh` the references show is marked as the operator's to run
  local hits; hits=$(grep -h 'gh auth refresh' "$_SKILL"/references/*.md | grep -v -i 'operator' || true)
  [[ -z "$hits" ]] || { printf 'gh auth refresh without the operator caveat:\n%s\n' "$hits" >&2; return 1; }
  assert_contains "$(grep 'gh label delete "wontfix"' "$_SKILL/references/gh-commands.md")" "the operator's call, never yours"
}

# The merged PR is the record of a normal fix. A standalone "post it even when the merge closed
# the issue" reads as an instruction to duplicate it on every merge.
test_no_resolution_comment_follows_a_normal_merge() {
  local doc; doc=$(cat "$_ASSETS/comment-templates.md")
  assert_contains "$doc" "**Do not write this after a normal merge.**"
  assert_not_contains "$doc" "Post it even when the merge closed the issue automatically."
  assert_not_contains "$(cat "$_SKILL/references/labels.md")" "the merged PR and the resolution comment"
}

# gh issue develop and gh pr create default to the repository's default branch; a literal main
# cuts from, and opens into, the wrong branch wherever the default is something else.
test_examples_leave_the_base_to_the_default_branch() {
  local hits; hits=$(grep -n -H -e '--base main' "$_MAIN" "$_SKILL"/references/*.md || true)
  [[ -z "$hits" ]] || { printf 'hard-coded --base main:\n%s\n' "$hits" >&2; return 1; }
}

# In someone else's repository, self-assigning and `gh issue develop` are visible writes too.
test_guest_mode_asks_before_self_assign_and_issue_develop() {
  local row; row=$(grep '^| Claiming |' "$_MAIN")
  assert_contains "$row" 'self-assigning (§5.2) and `gh issue develop` (§5.4)'
  assert_contains "$row" "ask first"
}

# `--all` lists at most `--limit` issues, so neither the skill nor the backlog audit the references
# recommend may present it as the whole backlog.
test_the_backlog_audit_is_sized_by_its_limit() {
  assert_contains "$(grep 'scripts/lint-issue-labels.sh' "$_MAIN")" 'stops at `--limit`'
  local hits; hits=$(grep -h -e '--all --state all' "$_SKILL"/references/*.md | grep -v -e '--limit' || true)
  [[ -z "$hits" ]] || { printf 'backlog audit without --limit:\n%s\n' "$hits" >&2; return 1; }
}

test_no_reference_points_into_a_dot_claude_directory() {
  local hits; hits=$(grep -n -H -E '\.claude/(hooks|skills)/' "$_SKILL"/references/*.md || true)
  [[ -z "$hits" ]] || { printf '%s\n' "$hits" >&2; return 1; }
}

test_the_configuration_reference_documents_every_field_and_switch() {
  local doc; doc=$(cat "$_SKILL/references/configuration.md")
  local k
  for k in '"version"' '"repo"' '"inFlightState"' '"areas"' '"closingKeywords"' '"duplicateSearch"' \
           '"labelTaxonomy"' '"deployImpact"' 'closing_keyword_gate' 'CLAUDE_PLUGIN_OPTION_CLOSING_KEYWORD_GATE' \
           '"defaultBranch"' '"discardChanges"' 'discard_gate' 'CLAUDE_PLUGIN_OPTION_DISCARD_GATE' \
           'guest' 'adopted' '--repo' 'github-workflow@github-skills' '--values-stdin'; do
    assert_contains "$doc" "$k"
  done
}

# The model reads these files. The switches stay documented for the operator, but nothing points
# a blocked agent at them, and the one place they live says they are not the agent's to use.
test_switching_a_gate_off_is_the_operators_decision() {
  local doc; doc=$(cat "$_SKILL/references/configuration.md")
  assert_contains "$doc" "Switching a gate off is the operator's decision, never an agent's."
  assert_contains "$doc" "reports the block to the operator"
  assert_not_contains "$(cat "$PLUGIN_ROOT/skills/github-workflow/SKILL.md")" "how to switch a gate off"
}

test_the_board_reference_keeps_the_mechanics_and_drops_the_measured_board() {
  local doc; doc=$(cat "$_SKILL/references/project-board.md")
  assert_contains "$doc" "## Why not \`gh project list\`"
  assert_contains "$doc" "repository(owner:"
  assert_contains "$doc" "updateProjectV2Field"
  assert_contains "$doc" "GITHUB_WORKFLOW.template.md"
  assert_not_contains "$doc" "This repo — board"
}

test_the_running_example_replaces_the_source_domain() {
  assert_contains "$(cat "$_SKILL/references/issue-authoring.md")" "Checkout returns 500 when the coupon code is blank"
  assert_contains "$(cat "$_SKILL/references/duplicate-check.md")" "coupon_code"
  assert_contains "$(cat "$_SKILL/references/duplicate-check.md")" "Per-region shipping rates"
}

test_labels_reference_documents_config_driven_areas_and_board_mode() {
  local doc; doc=$(cat "$_SKILL/references/labels.md")
  assert_contains "$doc" "--areas"
  assert_contains "$doc" "--board"
  assert_contains "$doc" "github-workflow.json"
}

_ASSETS="$PLUGIN_ROOT/skills/github-workflow/assets"

test_every_asset_exists() {
  local f
  for f in comment-templates.md pull_request_template.md GITHUB_WORKFLOW.template.md \
           github-workflow.example.json AGENTS.snippet.md ISSUE_TEMPLATE/1-bug.yml \
           ISSUE_TEMPLATE/2-feature.yml ISSUE_TEMPLATE/3-enhancement.yml ISSUE_TEMPLATE/4-chore.yml \
           ISSUE_TEMPLATE/config.yml; do
    [[ -s "$_ASSETS/$f" ]] || { echo "missing assets/$f" >&2; return 1; }
  done
}

# Setup installs these files into other people's repositories, where a PR body pre-filled from
# a template, or text copied out of one, can carry a closing keyword. Examples use a placeholder
# (#NNN), never a real-looking issue number.
test_no_asset_carries_a_closing_keyword_with_an_issue_number() {
  local hits
  hits=$(grep -rn -i -E '(close[sd]?|fix(e[sd])?|resolve[sd]?):?[[:space:]]+#[0-9]' "$_ASSETS" || true)
  [[ -z "$hits" ]] || { printf 'closing keyword with a real-looking number:\n%s\n' "$hits" >&2; return 1; }
}

test_issue_forms_apply_their_type_and_triage_only() {
  local pair form type
  for pair in 1-bug:type:bug 2-feature:type:feature 3-enhancement:type:enhancement 4-chore:type:chore; do
    form="${pair%%:*}"; type="${pair#*:}"
    assert_contains "$(grep '^labels:' "$_ASSETS/ISSUE_TEMPLATE/$form.yml")" "\"$type\", \"status:needs-triage\""
  done
}

test_issue_forms_keep_examples_out_of_the_title_key() {
  # GitHub pre-fills the title box with a form's `title:` verbatim.
  local hits; hits=$(grep -l '^title:' "$_ASSETS"/ISSUE_TEMPLATE/*.yml || true)
  assert_eq "" "$hits"
}

test_the_contact_links_keep_their_placeholder_for_setup() {
  assert_contains "$(cat "$_ASSETS/ISSUE_TEMPLATE/config.yml")" "OWNER/REPO"
}

test_comment_templates_keep_all_seven_sections() {
  local doc s; doc=$(cat "$_ASSETS/comment-templates.md")
  for s in "## 1. Pick-up" "## 2. Implemented" "## 3. Resolved" "## 3a. Correction" \
           "## 4. Closing without a fix" "## 5. Blocked" "## 6. Handover"; do
    assert_contains "$doc" "$s"
  done
}

test_the_overlay_template_has_every_section() {
  local doc s; doc=$(cat "$_ASSETS/GITHUB_WORKFLOW.template.md")
  for s in "## Repo constants" "## Project board" "## Severity in this domain" "## Areas" \
           "## Deploy rules" "## Failure modes seen here"; do
    assert_contains "$doc" "$s"
  done
}

test_the_example_config_is_valid_json_with_every_field() {
  jq -e '.version == 1 and (.repo|type=="string") and (.inFlightState|type=="string")
         and (.areas|type=="array") and (.gates.deployImpact.paths|type=="array")
         and (.gates.defaultBranch|type=="boolean") and (.gates.discardChanges|type=="boolean")' \
    "$_ASSETS/github-workflow.example.json" >/dev/null
}

_MAIN="$PLUGIN_ROOT/skills/github-workflow/SKILL.md"

test_primary_skill_frontmatter() {
  local head; head=$(sed -n '1,12p' "$_MAIN")
  assert_contains "$head" "name: github-workflow"
  assert_contains "$head" "description:"
  assert_contains "$head" "license: MIT"
}

test_primary_skill_fits_its_budget() {
  # Anthropic's skill-authoring guidance: keep a SKILL.md body under 500 lines and move
  # detail into files it links to.
  local lines; lines=$(wc -l <"$_MAIN" | tr -d ' ')
  [[ "$lines" -lt 500 ]] || { echo "SKILL.md is $lines lines; it must stay under 500" >&2; return 1; }
}

test_primary_skill_keeps_the_ten_rules() {
  local n
  for n in 1 2 3 4 5 6 7 8 9 10; do
    grep -qE "^$n\. \*\*" "$_MAIN" || { echo "rule $n missing" >&2; return 1; }
  done
}

# Codex, Cursor and Copilot cannot reach the plugin directory, so the pointers name the public
# copy of the skill; and setup offers the overlay separately, so the snippet cannot assume it.
test_the_agents_pointers_reach_the_skill_without_the_plugin() {
  local url="https://github.com/SajidSalim/github-skills/tree/main/plugins/github-workflow/skills/github-workflow"
  assert_contains "$(cat "$_ASSETS/AGENTS.snippet.md")" "$url"
  assert_contains "$(cat "$_ASSETS/GITHUB_WORKFLOW.template.md")" "$url"
  assert_contains "$(cat "$_ASSETS/AGENTS.snippet.md")" '`.github/GITHUB_WORKFLOW.md`, if present'
}

# A coding subagent may never load the skill, so the branch and discard rules also travel in the
# AGENTS.md snippet; and §5.4 shows how to branch without switching a checkout that is not yours.
test_the_branch_and_discard_rules_reach_every_agent() {
  local f
  for f in "$_MAIN" "$_ASSETS/AGENTS.snippet.md"; do
    assert_contains "$(cat "$f")" "Never edit, commit to or merge into the default branch"
    assert_contains "$(cat "$f")" "Never switch the branch of a checkout you did not create"
    assert_contains "$(cat "$f")" "Never run a command that discards uncommitted changes"
    assert_contains "$(cat "$f")" "git diff -- <paths> > <file>"
  done
  assert_contains "$(cat "$_MAIN")" "git worktree add ../231-checkout-blank-coupon fix/231-checkout-blank-coupon"
  assert_contains "$(cat "$_MAIN")" "In both cases the plugin's hook asks the"
  assert_contains "$(cat "$_MAIN")" "before such a discard, in every repository"
}

test_primary_skill_runs_scripts_through_its_own_directory() {
  local doc; doc=$(cat "$_MAIN")
  assert_contains "$doc" '"${CLAUDE_SKILL_DIR}/scripts/find-duplicates.sh"'
  assert_contains "$doc" '"${CLAUDE_SKILL_DIR}/scripts/lint-issue-labels.sh"'
  assert_contains "$doc" '"${CLAUDE_SKILL_DIR}/scripts/bootstrap-labels.sh"'
  assert_not_contains "$doc" "bash .github/scripts/find-duplicates.sh"
}

test_primary_skill_defines_both_modes() {
  local doc; doc=$(cat "$_MAIN")
  assert_contains "$doc" ".github/github-workflow.json"
  assert_contains "$doc" "## 10. Guest mode"
  assert_contains "$doc" "/github-workflow:setup"
}

test_primary_skill_keeps_the_hard_won_mechanisms() {
  local doc s; doc=$(cat "$_MAIN")
  for s in "projectsV2" "gh issue develop" "Thread checked:" "Searched:" "Candidates:" "Verdict:" \
           "does not read negations" "resolution:" "--duplicate-of" "one writer per transition"; do
    assert_contains "$doc" "$s"
  done
}

# The linter allows at most one status: label, so guidance that stacks two is blocked by the
# plugin's own taxonomy gate in an adopted repo. status: moves by swapping.
test_status_labels_are_swapped_never_stacked() {
  assert_contains "$(cat "$_MAIN")" "swap, never stack"
  assert_not_contains "$(cat "$_MAIN")" "remove both on close"
  assert_contains "$(cat "$_SKILL/references/gh-commands.md")" \
    '--remove-label "status:in-progress" --add-label "status:needs-review"'
  assert_contains "$(cat "$_ASSETS/comment-templates.md")" \
    "--remove-label status:in-progress --add-label status:blocked"
  assert_not_contains "$(cat "$_ASSETS/comment-templates.md")" "Apply \`status:blocked\`"
}

# A branch linked with `gh issue develop` closes its issue on merge whatever the PR says, so the
# link goes to the issue certain to close -- never simply the first. And guest mode keeps §7's
# keyword rules but not its type:/area: PR labels, which a guest repo may not have.
test_linking_and_guest_pr_guidance_agree_with_the_rules() {
  local gh; gh=$(cat "$_SKILL/references/gh-commands.md")
  assert_not_contains "$gh" "first issue only"
  assert_contains "$gh" "run this for the one issue that should certainly close"
  local row; row=$(grep '^| PRs |' "$_MAIN")
  assert_contains "$row" "closing-keyword rules unchanged"
  assert_contains "$row" "the repo's own"
}

test_primary_skill_defers_attribution_to_the_repo() {
  local doc; doc=$(cat "$_MAIN")
  assert_not_contains "$doc" "Never add authorship"
  assert_contains "$doc" "attribution"
}

test_setup_and_doctor_are_user_only() {
  local s
  for s in setup doctor; do
    grep -q '^disable-model-invocation: true$' "$PLUGIN_ROOT/skills/$s/SKILL.md" \
      || { echo "$s must not be model-invoked" >&2; return 1; }
    grep -q "^name: $s$" "$PLUGIN_ROOT/skills/$s/SKILL.md" || { echo "$s: bad name" >&2; return 1; }
  done
}

test_setup_confirms_before_acting_and_never_force_pushes() {
  local doc; doc=$(cat "$PLUGIN_ROOT/skills/setup/SKILL.md")
  assert_contains "$doc" "wait for a yes"
  assert_contains "$doc" "Nothing is committed"
  assert_contains "$doc" "ask before running any of them"
  # gh pr create aborts on an unpushed branch when there is no TTY, so the hand-off proposes a push
  assert_contains "$doc" "git push -u origin"
  assert_not_contains "$doc" "push --force"
  assert_contains "$doc" '${CLAUDE_PLUGIN_ROOT}/skills/github-workflow/scripts/bootstrap-labels.sh'
  # doctor is user-only, so setup cannot invoke it; it runs the self-check and hands doctor over
  assert_contains "$doc" '${CLAUDE_PLUGIN_ROOT}/hooks/check-issue-workflow.mjs" --self-check'
  assert_contains "$doc" "git rev-parse --show-toplevel"
}

test_doctor_runs_the_hook_self_check_and_changes_nothing() {
  local doc; doc=$(cat "$PLUGIN_ROOT/skills/doctor/SKILL.md")
  assert_contains "$doc" '${CLAUDE_PLUGIN_ROOT}/hooks/check-issue-workflow.mjs" --self-check'
  assert_contains "$doc" "Read-only"
  assert_contains "$doc" "github-workflow@github-skills"
}

# Once setup writes the config, the branch gate asks before every edit on the default branch, so
# the branch is proposed before the first write, never at the end.
test_setup_branches_before_its_first_write() {
  local f="$PLUGIN_ROOT/skills/setup/SKILL.md" branch write
  branch=$(grep -n 'git checkout -b <branch> <base>' "$f" | head -1 | cut -d: -f1)
  write=$(grep -n 'Write `.github/github-workflow.json`' "$f" | head -1 | cut -d: -f1)
  [[ -n "$branch" && -n "$write" && "$branch" -lt "$write" ]] \
    || { echo "setup must branch before it writes (branch:${branch:-none} write:${write:-none})" >&2; return 1; }
  # a checkout with changes that are not this run's is never switched: the worktree route
  assert_contains "$(cat "$f")" "git worktree add -b <branch> ../adopt-github-workflow <base>"
}

# Claude Code reads AGENTS.md only when there is no CLAUDE.md, so setup offers the import and doctor
# reports its absence.
test_setup_and_doctor_see_that_the_agents_pointer_reaches_claude() {
  assert_contains "$(cat "$PLUGIN_ROOT/skills/setup/SKILL.md")" '`@AGENTS.md`'
  assert_contains "$(cat "$PLUGIN_ROOT/skills/setup/SKILL.md")" 'Claude Code reads `AGENTS.md` on its own only when there is'
  assert_contains "$(cat "$PLUGIN_ROOT/skills/doctor/SKILL.md")" "CLAUDE.md does not import AGENTS.md"
}

# GitHub reads PR and issue templates from more places than the files setup installs, so a
# repository can end up with two PR description files or two bug forms.
test_setup_finds_existing_templates_at_other_paths() {
  local doc; doc=$(cat "$PLUGIN_ROOT/skills/setup/SKILL.md")
  assert_contains "$doc" "PULL_REQUEST_TEMPLATE/"
  assert_contains "$doc" ".github/ISSUE_TEMPLATE/"
  assert_contains "$doc" "**replace**"
  assert_contains "$doc" "blank_issues_enabled: false"
  assert_contains "$doc" 'Never `git rm` it'
}

# The search runs as written in the skill: the files setup itself installs are left out, so
# "replace" can never remove one, while their letter-case variants and the other paths stay in.
test_setup_template_search_leaves_out_its_own_install_paths() {
  local f="$PLUGIN_ROOT/skills/setup/SKILL.md" filters out
  # The pipeline's grep stages, joined back into one pipeline.
  filters=$(awk '/^git ls-files -co --exclude-standard/ {on=1; next} on && /^```/ {exit} on {print}' "$f" \
    | sed -e 's/^ *| *//' -e 's/ *\\$//' | paste -s -d '|' -)
  [[ "$filters" == grep* ]] || { echo "template search not found in setup" >&2; return 1; }
  out=$(printf '%s\n' \
    .github/pull_request_template.md .github/ISSUE_TEMPLATE/1-bug.yml .github/ISSUE_TEMPLATE/4-chore.yml \
    .github/ISSUE_TEMPLATE/config.yml .github/PULL_REQUEST_TEMPLATE.md docs/pull_request_template.md \
    .github/PULL_REQUEST_TEMPLATE/a.md .github/ISSUE_TEMPLATE/bug_report.yml src/pull_request_template.md \
    .github/ISSUE_TEMPLATE/2-bug.yml \
    | eval "$filters")
  # 2-bug.yml is the repository's own form, not setup's 1-bug.yml: it must get the question.
  assert_eq ".github/PULL_REQUEST_TEMPLATE.md
docs/pull_request_template.md
.github/PULL_REQUEST_TEMPLATE/a.md
.github/ISSUE_TEMPLATE/bug_report.yml
.github/ISSUE_TEMPLATE/2-bug.yml" "$out"
}

# The Security contact link tells reporters not to open a public issue, so it must lead somewhere.
test_setup_checks_private_vulnerability_reporting_before_keeping_the_security_link() {
  assert_contains "$(cat "$PLUGIN_ROOT/skills/setup/SKILL.md")" "private-vulnerability-reporting"
  assert_contains "$(cat "$PLUGIN_ROOT/skills/setup/SKILL.md")" "/security/policy"
  assert_contains "$(cat "$_ASSETS/ISSUE_TEMPLATE/config.yml")" "private-vulnerability-reporting"
}

test_setup_never_deletes_labels_itself() {
  local doc; doc=$(cat "$PLUGIN_ROOT/skills/setup/SKILL.md")
  # deleting a label strips it from every issue carrying it: the skill prints the loop, the operator runs it
  assert_contains "$doc" "for the operator to run"
  assert_contains "$doc" "gh label delete"
  assert_contains "$doc" "strips it from every issue"
  assert_not_contains "$doc" "never run it without an explicit yes"
}

test_setup_hand_off_branches_and_stages_deliberately() {
  local doc; doc=$(cat "$PLUGIN_ROOT/skills/setup/SKILL.md")
  # it looks at the tree and the branch first, so a feature branch's commits never ride along
  assert_contains "$doc" "git status --short"
  assert_contains "$doc" "git branch --show-current"
  assert_contains "$doc" "git ls-remote --heads origin"
  # it stages an explicit file list, never a whole directory or everything
  assert_not_contains "$doc" "git add .github/"
  if grep -qE 'git add (-A|\.|\.github/?)( |$|#)' "$PLUGIN_ROOT/skills/setup/SKILL.md"; then
    echo "setup must name the files it stages, not a directory" >&2
    return 1
  fi
}

test_versions_agree_across_manifests_and_changelog() {
  local a b c
  a=$(jq -r .version "$PLUGIN_ROOT/.claude-plugin/plugin.json" | tr -d '\r')
  b=$(jq -r '.plugins[] | select(.name == "github-workflow") | .version' "$REPO_ROOT/.claude-plugin/marketplace.json" | tr -d '\r')
  c=$(grep -m1 -oE '^## \[?[0-9]+\.[0-9]+\.[0-9]+' "$PLUGIN_ROOT/CHANGELOG.md" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
  assert_eq "$a" "$b" "plugin.json vs marketplace.json"
  assert_eq "$a" "$c" "plugin.json vs CHANGELOG.md"
}

# What the ask gates do not see is stated, so nobody mistakes silence for coverage.
test_the_readme_states_the_ask_gates_limits() {
  local doc; doc=$(cat "$PLUGIN_ROOT/README.md")
  local s
  for s in '`git pull`' '`git rebase`' '`git reset --soft`' '`git branch -f`' 'bash -c' 'find -exec'; do
    assert_contains "$doc" "$s"
  done
}

test_the_plugin_readme_covers_the_essentials() {
  local doc h; doc=$(cat "$PLUGIN_ROOT/README.md")
  for h in "## Install" "## Quick start" "## Requirements" "## Modes" "## Gates" "## Configuration" \
           "## Commands" "## Using it with other agents" "## Troubleshooting" "## Token cost" \
           "## Running the tests" "## License"; do
    assert_contains "$doc" "$h"
  done
}

test_the_marketplace_readme_has_the_install_commands() {
  local doc; doc=$(cat "$REPO_ROOT/README.md")
  assert_contains "$doc" "/plugin marketplace add SajidSalim/github-skills"
  assert_contains "$doc" "/plugin install github-workflow@github-skills"
}

# `claude plugin tag` tags whatever is checked out, so the runbook merges first; and a marketplace
# install clones the whole repository, so the guide keeps private material out of it.
test_the_publishing_guide_merges_before_tagging() {
  local f="$REPO_ROOT/docs/publishing.md" merge tag
  merge=$(grep -n 'merge it into `main`' "$f" | head -1 | cut -d: -f1)
  tag=$(grep -n 'claude plugin tag plugins/github-workflow --push' "$f" | head -1 | cut -d: -f1)
  [[ -n "$merge" && -n "$tag" && "$merge" -lt "$tag" ]] \
    || { echo "publishing.md must merge into main before it tags (merge:${merge:-none} tag:${tag:-none})" >&2; return 1; }
  assert_contains "$(cat "$f")" "## Keep private material out of this repository"
}

# The suites pin the setup and doctor skills' text, not their behaviour, so each release runs
# the adoption flow once in a session.
test_the_publishing_guide_runs_setup_and_doctor_live() {
  local doc; doc=$(cat "$REPO_ROOT/docs/publishing.md")
  assert_contains "$doc" "/github-workflow:setup --dry-run"
  assert_contains "$doc" "/github-workflow:doctor"
  assert_contains "$doc" "throwaway GitHub repository"
}

test_licenses_are_mit_and_name_the_owner() {
  # The owner's name is read from the manifest, not written here: the scrub test allows the
  # login only in plugin.json, LICENSE and the repository URLs.
  local f owner; owner=$(jq -r .author.name "$PLUGIN_ROOT/.claude-plugin/plugin.json" | tr -d '\r')
  for f in "$REPO_ROOT/LICENSE" "$PLUGIN_ROOT/LICENSE"; do
    assert_contains "$(cat "$f")" "MIT License"
    assert_contains "$(cat "$f")" "Copyright (c) 2026 $owner"
  done
}
