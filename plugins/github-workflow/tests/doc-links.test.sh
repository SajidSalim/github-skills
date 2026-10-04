#!/usr/bin/env bash
#
# Tests for tests/lib/check-doc-links.sh, then the real check over the plugin's docs. The
# workflow is split across a skill and seven references; the split only works if the pointers
# land. A dead pointer silently returns an agent to guessing.

_check() { run_cmd bash "$PLUGIN_ROOT/tests/lib/check-doc-links.sh" "$@"; }

test_a_resolving_relative_link_passes() {
  write_file "$TEST_TMP/docs/guide.md" <<<"# guide"
  write_file "$TEST_TMP/docs/index.md" <<<'See [the guide](guide.md).'
  _check "$TEST_TMP/docs"
  assert_eq 0 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "1 relative link(s) checked · 0 dead"
}

test_a_dead_link_fails_and_names_both_ends() {
  write_file "$TEST_TMP/docs/index.md" <<<'See [the missing one](nope/missing.md).'
  _check "$TEST_TMP/docs"
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "DEAD"
  assert_contains "$RUN_OUT" "index.md"
  assert_contains "$RUN_OUT" "nope/missing.md"
}

test_absolute_urls_and_anchors_are_not_checked() {
  write_file "$TEST_TMP/docs/index.md" <<'MD'
[web](https://example.com/x.md)
[insecure](http://example.com/y.md)
[mail](mailto:someone@example.com)
[anchor](#a-heading)
MD
  _check "$TEST_TMP/docs"
  assert_eq 0 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "0 relative link(s) checked"
}

test_a_fragment_is_stripped_before_resolving() {
  write_file "$TEST_TMP/docs/src/thing.ts" <<<'export {}'
  write_file "$TEST_TMP/docs/index.md" <<<'[thing](src/thing.ts#L1-L3)'
  _check "$TEST_TMP/docs"
  assert_eq 0 "$RUN_STATUS"
}

test_links_resolve_relative_to_their_own_file() {
  write_file "$TEST_TMP/docs/references/labels.md" <<<'# labels'
  write_file "$TEST_TMP/docs/references/other.md" <<<'[labels](labels.md)'
  _check "$TEST_TMP/docs"
  assert_eq 0 "$RUN_STATUS"
}

test_installable_templates_are_skipped() {
  write_file "$TEST_TMP/docs/GITHUB_WORKFLOW.template.md" <<<'[only after install](../AGENTS.md)'
  write_file "$TEST_TMP/docs/AGENTS.snippet.md" <<<'[only after install](.github/GITHUB_WORKFLOW.md)'
  _check "$TEST_TMP/docs"
  assert_eq 0 "$RUN_STATUS"
}

test_one_dead_link_among_several_still_fails() {
  write_file "$TEST_TMP/docs/a.md" <<<'# a'
  write_file "$TEST_TMP/docs/index.md" <<'MD'
[good](a.md)
[bad](a_typo.md)
MD
  _check "$TEST_TMP/docs"
  assert_eq 1 "$RUN_STATUS"
  assert_contains "$RUN_OUT" "2 relative link(s) checked · 1 dead"
}

test_the_plugin_and_marketplace_docs_have_no_dead_links() {
  local targets=("$PLUGIN_ROOT")
  [[ -f "$REPO_ROOT/README.md" ]] && targets+=("$REPO_ROOT/README.md")
  _check "${targets[@]}"
  assert_eq 0 "$RUN_STATUS" "$RUN_OUT"
}
