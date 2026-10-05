/**
 * Process-level tests for check-issue-workflow.mjs. The exit code IS the contract -- 2 blocks
 * and feeds stderr to the model, anything else does not -- so the hook is spawned as a real
 * process with a payload on stdin.
 *
 * Fixtures are temp directories whose paths contain a space, as Windows profile paths often
 * do. repoDir() makes something that looks like a repository root (a .git directory and,
 * optionally, a config); pluginTree() makes a throwaway plugin holding a copy of the hook and a
 * stub linter, because the hook finds its linter relative to itself.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, copyFileSync, symlinkSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../../hooks/check-issue-workflow.mjs", import.meta.url));

const temps = [];
const temp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), `ghwf ${prefix}-`));
  temps.push(d);
  return d;
};
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const ADOPTED = { version: 1, repo: "acme/shop", inFlightState: "labels", areas: ["api", "ci"] };
const BLOCK = `**Searched:** \`coupon in:title\`
**Candidates:** none
**Verdict:** file`;

function repoDir(config, { raw } = {}) {
  const dir = temp("repo");
  mkdirSync(join(dir, ".git"));
  if (config !== undefined || raw !== undefined) {
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github", "github-workflow.json"), raw ?? JSON.stringify(config));
  }
  return dir;
}

function pluginTree(linterBody) {
  const root = temp("plugin");
  mkdirSync(join(root, "hooks"));
  copyFileSync(HOOK, join(root, "hooks", "check-issue-workflow.mjs"));
  if (linterBody !== undefined) {
    const scripts = join(root, "skills", "github-workflow", "scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "lint-issue-labels.sh"), linterBody);
  }
  return join(root, "hooks", "check-issue-workflow.mjs");
}

function runHook(payload, { hook = HOOK, env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [hook], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    cwd,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_OPTION_CLOSING_KEYWORD_GATE: "",
      CLAUDE_PLUGIN_OPTION_DISCARD_GATE: "",
      ...env,
    },
  });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

const pre = (command, cwd) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  cwd,
  tool_input: { command },
});

const post = (command, stdout, cwd) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  cwd,
  tool_input: { command },
  tool_response: { stdout, stderr: "", interrupted: false },
});

const bashAvailable = spawnSync("bash", ["-c", "exit 0"]).error === undefined;
const gitAvailable = spawnSync("git", ["--version"]).error === undefined;
const NEGATED_PR = `gh pr create --title t --body "This does not close #12"`;

// ------------------------------------------------------------------ pre: the duplicate gate

describe("PreToolUse — duplicate gate", () => {
  let dir;
  before(() => { dir = repoDir(ADOPTED); });

  test("blocks a create with no body at all", () => {
    const r = runHook(pre(`gh issue create --title "x" --label type:chore`, dir));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no duplicate-search record/);
  });

  test("blocks a create whose body lacks the block", () => {
    const r = runHook(pre(`gh issue create --title "x" --body "just a description"`, dir));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing: searched, candidates, verdict/);
  });

  test("names only the lines actually missing", () => {
    const r = runHook(pre(`gh issue create -b "**Searched:** q · **Verdict:** file"`, dir));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing: candidates/);
    assert.doesNotMatch(r.stderr, /missing:.*searched/);
  });

  test("passes a create carrying the full block", () => {
    const r = runHook(pre(`gh issue create --title "x" --body ${JSON.stringify(BLOCK)}`, dir));
    assert.equal(r.status, 0);
  });

  test("passes --web: the form applies labels and a human is in the loop", () => {
    const r = runHook(pre(`gh issue create --web`, dir));
    assert.equal(r.status, 0);
  });

  test("passes when the body arrives on stdin, which it cannot read", () => {
    const r = runHook(pre(`gh issue create --body-file -`, dir));
    assert.equal(r.status, 0);
  });

  test("does not fire on edit", () => {
    assert.equal(runHook(pre(`gh issue edit 7 --add-label x`, dir)).status, 0);
  });

  test("does not fire on an unrelated command", () => {
    assert.equal(runHook(pre(`git status`, dir)).status, 0);
  });

  test("does not fire on gh issue comment", () => {
    assert.equal(runHook(pre(`gh issue comment 7 --body "no block here"`, dir)).status, 0);
  });

  // A regression guard for the duplicate-search gate specifically, not evidence the tokenizer
  // fix works: it passes identically before and after that fix, because `resolveBody`'s
  // fallback for "no body flag visible at all" is an empty string, and an empty body IS
  // missing every marker -- so `missingMarkers` still blocks even when `args` was truncated.
  // This locks in that the fix does not newly let a non-compliant multi-line body slip past
  // *this* gate. It is not proof the bug is harmless: round-1 review found the tokenizer
  // fails OPEN, silently, on a *different* gate for this identical shape (the
  // accidental-closing-keyword check, "PreToolUse -- --body-file" below) precisely because
  // that gate's own empty-body fallback returns no violations rather than "everything is
  // missing". Both directions are real; this test only pins the one that happens to be safe.
  test("blocks a multi-line create whose continuation-lines body lacks the block", () => {
    const cmd =
      'gh issue create \\\n  --title "x" \\\n  --body "just a description" \\\n' +
      '  --label "type:bug"';
    const r = runHook(pre(cmd, dir));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing: searched, candidates, verdict/);
  });

  test("does not block a commit message that quotes the command", () => {
    const commit = `git commit -F - <<'EOF'
chore: enforce the gate

  PreToolUse  gh issue create with no Searched: block -> exit 2.
EOF
git log --oneline -1`;
    assert.equal(runHook(pre(commit, dir)).status, 0);
  });
});

describe("PreToolUse — --body-file", () => {
  let dir;
  before(() => {
    dir = repoDir(ADOPTED);
    writeFileSync(join(dir, "good.md"), BLOCK);
    writeFileSync(join(dir, "bad.md"), "no record here");
  });

  test("reads the file rather than treating the path as the body", () => {
    assert.equal(runHook(pre(`gh issue create --body-file good.md`, dir)).status, 0);
  });

  test("blocks when the file lacks the block", () => {
    const r = runHook(pre(`gh issue create --body-file bad.md`, dir));
    assert.equal(r.status, 2);
  });

  test("accepts -F as the short form", () => {
    assert.equal(runHook(pre(`gh issue create -F good.md`, dir)).status, 0);
  });

  test("passes when the file does not exist -- unreadable is not the same as missing", () => {
    assert.equal(runHook(pre(`gh issue create --body-file nope.md`, dir)).status, 0);
  });

  test("resolves the path against the payload cwd, not the hook's", () => {
    const r = runHook(pre(`gh issue create --body-file bad.md`, dir), { cwd: tmpdir() });
    assert.equal(r.status, 2);
  });

  // One flag per line, joined by backslash continuations, must not cut --body-file off the args.
  test("does not wrongly block a compliant multi-line create split across continuations", () => {
    const cmd = `gh issue create --title "x" \\\n  --body-file good.md \\\n  --label "type:bug"`;
    const r = runHook(pre(cmd, dir));
    assert.equal(r.status, 0);
  });

  // The same shape on a PR must not silently skip the closing-keyword gate.
  test("does not silently skip the closing-keyword gate on a multi-line pr create", () => {
    writeFileSync(join(dir, "pr.md"), "Deploy impact: none\n\nNote: this does not close #17.\n");
    const r = runHook(pre(`gh pr create --title "x" \\\n  --body-file pr.md`, dir));
    assert.equal(r.status, 2);
  });

  // A second, different route to the same silent skip: when the continuation falls right
  // after the bare `gh` token (before `issue`/`pr`), `findGhTarget` never matches at all --
  // its loop requires `toks[i + 1].v` to be exactly "issue" or "pr", and the stray backslash
  // token from the tokenizer bug sits there instead. `main()` then exits 0 at the `!found`
  // check, before ANY gate runs -- not just the closing-keyword one, but the duplicate-search
  // gate too, which is otherwise the gate this bug fails *closed*, not open.
  test("does not silently skip every gate when 'gh' itself is line-continued", () => {
    const r = runHook(pre(`gh \\\n  issue create --body "no block here"`, dir));
    assert.equal(r.status, 2);
  });
});

// ------------------------------------------------------------------ pre: bodies the shell builds
//
// The hook must judge the body gh will actually send. Claude Code's own default PR form is
// `--body "$(cat <<'EOF' ... EOF\n)"`, and the skill's references write a body file and create
// in one call. Judging the unexpanded `$(cat ...)` text, or a stale copy of a file the command is
// about to rewrite, either waves a negated keyword through or blocks a compliant body.

describe("PreToolUse — bodies the shell builds", () => {
  const heredoc = (head, text) => `${head} --body "$(cat <<'EOF'\n${text}\nEOF\n)"`;
  const RECORD = "**Searched:** `coupon in:title` · `coupon` — all states\n**Candidates:** none\n**Verdict:** file";

  test("guest: a negated keyword inside a --body heredoc is blocked", () => {
    const r = runHook(pre(heredoc("gh pr create --title t", "## Summary\n\nThis does not close #12."), temp("guest")));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /line 3: negated/);
  });

  test("guest: the same heredoc saying Refs passes", () => {
    const r = runHook(pre(heredoc("gh pr create --title t", "## Summary\n\nRefs #12."), temp("guest")));
    assert.equal(r.status, 0);
  });

  test("guest: a --body heredoc on a continued line is still the gh command's own", () => {
    const cmd = heredoc("gh pr create --title t \\\n  --base main \\\n ", "This does not close #12.");
    assert.equal(runHook(pre(cmd, temp("guest"))).status, 2);
  });

  test("guest: a body file written by a heredoc in the same command is judged", () => {
    const dir = temp("guest");
    assert.equal(existsSync(join(dir, "pr.md")), false, "the file must not exist when the hook runs");
    const cmd = `cat > pr.md <<'EOF'\nThis does not close #12.\nEOF\ngh pr create --title t --body-file pr.md`;
    assert.equal(runHook(pre(cmd, dir)).status, 2);
  });

  test("a stale body file is not judged: the heredoc rewriting it is", () => {
    const dir = temp("guest");
    writeFileSync(join(dir, "pr.md"), "This does not close #12.\n");
    const cmd = `cat > pr.md <<'EOF'\nRefs #12\nEOF\ngh pr create --title t --body-file pr.md`;
    assert.equal(runHook(pre(cmd, dir)).status, 0);
  });

  test("a heredoc appended to the body file is judged with what the file already holds", () => {
    const dir = temp("guest");
    writeFileSync(join(dir, "pr.md"), "This does not close #12.\n");
    const cmd = `cat >> pr.md <<'EOF'\nRefs #13\nEOF\ngh pr create --title t --body-file pr.md`;
    assert.equal(runHook(pre(cmd, dir)).status, 2);
  });

  test("a body file the command writes some other way is skipped, never judged stale", () => {
    const dir = temp("guest");
    writeFileSync(join(dir, "pr.md"), "This does not close #12.\n");
    const cmd = `echo "Refs #12" > pr.md && gh pr create --title t --body-file pr.md`;
    assert.equal(runHook(pre(cmd, dir)).status, 0);
  });

  test("so is one written through tee", () => {
    const dir = temp("guest");
    writeFileSync(join(dir, "pr.md"), "This does not close #12.\n");
    const cmd = `echo "Refs #12" | tee pr.md && gh pr create --title t --body-file pr.md`;
    assert.equal(runHook(pre(cmd, dir)).status, 0);
  });

  test("a heredoc on stdin is judged", () => {
    const cmd = `gh pr create --title t --body-file - <<'EOF'\nThis does not close #12.\nEOF`;
    assert.equal(runHook(pre(cmd, temp("guest"))).status, 2);
  });

  test("a single-quoted body is literal, backticks and all, and still judged", () => {
    const cmd = "gh pr create --title t --body 'Fixes the `checkout` path. This does not close #12.'";
    assert.equal(runHook(pre(cmd, temp("guest"))).status, 2);
  });

  test("adopted: a full record inside a --body heredoc passes the duplicate gate", () => {
    const r = runHook(pre(heredoc("gh issue create --title t", `## What\n\nA bug.\n\n${RECORD}`), repoDir(ADOPTED)));
    assert.equal(r.status, 0);
  });

  test("adopted: the same heredoc without the record is blocked", () => {
    const r = runHook(pre(heredoc("gh issue create --title t", "## What\n\nA bug."), repoDir(ADOPTED)));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing: searched, candidates, verdict/);
  });

  test("adopted: a body built by $(cat FILE) is skipped, not reported missing", () => {
    const dir = repoDir(ADOPTED);
    writeFileSync(join(dir, "issue.md"), `${RECORD}\n`);
    const r = runHook(pre(`gh issue create --title t --body "$(cat issue.md)"`, dir));
    assert.equal(r.status, 0);
  });

  test("adopted: a body held in a shell variable is skipped too", () => {
    const dir = repoDir(ADOPTED);
    writeFileSync(join(dir, "issue.md"), `${RECORD}\n`);
    const r = runHook(pre(`BODY=$(cat issue.md); gh issue create --title t --body "$BODY"`, dir));
    assert.equal(r.status, 0);
  });

  // Expansions only add text: a literal negated keyword stays in the body whatever $USER holds.
  test("guest: a negated keyword beside a $VAR in an inline body is still blocked", () => {
    const r = runHook(pre(`gh pr create --title t --body "This does not close #12 for $USER."`, temp("guest")));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /negated/);
  });

  test("guest: the same body saying Refs passes", () => {
    assert.equal(runHook(pre(`gh pr create --title t --body "Refs #12 for $USER."`, temp("guest"))).status, 0);
  });

  test("guest: a keyword only inside a command substitution's own text is not judged", () => {
    const cmd = `gh pr create --title t --body "Summary: $(printf 'does not close #%s' 12)"`;
    assert.equal(runHook(pre(cmd, temp("guest"))).status, 0);
  });

  test("adopted: an issue body written by a heredoc in the same command is judged", () => {
    const dir = repoDir(ADOPTED);
    const ok = `cat > issue.md <<'EOF'\n${RECORD}\nEOF\ngh issue create --title t --body-file issue.md`;
    assert.equal(runHook(pre(ok, dir)).status, 0);
    const bad = `cat > issue.md <<'EOF'\nA bug.\nEOF\ngh issue create --title t --body-file issue.md`;
    assert.equal(runHook(pre(bad, dir)).status, 2);
  });

  // Git Bash maps /tmp to %TEMP%; Node resolving it as C:\tmp read nothing, or the wrong file.
  test("Windows: a body file at a POSIX path written by bash is read", {
    skip: process.platform !== "win32" || !bashAvailable,
  }, () => {
    const name = `ghwf-hook-${process.pid}-${Date.now()}.md`;
    const w = spawnSync("bash", ["-c", `printf '%s\\n' 'This does not close #12.' > /tmp/${name}`]);
    assert.equal(w.status, 0, "bash must be able to write /tmp");
    try {
      const r = runHook(pre(`gh pr create --title t --body-file /tmp/${name}`, temp("guest")));
      assert.equal(r.status, 2);
    } finally {
      spawnSync("bash", ["-c", `rm -f /tmp/${name}`]);
    }
  });
});

// ------------------------------------------------------------------ post: the taxonomy check

describe("PostToolUse — taxonomy", () => {
  let dir;
  before(() => { dir = repoDir(ADOPTED); });
  const stubbed = (body) => pluginTree(body);

  test("passes when the linter is absent", () => {
    const r = runHook(post(`gh issue create -b x`, "https://github.com/o/r/issues/9", dir), {
      hook: pluginTree(),
    });
    assert.equal(r.status, 0);
  });

  test("passes when stdout carries no issue URL", () => {
    assert.equal(
      runHook(post(`gh issue create -b x`, "boom", dir), { hook: stubbed("exit 0\n") }).status,
      0,
    );
  });

  test("blocks on a violation, quoting the linter", { skip: !bashAvailable }, () => {
    const r = runHook(post(`gh issue create -b x`, "https://github.com/o/r/issues/9", dir), {
      hook: stubbed('echo "  FAIL  #9   no area: label"\nexit 1\n'),
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /issue #9 violates the label taxonomy/);
    assert.match(r.stderr, /no area: label/);
  });

  test("passes when the linter is clean", { skip: !bashAvailable }, () => {
    const r = runHook(post(`gh issue create -b x`, "https://github.com/o/r/issues/9", dir), {
      hook: stubbed("exit 0\n"),
    });
    assert.equal(r.status, 0);
  });

  test("lints the target of an edit", { skip: !bashAvailable }, () => {
    const r = runHook(post(`gh issue edit 42 --add-label area:ci`, "", dir), {
      hook: stubbed('echo "  FAIL  #42   no type: label"\nexit 1\n'),
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /issue #42/);
  });

  test("a missing dependency degrades to a pass, never a block", { skip: !bashAvailable }, () => {
    const r = runHook(post(`gh issue create -b x`, "https://github.com/o/r/issues/9", dir), {
      hook: stubbed('echo "jq is not installed" >&2\nexit 1\n'),
    });
    assert.equal(r.status, 0);
  });

  test("an unauthenticated gh degrades to a pass", { skip: !bashAvailable }, () => {
    const r = runHook(post(`gh issue create -b x`, "https://github.com/o/r/issues/9", dir), {
      hook: stubbed('echo "gh is not authenticated" >&2\nexit 1\n'),
    });
    assert.equal(r.status, 0);
  });

  test("forwards --repo through to the linter", { skip: !bashAvailable }, () => {
    runHook(post(`gh issue edit 42 --repo acme/shop --add-label area:ci`, "", dir), {
      hook: stubbed('printf "%s" "$*" > args.txt\nexit 0\n'),
    });
    assert.match(readFileSync(join(dir, "args.txt"), "utf8"), /42 --repo acme\/shop/);
  });

  // A deleted issue, a network failure or a rate limit all exit non-zero with nothing on
  // stdout. Blocking there would blame the model for the environment.
  test("a gh API failure does not block", { skip: !bashAvailable }, () => {
    const r = runHook(post(`gh issue create -b x`, "https://github.com/o/r/issues/9", dir), {
      hook: stubbed('echo "could not resolve to an Issue" >&2\nexit 1\n'),
    });
    assert.equal(r.status, 0);
  });

  test("non-zero with no FAIL line does not block", { skip: !bashAvailable }, () => {
    const r = runHook(post(`gh issue create -b x`, "https://github.com/o/r/issues/9", dir), {
      hook: stubbed('echo "  1 issue(s) checked · 1 clean"\nexit 1\n'),
    });
    assert.equal(r.status, 0);
  });
});

// ------------------------------------------------------------------ pull requests
//
// PRs once shipped unlabelled because `gh pr create` never reached the hook. The two halves
// need opposite treatment: a PR has no duplicate search to record, so the PreToolUse gate
// must stay off it, while the taxonomy check must come on. And the ruleset differs --
// `priority:` and `severity:` are facts about an issue, not about the branch that fixes it --
// so the linter is invoked in a distinct mode.

describe("pull requests", () => {
  let dir;
  before(() => { dir = repoDir(ADOPTED); });

  test("PreToolUse never asks a PR for a duplicate-search block", () => {
    const r = runHook(pre(`gh pr create --title x --body "no markers here"`, dir));
    assert.equal(r.status, 0, "a PR has no duplicate search to record");
  });

  test("PostToolUse lints a created PR in --pr mode", { skip: !bashAvailable }, () => {
    runHook(post(`gh pr create --title x`, "https://github.com/o/r/pull/236", dir), {
      hook: pluginTree('printf "%s" "$*" > args.txt\nexit 0\n'),
    });
    const args = readFileSync(join(dir, "args.txt"), "utf8");
    assert.match(args, /--pr/, "PRs must not be linted against the issue ruleset");
    assert.match(args, /\b236\b/, "the PR number comes from the /pull/ URL, not /issues/");
  });

  test("PostToolUse lints the target of a pr edit", { skip: !bashAvailable }, () => {
    runHook(post(`gh pr edit 42 --add-label type:chore`, "", dir), {
      hook: pluginTree('printf "%s" "$*" > args.txt\nexit 0\n'),
    });
    const args = readFileSync(join(dir, "args.txt"), "utf8");
    assert.match(args, /--pr/);
    assert.match(args, /\b42\b/);
  });

  test("blocks on a PR violation, naming it a PR", { skip: !bashAvailable }, () => {
    const r = runHook(post(`gh pr create --title x`, "https://github.com/o/r/pull/236", dir), {
      hook: pluginTree('echo "  FAIL  #236   no type: label"\nexit 1\n'),
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /PR #236/);
    assert.match(r.stderr, /gh pr edit 236/, "the remedy must be a pr command, not an issue one");
  });

  // These two are named in the PR message *to exclude them*. Saying nothing invites a model
  // to add them unprompted, which is the outcome the mode exists to prevent -- so the test
  // guards the real hazard (stating them as a requirement) rather than the mere words.
  test("the PR remedy names priority:/severity: only to rule them out", { skip: !bashAvailable }, () => {
    const r = runHook(post(`gh pr create --title x`, "https://github.com/o/r/pull/236", dir), {
      hook: pluginTree('echo "  FAIL  #236   no area: label"\nexit 1\n'),
    });
    assert.match(r.stderr, /priority: and severity: belong to the issue/,
      "the exclusion must be explicit, not implied by omission");
    assert.doesNotMatch(r.stderr, /one priority:/,
      "that phrasing is the issue ruleset and would have the model add labels to a PR");
    assert.doesNotMatch(r.stderr, /severity: on bugs/, "likewise the issue ruleset");
  });

  test("forwards --repo through for a PR", { skip: !bashAvailable }, () => {
    runHook(post(`gh pr edit 42 --repo acme/shop --add-label type:chore`, "", dir), {
      hook: pluginTree('printf "%s" "$*" > args.txt\nexit 0\n'),
    });
    assert.match(
      readFileSync(join(dir, "args.txt"), "utf8"),
      /42 --pr --repo acme\/shop|42 --repo acme\/shop --pr/,
    );
  });

  test("issue handling is unchanged", { skip: !bashAvailable }, () => {
    runHook(post(`gh issue create -b x`, "https://github.com/o/r/issues/9", dir), {
      hook: pluginTree('printf "%s" "$*" > args.txt\nexit 0\n'),
    });
    const args = readFileSync(join(dir, "args.txt"), "utf8");
    assert.doesNotMatch(args, /--pr/, "issues must still be linted against the issue ruleset");
    assert.match(args, /\b9\b/);
  });
});

// ------------------------------------------------------------------ robustness

describe("payload robustness", () => {
  test("empty stdin exits 0", () => {
    assert.equal(runHook("").status, 0);
  });
  test("malformed JSON exits 0", () => {
    assert.equal(runHook("{not json").status, 0);
  });
  test("a non-Bash tool exits 0", () => {
    assert.equal(runHook({ tool_name: "Write", tool_input: { content: "x" } }).status, 0);
  });
  test("a missing command exits 0", () => {
    assert.equal(runHook({ tool_name: "Bash", tool_input: {} }).status, 0);
  });
  test("an unknown hook event exits 0", () => {
    const r = runHook({
      hook_event_name: "Other",
      tool_name: "Bash",
      tool_input: { command: `gh issue create --title x` },
    });
    assert.equal(r.status, 0);
  });
  test("an Edit payload without file_path exits 0 silently", () => {
    const r = runHook({ hook_event_name: "PreToolUse", tool_name: "Edit", cwd: temp("x"), tool_input: {} });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });
  test("an edit outside any git repository exits 0 silently", () => {
    const dir = temp("nogit");
    const r = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      cwd: dir,
      tool_input: { file_path: join(dir, "a.txt"), old_string: "a", new_string: "b" },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });
});

describe("PreToolUse — deploy gate", { skip: !gitAvailable }, () => {
  let repo;

  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });

  // A real repo on a real branch: the gate reads a diff, so a fixture that fakes one would
  // test the mock rather than the gate.
  before(() => {
    repo = temp("deploy");
    git("init", "-b", "main");
    mkdirSync(join(repo, ".github"));
    writeFileSync(
      join(repo, ".github", "github-workflow.json"),
      JSON.stringify({
        ...ADOPTED,
        gates: { deployImpact: { paths: ["deployment/**", "migrations/**"], doc: "docs/DEPLOY.md" } },
      }),
    );
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "README.md"), "seed\n");
    git("add", "-A");
    git("commit", "-m", "seed", "--no-verify");
    git("checkout", "-b", "feature");
  });

  /** Commit `files` on the feature branch so the branch diff contains them. */
  const touch = (files) => {
    for (const f of files) {
      mkdirSync(join(repo, dirname(f)), { recursive: true });
      writeFileSync(join(repo, f), "x\n");
    }
    git("add", "-A");
    git("commit", "-m", "change", "--no-verify");
  };

  test("blocks a PR touching deployment/ with no Deploy impact line", () => {
    touch(["deployment/shop.nginx"]);
    const r = runHook(pre(`gh pr create --title x --body "## What\n\nA change." --base main`, repo));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Deploy impact/);
    assert.match(r.stderr, /deployment\/shop\.nginx/, "the blocking file must be named");
  });

  // Real newlines, not JSON-escaped ones: `--body "a\nb"` in a shell puts a literal
  // backslash-n in the body, and the line-anchored match would never see a line start.
  test("passes the same PR once the body answers", () => {
    const body = `## What

A change.

Deploy impact: none`;
    const r = runHook(pre(`gh pr create --title x --body "${body}" --base main`, repo));
    assert.equal(r.status, 0, "an explicit none is a decision and must be accepted");
  });

  test("blocks a PR adding a migration", () => {
    touch(["migrations/20260825120000_add_thing.sql"]);
    const r = runHook(pre(`gh pr create --title x --body "no answer" --base main`, repo));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /20260825120000_add_thing/);
  });

  test("names the configured doc and leaves marking it done to the operator", () => {
    const r = runHook(pre(`gh pr create --title x --body "no answer" --base main`, repo));
    assert.match(r.stderr, /docs\/DEPLOY\.md/, "the record goes in the doc the config names");
    assert.match(r.stderr, /operator/, "only the operator can verify the server");
  });

  // Claude Code's default PR form. The answer is inside the heredoc, not in `$(cat ...)`.
  test("reads a Deploy impact line from a --body heredoc", () => {
    const form = (text) => `gh pr create --title x --base main --body "$(cat <<'EOF'\n${text}\nEOF\n)"`;
    assert.equal(runHook(pre(form("## Summary\n\nA change.\n\nDeploy impact: none"), repo)).status, 0);
    assert.equal(runHook(pre(form("## Summary\n\nA change."), repo)).status, 2);
  });

  test("leaves a PR touching no trigger path alone", () => {
    touch(["src/cart/coupon.ts"]);
    // A fresh branch off main so the diff holds only the untriggered file.
    git("checkout", "-b", "plain", "main");
    writeFileSync(join(repo, "lib.ex"), "x\n");
    git("add", "-A");
    git("commit", "-m", "plain", "--no-verify");
    const r = runHook(pre(`gh pr create --title x --body "no answer" --base main`, repo));
    assert.equal(r.status, 0);
    git("checkout", "feature");
  });

  test("does not gate an issue create on deploy impact", () => {
    const body = `${BLOCK}\n\nno deploy line here`;
    const r = runHook(pre(`gh issue create --title x --body ${JSON.stringify(body)}`, repo));
    assert.equal(r.status, 0, "the deploy gate is a PR concern");
  });

  // Fail open. A shallow clone, a missing base branch or a detached HEAD all make the diff
  // unknowable, and a gate that fires on unknown would block every PR in those checkouts.
  test("skips when the base branch does not exist", () => {
    const r = runHook(pre(`gh pr create --title x --body "no answer" --base nope`, repo));
    assert.equal(r.status, 0, "an unresolvable base must not block");
  });

  // The base is model-written. `--output=x...HEAD` reaching git as an option would write a
  // file into the repository and report an empty diff, so an option-like base is refused.
  test("an option-like --base is refused rather than handed to git", () => {
    const r = runHook(pre(`gh pr create --title x --body "no answer" --base "--output=x"`, repo));
    assert.equal(r.status, 0, "an unusable base fails open");
    assert.equal(existsSync(join(repo, "x...HEAD")), false, "git must never see the base as an option");
  });
});

// `gh pr create --head B` opens a PR from B whatever is checked out: the diff is B's.
describe("PreToolUse — deploy gate, --head", { skip: !gitAvailable }, () => {
  let repo;
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  const branch = (name, file) => {
    git("checkout", "-q", "-b", name, "main");
    mkdirSync(join(repo, dirname(file)), { recursive: true });
    writeFileSync(join(repo, file), "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", name, "--no-verify");
  };

  before(() => {
    repo = temp("deploy-head");
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(repo, ".github"));
    writeFileSync(
      join(repo, ".github", "github-workflow.json"),
      JSON.stringify({ ...ADOPTED, gates: { deployImpact: { paths: ["migrations/**"] } } }),
    );
    writeFileSync(join(repo, "README.md"), "seed\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed", "--no-verify");
    branch("mig", "migrations/1.sql");
    branch("plain", "src/a.txt");
  });

  const create = (head) => `gh pr create --title t --body x --base main --head ${head}`;

  test("a PR from a plain branch passes while a migration branch is checked out", () => {
    git("checkout", "-q", "mig");
    assert.equal(runHook(pre(create("plain"), repo)).status, 0);
  });

  test("a PR from the migration branch is blocked while a plain branch is checked out", () => {
    git("checkout", "-q", "plain");
    const r = runHook(pre(create("mig"), repo));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /migrations\/1\.sql/);
  });

  test("-H is the short form", () => {
    git("checkout", "-q", "plain");
    assert.equal(runHook(pre(`gh pr create --title t --body x --base main -H mig`, repo)).status, 2);
  });

  test("a fork's owner:branch head cannot be diffed here, so the gate stands aside", () => {
    git("checkout", "-q", "mig");
    assert.equal(runHook(pre(create("someone:plain"), repo)).status, 0);
  });

  test("an option-like --head never reaches git", () => {
    git("checkout", "-q", "mig");
    assert.equal(runHook(pre(create(`"--output=y"`), repo)).status, 0);
    assert.equal(existsSync(join(repo, "y")), false);
  });
});

// Ordinary command shapes that once reached no gh gate at all. A false block on everyday gh use is
// worse than a miss, so each shape has its passing twin.
describe("PreToolUse — command shapes", () => {
  const NEG = `--title t --body "This does not close #12."`;
  const OK = `--title t --body "Refs #12."`;

  test("a PR URL captured with $(...) is still judged", () => {
    assert.equal(runHook(pre(`URL=$(gh pr create ${NEG})`, temp("guest"))).status, 2);
    assert.equal(runHook(pre(`URL=$(gh pr create ${OK}) && echo "$URL"`, temp("guest"))).status, 0);
  });

  test("so is one inside a double-quoted $(...), backticks or a subshell", () => {
    for (const shape of [
      `echo "$(gh pr create ${NEG})"`,
      `URL=\`gh pr create ${NEG}\``,
      `(gh pr create ${NEG})`,
      `(cd . && gh pr create ${NEG})`,
    ]) {
      assert.equal(runHook(pre(shape, temp("guest"))).status, 2, shape);
    }
    for (const shape of [`echo "$(gh pr create ${OK})"`, `(gh pr create ${OK})`, `echo "$(gh pr view 1)"`]) {
      assert.equal(runHook(pre(shape, temp("guest"))).status, 0, shape);
    }
  });

  test("a single-quoted mention of $(gh pr create ...) runs nothing and is not judged", () => {
    const cmd = `git commit -m 'docs: never write $(gh pr create --body "does not close #1")'`;
    assert.equal(runHook(pre(cmd, temp("guest"))).status, 0);
  });

  test("-R before the action is still that command, and names the repository", () => {
    assert.equal(runHook(pre(`gh pr -R acme/other create ${NEG}`, temp("guest"))).status, 2);
    assert.equal(runHook(pre(`gh issue --repo acme/other create --title x --body plain`, repoDir(ADOPTED))).status, 0);
    assert.equal(runHook(pre(`gh issue -R acme/shop create --title x --body plain`, repoDir(ADOPTED))).status, 2);
  });

  test("an attached short flag carries its value", () => {
    assert.equal(runHook(pre(`gh pr create -t t -b'This does not close #12.'`, temp("guest"))).status, 2);
    assert.equal(runHook(pre(`gh pr create -t t -b'Refs #12.'`, temp("guest"))).status, 0);
  });

  test("a --body-file after cd is read from that directory", () => {
    const dir = temp("guest");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "pr.md"), "Refs #12\n");
    writeFileSync(join(dir, "sub", "pr.md"), "This does not close #12.\n");
    assert.equal(runHook(pre(`cd sub && gh pr create --title t --body-file pr.md`, dir)).status, 2);
    assert.equal(runHook(pre(`(cd sub) && gh pr create --title t --body-file pr.md`, dir)).status, 0);
  });

  // The `)` closing a subshell opened before gh's own word sticks to gh's last argument.
  test("(cd DIR && gh ... LAST): the subshell's ) is not part of the last argument", () => {
    const dir = repoDir(ADOPTED);
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "pr.md"), "This does not close #12.\n");
    assert.equal(runHook(pre(`(cd sub && gh pr create --title t --body-file pr.md)`, dir)).status, 2);
    assert.equal(runHook(pre(`(cd . && gh issue create --title t --body x --repo acme/shop)`, dir)).status, 2);
    assert.equal(runHook(pre(`(cd . && gh issue create --title t --body x --repo acme/other)`, dir)).status, 0);
  });

  // Every gh create|edit in the command is judged; any block wins.
  test("a later gh pr create after a $(gh issue create ...) is still judged", () => {
    const cmd = `N=$(gh issue create --title t --body x) && gh pr create --title t --body "This does not close #12."`;
    assert.equal(runHook(pre(cmd, temp("guest"))).status, 2);
    const ok = `N=$(gh issue create --title t --body x) && gh pr create --title t --body "Refs #12."`;
    assert.equal(runHook(pre(ok, temp("guest"))).status, 0);
  });

  test("the first of two gh commands still blocks when the second is clean", () => {
    const cmd = `gh pr create --title t --body "This does not close #12." && gh pr edit 3 --add-label x`;
    assert.equal(runHook(pre(cmd, temp("guest"))).status, 2);
  });

  test("adopted: an issue create after a clean pr create is still asked for its record", () => {
    const cmd = `gh pr create --title t --body "Refs #1" && gh issue create --title t --body plain`;
    assert.equal(runHook(pre(cmd, repoDir(ADOPTED))).status, 2);
  });

  // The repository gh acts in is the one it runs in: after a cd, that checkout's mode and config.
  test("after cd into another checkout, that checkout decides the mode", () => {
    const adopted = repoDir(ADOPTED);
    const guest = repoDir();
    const create = `gh issue create --title t --body plain`;
    assert.equal(runHook(pre(`cd "${guest.replace(/\\/g, "/")}" && ${create}`, adopted)).status, 0);
    assert.equal(runHook(pre(`cd "${adopted.replace(/\\/g, "/")}" && ${create}`, guest)).status, 2);
    assert.equal(runHook(pre(`cd "$ELSEWHERE" && ${create}`, adopted)).status, 0, "unknown: guest");
  });

  // An agent writes the variable as a prefix far more often than it exports it.
  test("a GH_REPO=x prefix on the gh command names the repository", () => {
    const dir = repoDir(ADOPTED);
    assert.equal(runHook(pre(`GH_REPO=acme/other gh issue create --title t --body plain`, dir)).status, 0);
    assert.equal(runHook(pre(`env GH_REPO=acme/shop gh issue create --title t --body plain`, dir)).status, 2);
  });

  test("a --body-file after a cd the hook cannot follow is skipped, never read from the wrong place", () => {
    const dir = temp("guest");
    writeFileSync(join(dir, "pr.md"), "This does not close #12.\n");
    assert.equal(runHook(pre(`cd "$WORK" && gh pr create --title t --body-file pr.md`, dir)).status, 0);
  });
});

describe("modes", () => {
  test("guest mode still blocks a negated closing keyword on a PR", () => {
    const r = runHook(pre(NEGATED_PR, temp("guest")));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /closing keyword/);
  });

  test("guest mode never asks an issue for a duplicate-search record", () => {
    assert.equal(runHook(pre(`gh issue create --title x --body "plain"`, temp("guest"))).status, 0);
  });

  test("guest mode never lints labels", { skip: !bashAvailable }, () => {
    const hook = pluginTree('echo "  FAIL  #9   no area: label"\nexit 1\n');
    const r = runHook(post(`gh issue create -b x`, "https://github.com/o/r/issues/9", temp("guest")), { hook });
    assert.equal(r.status, 0);
  });

  test("an issue body cannot close anything, so a negation there is not blocked", () => {
    const body = `${BLOCK}\n\nThis does not close #12.`;
    const r = runHook(pre(`gh issue create --title x --body ${JSON.stringify(body)}`, repoDir(ADOPTED)));
    assert.equal(r.status, 0);
  });

  test("an adopted repo blocks an issue create with no record", () => {
    assert.equal(runHook(pre(`gh issue create --title x --body plain`, repoDir(ADOPTED))).status, 2);
  });

  test("the config applies from a subdirectory", () => {
    const dir = repoDir(ADOPTED);
    const sub = join(dir, "src", "cart");
    mkdirSync(sub, { recursive: true });
    assert.equal(runHook(pre(`gh issue create --title x --body plain`, sub)).status, 2);
  });

  test("a config saved with a BOM and CRLF is honoured", () => {
    const dir = repoDir(undefined, { raw: '\uFEFF{"version":1,\r\n"repo":"acme/shop"}\r\n' });
    assert.equal(runHook(pre(`gh issue create --title x --body plain`, dir)).status, 2);
  });
});

describe("--repo", () => {
  test("the configured repo in URL form is adopted", () => {
    const cmd = `gh issue create --repo https://github.com/ACME/shop --title x --body plain`;
    assert.equal(runHook(pre(cmd, repoDir(ADOPTED))).status, 2);
  });

  test("HOST/OWNER/REPO form is adopted", () => {
    const cmd = `gh issue create -R github.com/acme/shop --title x --body plain`;
    assert.equal(runHook(pre(cmd, repoDir(ADOPTED))).status, 2);
  });

  test("another repo is guest mode", () => {
    const cmd = `gh issue create --repo acme/other --title x --body plain`;
    assert.equal(runHook(pre(cmd, repoDir(ADOPTED))).status, 0);
  });

  // An edit target given by URL names its repository as surely as --repo does.
  test("an edit by URL of another repo is guest mode: no lint of this repo's same number", { skip: !bashAvailable }, () => {
    const dir = repoDir(ADOPTED);
    const r = runHook(post(`gh issue edit https://github.com/someone/else/issues/42 --add-label bug`, "", dir), {
      hook: pluginTree('printf "%s" "$*" > args.txt\necho "  FAIL  #42   no type: label"\nexit 1\n'),
    });
    assert.equal(r.status, 0);
    assert.equal(existsSync(join(dir, "args.txt")), false, "the linter must not run");
  });

  test("an edit by URL of the configured repo lints that repo", { skip: !bashAvailable }, () => {
    const dir = repoDir(ADOPTED);
    runHook(post(`gh pr edit https://github.com/acme/shop/pull/42 --add-label type:chore`, "", dir), {
      hook: pluginTree('printf "%s" "$*" > args.txt\nexit 0\n'),
    });
    assert.match(readFileSync(join(dir, "args.txt"), "utf8"), /--repo acme\/shop/);
  });

  test("GH_REPO naming another repo is guest mode", () => {
    const r = runHook(pre(`gh issue create --title x --body plain`, repoDir(ADOPTED)), { env: { GH_REPO: "acme/other" } });
    assert.equal(r.status, 0);
  });

  test("--repo wins over GH_REPO", () => {
    const cmd = `gh issue create --repo acme/shop --title x --body plain`;
    assert.equal(runHook(pre(cmd, repoDir(ADOPTED)), { env: { GH_REPO: "acme/other" } }).status, 2);
  });

  test("a config that names no repo cannot vouch for --repo", () => {
    const cmd = `gh issue create --repo acme/shop --title x --body plain`;
    assert.equal(runHook(pre(cmd, repoDir({ version: 1 }))).status, 0);
  });
});

describe("malformed config", () => {
  test("warns without blocking, naming the file and doctor", () => {
    const dir = repoDir(undefined, { raw: "{nope" });
    const r = runHook(pre(`gh issue create --title x --body plain`, dir));
    assert.equal(r.status, 0);
    const msg = JSON.parse(r.stdout.trim()).systemMessage;
    assert.match(msg, /github-workflow\.json is not valid/);
    assert.match(msg, /\/github-workflow:doctor/);
  });

  test("a block still wins, and then no warning is printed", () => {
    const dir = repoDir(undefined, { raw: "{nope" });
    const r = runHook(pre(NEGATED_PR, dir));
    assert.equal(r.status, 2);
    assert.equal(r.stdout.trim(), "");
  });

  test("non-gh commands are never slowed by a warning", () => {
    const dir = repoDir(undefined, { raw: "{nope" });
    const r = runHook(pre(`git status`, dir));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });
});

describe("switches", () => {
  test("gates.duplicateSearch false lets a bare issue create through", () => {
    const dir = repoDir({ ...ADOPTED, gates: { duplicateSearch: false } });
    assert.equal(runHook(pre(`gh issue create --title x --body plain`, dir)).status, 0);
  });

  test("gates.labelTaxonomy false stops the post-create lint", { skip: !bashAvailable }, () => {
    const dir = repoDir({ ...ADOPTED, gates: { labelTaxonomy: false } });
    const hook = pluginTree('echo "  FAIL  #9   no area: label"\nexit 1\n');
    const r = runHook(post(`gh issue create -b x`, "https://github.com/o/r/issues/9", dir), { hook });
    assert.equal(r.status, 0);
  });

  test("gates.closingKeywords false turns the closing gate off for that repo", () => {
    const dir = repoDir({ ...ADOPTED, gates: { closingKeywords: false } });
    assert.equal(runHook(pre(NEGATED_PR, dir)).status, 0);
  });

  test("the user option off turns the closing gate off everywhere", () => {
    const r = runHook(pre(NEGATED_PR, temp("guest")), {
      env: { CLAUDE_PLUGIN_OPTION_CLOSING_KEYWORD_GATE: "off" },
    });
    assert.equal(r.status, 0);
  });

  test("the user option true leaves it on", () => {
    const r = runHook(pre(NEGATED_PR, temp("guest")), {
      env: { CLAUDE_PLUGIN_OPTION_CLOSING_KEYWORD_GATE: "true" },
    });
    assert.equal(r.status, 2);
  });

  test("block messages never explain how to switch a gate off", () => {
    const closing = runHook(pre(NEGATED_PR, temp("guest"))).stderr;
    const dup = runHook(pre(`gh issue create --title x --body plain`, repoDir(ADOPTED))).stderr;
    for (const msg of [closing, dup]) {
      assert.doesNotMatch(msg, /closingKeywords|duplicateSearch|closing_keyword_gate|github-workflow\.json/);
    }
  });

  test("the hook still runs when its path goes through a symlink", () => {
    // macOS's /tmp and /var are symlinks, so every CI run there takes this path.
    const hook = pluginTree();
    const link = join(temp("link"), "p");
    symlinkSync(dirname(dirname(hook)), link, "junction");
    const r = runHook(pre(NEGATED_PR, temp("guest")), { hook: join(link, "hooks", "check-issue-workflow.mjs") });
    assert.equal(r.status, 2);
  });
});

describe("CRLF bodies", () => {
  test("a negation in a CRLF body file is caught", () => {
    const dir = repoDir(ADOPTED);
    writeFileSync(join(dir, "pr.md"), "## What\r\n\r\nThis does not close #12.\r\n");
    assert.equal(runHook(pre(`gh pr create --title t --body-file pr.md`, dir)).status, 2);
  });

  test("a compliant CRLF issue body file passes the duplicate gate", () => {
    const dir = repoDir(ADOPTED);
    writeFileSync(join(dir, "issue.md"), BLOCK.replace(/\n/g, "\r\n") + "\r\n");
    assert.equal(runHook(pre(`gh issue create --title t --body-file issue.md`, dir)).status, 0);
  });
});

describe("self-check", () => {
  const selfCheck = (hook, cwd, env = {}) =>
    spawnSync(process.execPath, [hook, "--self-check", "--cwd", cwd], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_OPTION_CLOSING_KEYWORD_GATE: "",
        CLAUDE_PLUGIN_OPTION_DISCARD_GATE: "",
        ...env,
      },
    });

  test("reports guest mode outside an adopted repo", () => {
    const r = selfCheck(pluginTree("exit 0\n"), temp("guest"));
    assert.match(r.stdout, /mode\s+ready\s+guest/);
    assert.match(r.stdout, /duplicate gate\s+ready\s+inactive here/);
  });

  test("reports adoption with the config path", () => {
    const r = selfCheck(pluginTree("exit 0\n"), repoDir(ADOPTED));
    assert.match(r.stdout, /mode\s+ready\s+adopted/);
  });

  test("a malformed config is NOT RUNNING and exits non-zero", () => {
    const r = selfCheck(pluginTree("exit 0\n"), repoDir(undefined, { raw: "{nope" }));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /mode\s+NOT RUNNING\s+config malformed/);
  });

  test("a missing linter makes the taxonomy check NOT RUNNING", () => {
    const r = selfCheck(pluginTree(), temp("guest"));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /taxonomy check\s+NOT RUNNING/);
  });

  test("names the user option when it has turned the closing gate off", () => {
    const r = selfCheck(pluginTree("exit 0\n"), temp("guest"), {
      CLAUDE_PLUGIN_OPTION_CLOSING_KEYWORD_GATE: "false",
    });
    assert.match(r.stdout, /closing gate\s+ready\s+off -- plugin option/);
  });

  test("an unconfigured deploy gate says so", () => {
    const r = selfCheck(pluginTree("exit 0\n"), repoDir(ADOPTED));
    assert.match(r.stdout, /deploy gate\s+ready\s+not configured/);
  });

  test("the branch gate: inactive in guest mode, on when adopted, off by repo config", { skip: !gitAvailable }, () => {
    const hook = pluginTree("exit 0\n");
    assert.match(selfCheck(hook, temp("guest")).stdout, /branch gate\s+ready\s+inactive here \(guest mode\)/);
    assert.match(selfCheck(hook, repoDir(ADOPTED)).stdout, /branch gate\s+ready\s+on/);
    const off = repoDir({ ...ADOPTED, gates: { defaultBranch: false } });
    assert.match(selfCheck(hook, off).stdout, /branch gate\s+ready\s+off -- repo config/);
  });

  test("the discard gate: on everywhere, off by the plugin option or the repo config", { skip: !gitAvailable }, () => {
    const hook = pluginTree("exit 0\n");
    assert.match(selfCheck(hook, temp("guest")).stdout, /discard gate\s+ready\s+on/);
    assert.match(selfCheck(hook, repoDir(ADOPTED)).stdout, /discard gate\s+ready\s+on/);
    const option = selfCheck(hook, temp("guest"), { CLAUDE_PLUGIN_OPTION_DISCARD_GATE: "false" });
    assert.match(option.stdout, /discard gate\s+ready\s+off -- plugin option discard_gate/);
    const off = repoDir({ ...ADOPTED, gates: { discardChanges: false } });
    assert.match(selfCheck(hook, off).stdout, /discard gate\s+ready\s+off -- repo config/);
  });
});

// ------------------------------------------------------------------ the ask gates
//
// Two gates answer with permissionDecision "ask" -- a confirm prompt to the human -- and exit 0,
// never 2: the human saying yes IS the "unless the operator says so" the rules allow. They read
// HEAD, ask git for the default branch and for status, so the fixtures are real repositories.

const gitIn = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

/** Write `body` to `file` under `dir`, making its directories. */
const write = (dir, file, body = "changed\n") => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), body);
};

/**
 * A real repository on `main`, its seed commit holding README.md, lib/a.txt, lib/b.txt and
 * sub/s.txt, plus `files`, plus the config when there is one (null: a guest repository).
 */
function gitRepo(config = ADOPTED, files = {}) {
  const dir = temp("git");
  gitIn(dir, "init", "-q", "-b", "main");
  for (const [k, v] of [
    ["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"],
  ]) gitIn(dir, "config", k, v);
  const seed = { "README.md": "seed\n", "lib/a.txt": "a\n", "lib/b.txt": "b\n", "sub/s.txt": "s\n", ...files };
  if (config) seed[".github/github-workflow.json"] = JSON.stringify(config);
  for (const [f, body] of Object.entries(seed)) write(dir, f, body);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "seed", "--no-verify");
  return dir;
}

/** The hook asked: exit 0 and the ask JSON on stdout. Returns the reason the human sees. */
function askOf(r) {
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(r.stdout.trim(), "", "expected the hook to ask");
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  return out.hookSpecificOutput.permissionDecisionReason;
}

/** The hook let it through without a word. */
function passes(r) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "", `expected no ask, got: ${r.stdout}`);
}

/** Forward slashes, so a path can sit in a double-quoted shell word on Windows too. */
const fwd = (p) => p.replace(/\\/g, "/");

const NO_OFF_SWITCH = /discard_gate|discardChanges|defaultBranch|github-workflow\.json|plugin option|configure/;

describe("PreToolUse — discard gate", { skip: !gitAvailable }, () => {
  test("git checkout -- lib asks when a file under lib/ is modified, and lists it", () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    const why = askOf(runHook(pre("git checkout -- lib", dir)));
    assert.match(why, /^github-workflow: Claude wants to run git checkout, which discards uncommitted changes in /);
    assert.match(why, /: lib\/a\.txt\. They may not be its own\. Approve only if you want them gone\.$/);
    assert.doesNotMatch(why, NO_OFF_SWITCH);
  });

  test("git checkout -- lib passes when lib/ is clean", () => {
    const dir = gitRepo();
    write(dir, "README.md");
    passes(runHook(pre("git checkout -- lib", dir)));
  });

  test("applies in a guest repository too", () => {
    const dir = gitRepo(null);
    write(dir, "lib/a.txt");
    assert.match(askOf(runHook(pre("git checkout -- lib", dir))), /lib\/a\.txt/);
  });

  test("the plugin option off turns it off everywhere", () => {
    const dir = gitRepo(null);
    write(dir, "lib/a.txt");
    passes(runHook(pre("git checkout -- lib", dir), { env: { CLAUDE_PLUGIN_OPTION_DISCARD_GATE: "off" } }));
  });

  test("the plugin option true leaves it on", () => {
    const dir = gitRepo(null);
    write(dir, "lib/a.txt");
    askOf(runHook(pre("git checkout -- lib", dir), { env: { CLAUDE_PLUGIN_OPTION_DISCARD_GATE: "true" } }));
  });

  test("gates.discardChanges false turns it off for that repository", () => {
    const dir = gitRepo({ ...ADOPTED, gates: { discardChanges: false } });
    write(dir, "lib/a.txt");
    passes(runHook(pre("git checkout -- lib", dir)));
  });

  test("git restore --staged x passes: it keeps the working tree", () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    gitIn(dir, "add", "lib/a.txt");
    passes(runHook(pre("git restore --staged lib/a.txt", dir)));
  });

  test("git restore x asks when x is modified", () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    assert.match(askOf(runHook(pre("git restore lib/a.txt", dir))), /run git restore, .*lib\/a\.txt/);
  });

  test("git restore --staged --worktree x asks", () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    askOf(runHook(pre("git restore --staged --worktree lib/a.txt", dir)));
  });

  test("git reset --hard asks when the tree is dirty", () => {
    const dir = gitRepo();
    write(dir, "sub/s.txt");
    assert.match(askOf(runHook(pre("git reset --hard", dir))), /run git reset --hard, .*sub\/s\.txt/);
  });

  test("git reset --hard passes when clean, and when only untracked files exist", () => {
    const dir = gitRepo();
    passes(runHook(pre("git reset --hard", dir)));
    write(dir, "untracked.txt");
    passes(runHook(pre("git reset --hard", dir)));
  });

  test("git clean -fd asks when untracked files exist", () => {
    const dir = gitRepo();
    write(dir, "new/u.txt");
    assert.match(askOf(runHook(pre("git clean -fd", dir))), /run git clean, .*new\/u\.txt/);
  });

  test("git clean -n passes, and so does a forced dry run", () => {
    const dir = gitRepo();
    write(dir, "new/u.txt");
    passes(runHook(pre("git clean -n", dir)));
    passes(runHook(pre("git clean -fdn", dir)));
  });

  test("git clean -fdx asks when only ignored files exist; -fd does not", () => {
    const dir = gitRepo(ADOPTED, { ".gitignore": "*.log\n" });
    write(dir, "debug.log");
    assert.match(askOf(runHook(pre("git clean -fdx", dir))), /debug\.log/);
    passes(runHook(pre("git clean -fd", dir)));
  });

  test("git switch --discard-changes main asks when dirty", () => {
    const dir = gitRepo();
    write(dir, "lib/b.txt");
    assert.match(askOf(runHook(pre("git switch --discard-changes main", dir))), /run git switch, .*lib\/b\.txt/);
  });

  test("git stash drop asks when a stash exists", () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    gitIn(dir, "stash", "push", "-q");
    assert.match(askOf(runHook(pre("git stash drop", dir))), /run git stash drop, .*stash@\{0\}/);
  });

  test("git stash clear passes when the stash list is empty", () => {
    passes(runHook(pre("git stash clear", gitRepo())));
  });

  test("a plain branch switch passes", () => {
    const dir = gitRepo();
    gitIn(dir, "branch", "feature");
    write(dir, "lib/a.txt");
    passes(runHook(pre("git checkout feature", dir)));
  });

  test("git checkout -b x passes", () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    passes(runHook(pre("git checkout -b x", dir)));
  });

  test("git checkout . asks when dirty", () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    assert.match(askOf(runHook(pre("git checkout .", dir))), /lib\/a\.txt/);
  });

  test("git checkout <existing path> without -- asks when that path is dirty", () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    assert.match(askOf(runHook(pre("git checkout lib", dir))), /lib\/a\.txt/);
  });

  test("cd sub && git checkout -- . evaluates sub", () => {
    const dir = gitRepo();
    write(dir, "README.md");
    passes(runHook(pre("cd sub && git checkout -- .", dir)));
    write(dir, "sub/s.txt");
    assert.match(askOf(runHook(pre("cd sub && git checkout -- .", dir))), /sub\/s\.txt/);
  });

  test("git -C <dir> checkout -- lib evaluates <dir>", () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    passes(runHook(pre(`git -C "${fwd(dir)}" checkout -- sub`, temp("elsewhere"))));
    askOf(runHook(pre(`git -C "${fwd(dir)}" checkout -- lib`, temp("elsewhere"))));
  });

  test("an option-like path after -- never reaches git as an option", () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    const r = runHook(pre("git checkout -- --output=pwned", dir));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(dir, "pwned")), false, "git must never see the path as an option");
  });

  test("a path the shell expands asks with the form alone", () => {
    const dir = gitRepo();
    const why = askOf(runHook(pre('git checkout -- "$P"', dir)));
    assert.match(why, /run git checkout, which discards uncommitted changes/);
    assert.doesNotMatch(why, /lib\/a\.txt/);
  });

  test("git add . && git commit -m x on a feature branch passes", () => {
    const dir = gitRepo();
    gitIn(dir, "checkout", "-q", "-b", "feature");
    write(dir, "lib/a.txt");
    passes(runHook(pre("git add . && git commit -m x", dir)));
  });

  test("git worktree remove --force <wt> asks when that worktree is dirty", () => {
    const dir = gitRepo();
    const wt = join(temp("wt"), "tree");
    gitIn(dir, "worktree", "add", "-q", "-b", "wt-branch", wt);
    passes(runHook(pre(`git worktree remove --force "${fwd(wt)}"`, dir)));
    write(wt, "lib/a.txt");
    assert.match(askOf(runHook(pre(`git worktree remove --force "${fwd(wt)}"`, dir))), /run git worktree remove, .*lib\/a\.txt/);
  });

  test("text that only mentions git, in a quoted --body or a heredoc, does not ask", () => {
    const dir = gitRepo(null);
    write(dir, "lib/a.txt");
    passes(runHook(pre('gh pr create --title t --body "run git checkout -- lib"', dir)));
    passes(runHook(pre("cat <<'EOF'\ngit checkout -- lib\nEOF", dir)));
    passes(runHook(pre("git commit -F - <<'EOF'\nundo with git reset --hard\nEOF", dir)));
  });

  test("a subagent is named as one", () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    const r = runHook({ ...pre("git checkout -- lib", dir), agent_id: "a1", agent_type: "general-purpose" });
    assert.match(askOf(r), /^github-workflow: a subagent \(general-purpose\) wants to run git checkout/);
  });

  test("lists at most five paths, then a count", () => {
    const dir = gitRepo(ADOPTED, Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`many/f${n}.txt`, "x\n"])));
    for (const n of [1, 2, 3, 4, 5, 6, 7]) write(dir, `many/f${n}.txt`);
    const why = askOf(runHook(pre("git checkout -- many", dir)));
    assert.match(why, /many\/f5\.txt and 2 more\./);
    assert.doesNotMatch(why, /f6/);
  });
});

describe("PreToolUse — an ask and the gh gates together", { skip: !gitAvailable }, () => {
  test("a gh block wins: exit 2, and no ask is emitted", () => {
    const dir = gitRepo(null);
    write(dir, "lib/a.txt");
    const r = runHook(pre('git checkout -- lib && gh pr create --title t --body "does not close #1"', dir));
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stdout, /hookSpecificOutput/);
  });

  test("a config warning rides in the same object as the ask", () => {
    const dir = gitRepo(null);
    write(dir, ".github/github-workflow.json", "{nope");
    write(dir, "lib/a.txt");
    const r = runHook(pre('git checkout -- lib && gh issue create --title x --body plain', dir));
    askOf(r);
    assert.match(JSON.parse(r.stdout.trim()).systemMessage, /github-workflow\.json is not valid/);
  });

  test("a gh command that passes still lets the ask through", () => {
    const dir = gitRepo(null);
    write(dir, "lib/a.txt");
    askOf(runHook(pre('git checkout -- lib && gh pr create --title t --body "Refs #1"', dir)));
  });
});

describe("PreToolUse — branch gate, edits", { skip: !gitAvailable }, () => {
  const edit = (file, cwd, tool = "Edit") => ({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    cwd,
    tool_input: tool === "NotebookEdit"
      ? { notebook_path: file, new_source: "x" }
      : { file_path: file, old_string: "a", new_string: "b", content: "b" },
  });

  test("an Edit in an adopted repository on main asks", () => {
    const dir = gitRepo();
    assert.equal(
      askOf(runHook(edit(join(dir, "lib", "a.txt"), dir))),
      "github-workflow: Claude wants to edit lib/a.txt on main, this repository's default branch. " +
        "The workflow keeps every change on its own branch. Approve only if you asked for this change on main.",
    );
  });

  test("Write and MultiEdit ask too, and a relative path resolves against the payload cwd", () => {
    const dir = gitRepo();
    askOf(runHook(edit(join(dir, "lib", "b.txt"), dir, "Write")));
    askOf(runHook(edit(join(dir, "lib", "b.txt"), dir, "MultiEdit")));
    assert.match(askOf(runHook(edit("lib/b.txt", dir))), /edit lib\/b\.txt on main/);
  });

  test("an edit on a feature branch passes", () => {
    const dir = gitRepo();
    gitIn(dir, "checkout", "-q", "-b", "feature");
    passes(runHook(edit(join(dir, "lib", "a.txt"), dir)));
  });

  test("an edit in a guest repository passes", () => {
    const dir = gitRepo(null);
    passes(runHook(edit(join(dir, "lib", "a.txt"), dir)));
  });

  test("an edit to an ignored file passes", () => {
    const dir = gitRepo(ADOPTED, { ".gitignore": "scratch/\n" });
    passes(runHook(edit(join(dir, "scratch", "ledger.md"), dir, "Write")));
  });

  test("an edit inside the git directory passes", () => {
    const dir = gitRepo();
    passes(runHook(edit(join(dir, ".git", "info", "exclude"), dir)));
  });

  test("an edit on a detached HEAD passes", () => {
    const dir = gitRepo();
    gitIn(dir, "checkout", "-q", "--detach");
    passes(runHook(edit(join(dir, "lib", "a.txt"), dir)));
  });

  test("gates.defaultBranch false passes", () => {
    const dir = gitRepo({ ...ADOPTED, gates: { defaultBranch: false } });
    passes(runHook(edit(join(dir, "lib", "a.txt"), dir)));
  });

  // The incident: the session sat in a worktree on a feature branch, and an edit landed in the
  // operator's main checkout, on the default branch. The file decides the checkout, never the cwd.
  test("the incident: from a worktree, an edit to the main checkout asks; to the worktree passes", () => {
    const main = gitRepo();
    const wt = join(temp("wt"), "tree");
    gitIn(main, "worktree", "add", "-q", "-b", "feature", wt);
    passes(runHook(edit(join(wt, "lib", "a.txt"), wt)));
    assert.match(askOf(runHook(edit(join(main, "lib", "a.txt"), wt))), /edit lib\/a\.txt on main/);
  });

  test("a Write to a new file in a directory not yet created finds its checkout", () => {
    const dir = gitRepo();
    assert.match(askOf(runHook(edit(join(dir, "new", "deep", "f.txt"), dir, "Write"))), /edit new\/deep\/f\.txt on main/);
  });

  test("with origin/HEAD set to develop, main is not the default branch", () => {
    const dir = gitRepo();
    gitIn(dir, "update-ref", "refs/remotes/origin/develop", "HEAD");
    gitIn(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    passes(runHook(edit(join(dir, "lib", "a.txt"), dir)));
    gitIn(dir, "checkout", "-q", "-b", "develop");
    assert.match(askOf(runHook(edit(join(dir, "lib", "a.txt"), dir))), /on develop, this repository's default branch/);
  });

  test("NotebookEdit reads notebook_path", () => {
    const dir = gitRepo();
    assert.match(askOf(runHook(edit(join(dir, "nb.ipynb"), dir, "NotebookEdit"))), /edit nb\.ipynb on main/);
  });

  test("a subagent's edit names it", () => {
    const dir = gitRepo();
    const r = runHook({ ...edit(join(dir, "lib", "a.txt"), dir), agent_id: "a1", agent_type: "Explore" });
    assert.match(askOf(r), /^github-workflow: a subagent \(Explore\) wants to edit lib\/a\.txt on main/);
  });

  test("the message never names an off switch", () => {
    assert.doesNotMatch(askOf(runHook(edit(join(gitRepo(), "lib", "a.txt"), temp("x")))), NO_OFF_SWITCH);
  });

  test("PostToolUse never asks", () => {
    const dir = gitRepo();
    passes(runHook({ ...edit(join(dir, "lib", "a.txt"), dir), hook_event_name: "PostToolUse" }));
  });
});

// A reftable repository's .git/HEAD always reads `ref: refs/heads/.invalid`; the branch is in the
// reftable, so only git can say. reftable is planned as git 3.0's default.
const reftableAvailable =
  gitAvailable && gitIn(temp("reftable-probe"), "init", "-q", "--ref-format=reftable").status === 0;

describe("PreToolUse — branch gate, reftable", { skip: !reftableAvailable }, () => {
  const reftableRepo = () => {
    const dir = temp("reftable");
    gitIn(dir, "init", "-q", "--ref-format=reftable", "-b", "main");
    for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) {
      gitIn(dir, "config", k, v);
    }
    write(dir, ".github/github-workflow.json", JSON.stringify(ADOPTED));
    write(dir, "lib/a.txt", "a\n");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-q", "-m", "seed", "--no-verify");
    return dir;
  };

  test("git commit on main asks", () => {
    assert.match(askOf(runHook(pre("git commit -m x", reftableRepo()))), /run git commit on main/);
  });

  test("an edit on main asks", () => {
    const dir = reftableRepo();
    const r = runHook({
      hook_event_name: "PreToolUse", tool_name: "Edit", cwd: dir,
      tool_input: { file_path: join(dir, "lib", "a.txt"), old_string: "a", new_string: "b" },
    });
    assert.match(askOf(r), /edit lib\/a\.txt on main/);
  });

  test("a feature branch passes", () => {
    const dir = reftableRepo();
    gitIn(dir, "checkout", "-q", "-b", "feature");
    passes(runHook(pre("git commit -m x", dir)));
  });
});

describe("PreToolUse — branch gate, commands", { skip: !gitAvailable }, () => {
  test("git commit -m x on main asks", () => {
    assert.equal(
      askOf(runHook(pre("git commit -m x", gitRepo()))),
      "github-workflow: Claude wants to run git commit on main, this repository's default branch. " +
        "The workflow keeps every change on its own branch. Approve only if you asked for this change on main.",
    );
  });

  test("merge, cherry-pick, revert and am on main ask too", () => {
    const dir = gitRepo();
    for (const c of ["git merge feature", "git cherry-pick abc", "git revert HEAD", "git am x.patch"]) {
      assert.match(askOf(runHook(pre(c, dir))), new RegExp(`run git ${c.split(" ")[1]} on main`));
    }
  });

  test("from a feature-branch checkout, cd <main checkout> && git commit asks", () => {
    const main = gitRepo();
    const wt = join(temp("wt"), "tree");
    gitIn(main, "worktree", "add", "-q", "-b", "feature", wt);
    passes(runHook(pre("git commit -m x", wt)));
    askOf(runHook(pre(`cd "${fwd(main)}" && git commit -m x`, wt)));
  });

  test("git -C <main checkout> commit -m x asks", () => {
    const main = gitRepo();
    const wt = join(temp("wt"), "tree");
    gitIn(main, "worktree", "add", "-q", "-b", "feature", wt);
    askOf(runHook(pre(`git -C "${fwd(main)}" commit -m x`, wt)));
  });

  test("git push origin main from a feature branch asks", () => {
    const dir = gitRepo();
    gitIn(dir, "checkout", "-q", "-b", "feature");
    assert.equal(
      askOf(runHook(pre("git push origin main", dir))),
      "github-workflow: Claude wants to push to main, this repository's default branch. " +
        "The workflow keeps every change on its own branch. Approve only if you asked for this change on main.",
    );
  });

  test("git push origin HEAD:refs/heads/main asks", () => {
    const dir = gitRepo();
    gitIn(dir, "checkout", "-q", "-b", "feature");
    assert.match(askOf(runHook(pre("git push origin HEAD:refs/heads/main", dir))), /push to main/);
  });

  test("deleting the default branch, or pushing every branch, asks", () => {
    const dir = gitRepo();
    gitIn(dir, "checkout", "-q", "-b", "feature");
    for (const c of ["git push origin --delete main", "git push origin :main", "git push --all origin", "git push --mirror"]) {
      askOf(runHook(pre(c, dir)));
    }
  });

  test("a plain git push on a feature branch passes; on main it asks", () => {
    const dir = gitRepo();
    askOf(runHook(pre("git push", dir)));
    gitIn(dir, "checkout", "-q", "-b", "feature");
    passes(runHook(pre("git push", dir)));
    passes(runHook(pre("git push -u origin feature", dir)));
  });

  test("git merge --abort and git commit --dry-run on main pass", () => {
    const dir = gitRepo();
    passes(runHook(pre("git merge --abort", dir)));
    passes(runHook(pre("git cherry-pick --quit", dir)));
    passes(runHook(pre("git commit --dry-run -m x", dir)));
  });

  test("a commit after the same command leaves main passes: HEAD is no longer known", () => {
    const dir = gitRepo();
    passes(runHook(pre("git checkout -b fix/x && git commit -am x", dir)));
    passes(runHook(pre("git switch -c fix/y && git commit -am x", dir)));
  });

  test("a guest repository on main passes", () => {
    passes(runHook(pre("git commit -m x", gitRepo(null))));
  });

  test("Windows: a Git Bash /c/... path in cd is converted", { skip: process.platform !== "win32" }, () => {
    const main = gitRepo();
    const posix = `/${main[0].toLowerCase()}${fwd(main.slice(2))}`;
    askOf(runHook(pre(`cd "${posix}" && git commit -m x`, temp("elsewhere"))));
  });
});

// ------------------------------------------------------------------ review round 1
//
// Missed asks a review found: a branch switch in the same command, a Git Bash pathspec, git after a
// shell keyword, a cd scoped to a subshell; and the false or unsafe ones beside them.

describe("PreToolUse — what the review found", { skip: !gitAvailable }, () => {
  test("switching to the default branch in the same command is still judged", () => {
    const dir = gitRepo();
    gitIn(dir, "checkout", "-q", "-b", "feature");
    assert.match(askOf(runHook(pre("git checkout main && git merge feature", dir))), /run git merge on main/);
    assert.match(askOf(runHook(pre("git switch main && git push", dir))), /push to main/);
    assert.match(askOf(runHook(pre("git checkout -q main; git commit -m x", dir))), /run git commit on main/);
    passes(runHook(pre("git checkout -b fix/x && git commit -m x", dir)));
    passes(runHook(pre("git checkout --detach && git commit -m x", dir)));
  });

  test("Windows: a Git Bash absolute pathspec is converted before git status", { skip: process.platform !== "win32" }, () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    const posix = `/${dir[0].toLowerCase()}${fwd(dir.slice(2))}/lib`;
    assert.match(askOf(runHook(pre(`git checkout -- "${posix}"`, dir))), /lib\/a\.txt/);
  });

  test("git after a shell keyword is seen", () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    askOf(runHook(pre("if true; then git checkout -- .; fi", dir)));
    askOf(runHook(pre('for f in lib/a.txt; do git checkout -- "$f"; done', dir)));
    askOf(runHook(pre("if false; then :; else git reset --hard; fi", dir)));
    assert.match(askOf(runHook(pre("if true; then git commit -m x; fi", dir))), /run git commit on main/);
  });

  test("a cd inside a subshell does not move the commands after it", () => {
    const dir = gitRepo();
    write(dir, "README.md");
    assert.match(askOf(runHook(pre("(cd sub && ls) && git checkout -- .", dir))), /README\.md/);
  });

  test("a fast-forward or a skip on the default branch adds no commit of its own", () => {
    const dir = gitRepo();
    passes(runHook(pre("git fetch origin && git merge --ff-only origin/main", dir)));
    passes(runHook(pre("git cherry-pick --skip", dir)));
    passes(runHook(pre("git am --show-current-patch", dir)));
  });

  test("a branch whose name is also a directory is a branch switch, not a discard", () => {
    const dir = gitRepo();
    gitIn(dir, "branch", "sub");
    write(dir, "sub/s.txt");
    passes(runHook(pre("git checkout sub", dir)));
  });

  test("a change only in the index is not lost by checking out from the index", () => {
    const dir = gitRepo();
    write(dir, "lib/a.txt");
    gitIn(dir, "add", "lib/a.txt");
    passes(runHook(pre("git checkout -- lib", dir)));
    passes(runHook(pre("git restore lib/a.txt", dir)));
    askOf(runHook(pre("git checkout HEAD -- lib", dir)));
  });

  test("the hook's own git status never runs a repository's fsmonitor command", () => {
    const dir = gitRepo();
    gitIn(dir, "config", "core.fsmonitor", "echo ran > fsmon-ran.txt; true");
    write(dir, "lib/a.txt");
    askOf(runHook(pre("git checkout -- lib", dir)));
    assert.equal(existsSync(join(dir, "fsmon-ran.txt")), false, "the hook ran the repo's fsmonitor command");
  });
});
