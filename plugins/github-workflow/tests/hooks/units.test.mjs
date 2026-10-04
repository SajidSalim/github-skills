/**
 * Unit tests for the pure layer of check-issue-workflow.mjs: command parsing, body checks,
 * repo config and mode, deploy globs. Run: node --test plugins/github-workflow/tests/hooks/*.test.mjs
 * The hook's behaviour as a process -- its exit codes -- is tested in gates.test.mjs.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter, resolve } from "node:path";

import {
  tokenize, stripHeredocs, findGhTarget, argValue, resolveBody, missingMarkers,
  accidentalClosers, issueNumber, hasDeployImpact, changedFiles,
  parseConfig, loadRepoContext, normalizeRepo, isAdopted, closingOptionOff,
  closingGateEnabled, globToRegExp, deployTriggersIn, deployBases, LINTER, FIND_DUPLICATES,
  resolveExecutable, heredocBodies, bodySources, nativePath,
  gitCommands, discardForm, pushTargets, discardOptionOff, discardGateEnabled, checkoutAt, headBranch,
  defaultCandidates, branchExists, selfCheck, ghRepo, absolutePathEnv,
} from "../../hooks/check-issue-workflow.mjs";

const temps = [];
const temp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), `ghwf ${prefix}-`));
  temps.push(d);
  return d;
};
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const BLOCK = `**Searched:** \`coupon in:title\`
**Candidates:** none
**Verdict:** file`;
const gitAvailable = spawnSync("git", ["--version"]).error === undefined;

// ------------------------------------------------------------------ parsing

describe("tokenize", () => {
  test("keeps a quoted string with spaces as one token", () => {
    const toks = tokenize(`gh issue create --title "a b c"`).filter((t) => !t.op);
    assert.deepEqual(toks.map((t) => t.v), ["gh", "issue", "create", "--title", "a b c"]);
  });

  test("does not split on an operator inside quotes", () => {
    const toks = tokenize(`gh issue create --body "a && b"`);
    assert.equal(toks.filter((t) => t.op).length, 0);
  });

  test("marks && between commands as an operator", () => {
    assert.equal(tokenize(`cd x && gh issue create`).filter((t) => t.op).length, 1);
  });

  test("single quotes suppress escapes", () => {
    const toks = tokenize(`gh issue create --body 'a \\n b'`).filter((t) => !t.op);
    assert.equal(toks.at(-1).v, "a \\n b");
  });

  // The shell removes a backslash-newline pair entirely, joining the two physical
  // lines into one logical line -- it is not a command separator. The tokenizer's escape
  // clause was guarded `cmd[i + 1] !== "\n"`, so this fell through to the catch-all: a
  // literal `\` was appended to the current token and the following `\n` was then read by
  // the bare-newline clause as an operator, splitting one `gh issue create` into two
  // "commands" partway through and losing every flag after the first continuation.
  test("a backslash-newline continuation tokenizes the same as the single-line equivalent", () => {
    const continued = tokenize(
      'gh issue create \\\n  --title "x" \\\n  --label "type:bug"',
    ).filter((t) => !t.op);
    const single = tokenize(`gh issue create --title "x" --label "type:bug"`).filter(
      (t) => !t.op,
    );
    assert.deepEqual(
      continued.map((t) => t.v),
      single.map((t) => t.v),
    );
  });

  test("a backslash-newline continuation is not a command separator", () => {
    assert.equal(tokenize("gh issue create \\\n  --title x").filter((t) => t.op).length, 0);
  });

  // Bash removes a backslash-newline pair inside double quotes too, joining the quoted
  // value's two lines with no literal backslash or newline left behind.
  test("a backslash-newline continuation inside double quotes is also removed", () => {
    const toks = tokenize('gh issue create --body "a \\\nb"').filter((t) => !t.op);
    assert.equal(toks.at(-1).v, "a b");
  });
});

describe("findGhTarget", () => {
  test("finds create in a compound command", () => {
    const f = findGhTarget(`cd "/a b" && gh issue create --title x`);
    assert.equal(f.action, "create");
    assert.deepEqual(f.args, ["--title", "x"]);
  });

  test("stops collecting args at the next command", () => {
    const f = findGhTarget(`gh issue edit 7 --add-label a && echo done`);
    assert.deepEqual(f.args, ["7", "--add-label", "a"]);
  });

  test("matches an absolute path to gh", () => {
    assert.equal(findGhTarget(`/usr/bin/gh issue create -b x`).action, "create");
  });

  test("ignores other gh subcommands", () => {
    assert.equal(findGhTarget(`gh issue view 7 --comments`), null);
    assert.equal(findGhTarget(`gh issue comment 7 --body x`), null);
  });

  // PRs were first excluded by design, on the rule that every non-`gh issue` command exits
  // 0. That was widened after PRs shipped unlabelled because nothing looked at them.
  test("finds a pr create and labels it as such", () => {
    const f = findGhTarget(`gh pr create --title x --base main`);
    assert.equal(f.kind, "pr");
    assert.equal(f.action, "create");
  });

  test("finds a pr edit", () => {
    const f = findGhTarget(`gh pr edit 7 --add-label type:chore`);
    assert.equal(f.kind, "pr");
    assert.equal(f.action, "edit");
  });

  test("tags an issue command as kind issue", () => {
    assert.equal(findGhTarget(`gh issue create --title x`).kind, "issue");
  });

  test("ignores pr subcommands that are not create or edit", () => {
    assert.equal(findGhTarget(`gh pr merge 7 --merge`), null);
    assert.equal(findGhTarget(`gh pr view 7 --comments`), null);
    assert.equal(findGhTarget(`gh pr checkout 7`), null);
  });

  test("ignores an unrelated command", () => {
    assert.equal(findGhTarget(`git log --oneline`), null);
  });
});

// Regression: this hook blocked its own commit. The commit message quoted the words
// "gh issue create", the heredoc body tokenized as bare words, and three of them matched.
describe("stripHeredocs", () => {
  const commit = `git commit -F - <<'EOF'
chore: enforce the gate

  PreToolUse  gh issue create with no Searched: block -> exit 2.
EOF
git log --oneline -1`;

  test("a commit message quoting the command is not a command", () => {
    assert.equal(findGhTarget(commit), null);
  });

  test("commands after the terminator are still seen", () => {
    const after = `cat <<EOF
gh issue create --title x
EOF
gh issue edit 7 --add-label area:ci`;
    const f = findGhTarget(after);
    assert.equal(f.action, "edit");
    assert.deepEqual(f.args, ["7", "--add-label", "area:ci"]);
  });

  test("handles the <<- indented form", () => {
    assert.equal(findGhTarget(`cat <<-END\n\tgh issue create -b x\n\tEND`), null);
  });

  test("handles an unquoted delimiter", () => {
    assert.equal(findGhTarget(`cat <<EOF\ngh issue create -b x\nEOF`), null);
  });

  test("leaves a herestring alone", () => {
    assert.equal(stripHeredocs(`foo <<<"bar"`), `foo <<<"bar"`);
  });

  test("an unterminated heredoc swallows the rest rather than misfiring", () => {
    assert.equal(findGhTarget(`cat <<EOF\ngh issue create -b x`), null);
  });

  test("a real create is still found when a heredoc precedes it", () => {
    const cmd = `cat <<EOF > /tmp/b.md\nbody text\nEOF\ngh issue create --body-file /tmp/b.md`;
    assert.equal(findGhTarget(cmd).action, "create");
  });

  test("the args carry no trace of a heredoc operator", () => {
    const f = findGhTarget(`gh pr create --body-file - <<'EOF' --title x\nbody\nEOF`);
    assert.deepEqual(f.args, ["--body-file", "-", "--title", "x"]);
  });
});

// Stripping keeps heredoc bodies from reading as commands; capturing them lets the gates judge
// the body gh will actually send.
describe("heredocBodies", () => {
  test("captures the body, the opener's line and a > target", () => {
    const docs = heredocBodies(`echo start\ncat > pr.md <<'EOF'\nline one\n\nline three\nEOF\ngh pr create --body-file pr.md`);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].body, "line one\n\nline three");
    assert.equal(docs[0].line, 1);
    assert.equal(docs[0].target, "pr.md");
    assert.equal(docs[0].append, false);
  });

  test("a redirect after the opener, quoted and appending, is the target", () => {
    const [doc] = heredocBodies(`cat <<EOF >> "my notes.md"\nx\nEOF`);
    assert.equal(doc.target, "my notes.md");
    assert.equal(doc.append, true);
  });

  test("an attached redirect is the target", () => {
    assert.equal(heredocBodies(`cat >pr.md <<"EOF"\nx\nEOF`)[0].target, "pr.md");
  });

  test("a heredoc inside --body \"$(cat <<'EOF' ...)\" has no target", () => {
    const [doc] = heredocBodies(`gh pr create --title t --body "$(cat <<'EOF'\n## Summary\n\nRefs #12\nEOF\n)"`);
    assert.equal(doc.target, null);
    assert.equal(doc.line, 0);
    assert.equal(doc.body, "## Summary\n\nRefs #12");
  });

  test("a heredoc piped into tee has no > target", () => {
    assert.equal(heredocBodies(`cat <<'EOF' | tee pr.md\nx\nEOF`)[0].target, null);
  });

  test("<<- strips leading tabs from the body", () => {
    assert.equal(heredocBodies(`cat <<-END\n\tindented\n\t\tdeeper\n\tEND`)[0].body, "indented\ndeeper");
  });

  test("two openers on one line take their bodies in order", () => {
    const docs = heredocBodies(`paste <<A /dev/stdin <<B\nfirst\nA\nsecond\nB`);
    assert.deepEqual(docs.map((d) => d.body), ["first", "second"]);
    assert.deepEqual(docs.map((d) => d.line), [0, 0]);
  });

  test("a herestring is not a heredoc", () => {
    assert.deepEqual(heredocBodies(`grep x <<<"bar"`), []);
  });

  test("stripHeredocs and heredocBodies agree on where a body ends", () => {
    const cmd = `cat <<EOF\ngh issue create --title x\nEOF\ngh issue edit 7`;
    assert.equal(stripHeredocs(cmd), "cat  \ngh issue edit 7");
    assert.equal(heredocBodies(cmd)[0].body, "gh issue create --title x");
  });
});

describe("findGhTarget — where the gh command sits", () => {
  test("the gh command's line, in the original command", () => {
    const f = findGhTarget(`cat > pr.md <<'EOF'\na\nb\nEOF\ngh pr create --body-file pr.md`);
    assert.equal(f.line, 4);
    assert.equal(f.endLine, 4);
  });

  test("a --body heredoc and continuation lines widen the command's line range", () => {
    const f = findGhTarget(`gh pr create \\\n  --body "$(cat <<'EOF'\nbody\nEOF\n)"`);
    assert.equal(f.line, 0);
    assert.equal(f.endLine, 4);
  });

  test("flags an argument the shell expands, and only outside single quotes", () => {
    const f = findGhTarget(`gh pr create --title "$T" --body 'a \`b\` $c' --label x`);
    assert.deepEqual(f.args, ["--title", "$T", "--body", "a `b` $c", "--label", "x"]);
    assert.deepEqual(f.expands, [false, true, false, false, false, false]);
  });

  test("an escaped dollar is literal", () => {
    assert.deepEqual(findGhTarget(`gh pr create --body "costs \\$PRICE"`).expands, [false, false]);
  });

  test("lists files the command writes before gh by redirect or tee, not by heredoc", () => {
    const f = findGhTarget(
      `cat > a.md <<'EOF'\nx\nEOF\necho y > b.md && echo z >>c.md; echo w | tee -a d.md e.md && gh pr create --body-file b.md > out.txt`,
    );
    assert.deepEqual(f.writes, ["b.md", "c.md", "d.md", "e.md"]);
  });

  test("fd duplication is not a file write", () => {
    assert.deepEqual(findGhTarget(`echo x >&2 && echo y 2>&1 && gh pr create -b z`).writes, []);
  });
});

describe("argValue", () => {
  test("reads the space-separated form", () => {
    assert.equal(argValue(["--body", "x"], ["--body", "-b"]), "x");
  });
  test("reads the = form", () => {
    assert.equal(argValue(["--body=x y"], ["--body", "-b"]), "x y");
  });
  test("returns null when absent", () => {
    assert.equal(argValue(["--title", "x"], ["--body"]), null);
  });
});

describe("missingMarkers", () => {
  test("accepts the bold form", () => {
    assert.deepEqual(missingMarkers(BLOCK), []);
  });
  test("accepts the plain form", () => {
    assert.deepEqual(missingMarkers("Searched: a\nCandidates: none\nVerdict: file"), []);
  });
  test("names each missing line", () => {
    assert.deepEqual(missingMarkers("**Searched:** a"), ["candidates:", "verdict:"]);
  });
  test("an empty body is missing all three", () => {
    assert.equal(missingMarkers("").length, 3);
  });
});

describe("issueNumber", () => {
  test("create: from the URL gh prints", () => {
    assert.equal(
      issueNumber("create", [], "https://github.com/o/r/issues/217\n"),
      "217",
    );
  });
  test("create: null when stdout has no URL", () => {
    assert.equal(issueNumber("create", [], "some error"), null);
  });
  test("edit: from the leading positional", () => {
    assert.equal(issueNumber("edit", ["217", "--add-label", "x"], ""), "217");
  });
  test("edit: from a positional URL", () => {
    assert.equal(issueNumber("edit", ["https://github.com/o/r/issues/9"], ""), "9");
  });
  test("edit: does not mistake a flag value for the target", () => {
    assert.equal(issueNumber("edit", ["--milestone", "3"], ""), null);
  });
});

// The linter looks gh and jq up by bare name in the user's repository.
describe("absolutePathEnv", () => {
  test("drops empty and relative PATH entries, keeps the rest of the environment", () => {
    const env = absolutePathEnv({ PATH: "/usr/bin::bin:./x:/opt/b", HOME: "/h" }, "linux");
    assert.deepEqual(env, { PATH: "/usr/bin:/opt/b", HOME: "/h" });
  });

  test("on Windows, rewrites the Path key whatever its case", () => {
    const env = absolutePathEnv({ Path: 'C:\\a;;rel;"C:\\b c"' }, "win32");
    assert.deepEqual(env, { Path: 'C:\\a;"C:\\b c"' });
  });

  test("no PATH at all is left alone", () => {
    assert.deepEqual(absolutePathEnv({ HOME: "/h" }, "linux"), { HOME: "/h" });
  });
});

describe("ghRepo", () => {
  test("--repo first, then the edit target's URL, then GH_REPO", () => {
    const url = ["https://github.com/someone/else/issues/42", "--add-label", "bug"];
    assert.equal(ghRepo(["7", "--repo", "a/b"], { GH_REPO: "c/d" }), "a/b");
    assert.equal(ghRepo(url, { GH_REPO: "c/d" }), "someone/else");
    assert.equal(ghRepo(["https://github.com/o/r/pull/3"], {}), "o/r");
    assert.equal(ghRepo(["7"], { GH_REPO: "c/d" }), "c/d");
    assert.equal(ghRepo(["7"], {}), null);
    assert.equal(ghRepo(["7"], { GH_REPO: "" }), null);
  });

  test("a URL in a flag value is not the target", () => {
    assert.equal(ghRepo(["7", "--body", "https://github.com/x/y/issues/1"], {}), null);
  });
});

describe("accidentalClosers", () => {
  // GitHub's scanner is a substring matcher. These are the shapes that fired in practice and
  // wrongly closed issues -- some of them from the very PR that documented the trap.

  test("an ordinary closing keyword in prose is allowed", () => {
    assert.deepEqual(accidentalClosers("Closes #123\n\nSome explanation."), []);
  });

  test("several ordinary keywords are allowed", () => {
    assert.deepEqual(accidentalClosers("Closes #1, closes #2, fixes #3"), []);
  });

  test("a negation is caught", () => {
    const found = accidentalClosers("**Does not close #17** -- three of four criteria are met.");

    assert.equal(found.length, 1);
    assert.match(found[0].reason, /negated/);
  });

  test("every negation form is caught", () => {
    for (const body of [
      "this doesn't fix #12",
      "won't resolve #40",
      "will not close #7",
      "never closes #7",
      "merging this does not fix #7",
      "instead of that, this resolves #9",
    ]) {
      assert.ok(accidentalClosers(body).length > 0, `not caught: ${body}`);
    }
  });

  test("a code span is caught", () => {
    const found = accidentalClosers("The doc warns that `Closes #231, #244` links only the first.");

    assert.ok(found.length > 0);
    assert.match(found[0].reason, /code span/);
  });

  test("a fenced block is caught", () => {
    const found = accidentalClosers("Write it like this:\n\n```\nCloses #123\n```\n");

    assert.equal(found.length, 1);
    assert.match(found[0].reason, /fenced/);
  });

  test("a tilde fence is caught too", () => {
    const found = accidentalClosers("~~~\nfixes #55\n~~~\n");

    assert.equal(found.length, 1);
    assert.match(found[0].reason, /fenced/);
  });

  test("a blockquote is caught", () => {
    const found = accidentalClosers("> Closes #99 -- quoted from the other PR");

    assert.equal(found.length, 1);
    assert.match(found[0].reason, /blockquote/);
  });

  test("a #NNN placeholder is allowed, since it names no live issue", () => {
    assert.deepEqual(accidentalClosers("`Does not close #NNN` closes #NNN on merge."), []);
  });

  test("prose after a legitimate keyword does not negate it", () => {
    assert.deepEqual(accidentalClosers("Closes #12. It does not address the migration."), []);
  });

  // The run-up is the keyword's own clause: a negation in the sentence before says nothing
  // about it, and advising `Refs #N` there would leave the issue open.
  test("a negation in an earlier sentence or clause does not negate the keyword", () => {
    for (const body of [
      "Not a breaking change. Closes #12",
      "Small fix that can't regress checkout. Fixes #7",
      "Without this, checkout returns 500. Fixes #9",
      "No migration, doesn't touch the API -- closes #3",
    ]) {
      assert.deepEqual(accidentalClosers(body), [], `wrongly flagged: ${body}`);
    }
  });

  test("a negation in the keyword's own clause is still caught after an earlier sentence", () => {
    assert.equal(accidentalClosers("Small change. This does not close #12.").length, 1);
  });

  test("the offending line and text are reported, so the author can find it", () => {
    const found = accidentalClosers("intro\nmore\n> Closes #99 here");

    assert.equal(found[0].line, 3);
    assert.match(found[0].text, /Closes #99/);
  });

  test("multiple offenders are all reported", () => {
    const body = "does not close #1\n`fixes #2`\n> resolves #3";

    assert.equal(accidentalClosers(body).length, 3);
  });

  // GitHub accepts a colon after the keyword and a cross-repository `owner/repo#N` target.
  test("a keyword followed by a colon is caught", () => {
    const found = accidentalClosers("This does not close: #12.");
    assert.equal(found.length, 1);
    assert.match(found[0].reason, /negated/);
  });

  test("a cross-repository owner/repo#N target is caught", () => {
    const found = accidentalClosers("This does not close acme/shop#12.");
    assert.equal(found.length, 1);
    assert.match(found[0].reason, /negated/);
  });

  test("the colon and cross-repository forms in plain prose are still allowed", () => {
    assert.deepEqual(accidentalClosers("Closes: #12\nFixes acme/shop#3"), []);
  });
});

// ---------------------------------------------------------------- deploy impact line
//
// The trigger is inferrable (which paths changed); the action is not (nothing can infer "this
// needs an nginx reload"). So the gate asks for a sentence rather than trying to write one,
// and "none" is a real answer that must be typed out.

describe("hasDeployImpact", () => {
  test("accepts an explicit none", () => {
    assert.equal(hasDeployImpact("## Risk\n\nDeploy impact: none\n"), true);
  });

  test("accepts the bold form", () => {
    assert.equal(hasDeployImpact("**Deploy impact:** needs SENTRY_DSN set"), true);
  });

  test("is case-insensitive", () => {
    assert.equal(hasDeployImpact("deploy IMPACT: none"), true);
  });

  test("accepts it as a list item", () => {
    assert.equal(hasDeployImpact("- Deploy impact: none"), true);
  });

  test("rejects a body that never mentions it", () => {
    assert.equal(hasDeployImpact("## What\n\nA change.\n"), false);
  });

  // An empty label is the failure this gate exists to catch: it looks answered and says
  // nothing. The template ships the heading, so a body can carry it without a decision.
  test("rejects the label with nothing after it", () => {
    assert.equal(hasDeployImpact("Deploy impact:\n\n## Next"), false);
  });

  test("does not match the phrase in running prose", () => {
    assert.equal(hasDeployImpact("This has no deploy impact worth noting."), false);
  });

  // The exact line .github/pull_request_template.md ships. Emphasis is stripped before
  // matching, or the closing `**` would count as the answer and every templated PR would
  // pass the gate while saying nothing -- the one case this check exists to catch.
  test("rejects the unfilled template line", () => {
    assert.equal(hasDeployImpact("**Risk:**\n**Rollback:**\n\n**Deploy impact:**\n"), false);
  });

  test("accepts the template line once filled", () => {
    assert.equal(hasDeployImpact("**Deploy impact:** none\n"), true);
  });
});

describe("changedFiles", () => {
  test("returns null when git cannot answer", () => {
    const bare = mkdtempSync(join(tmpdir(), "hook-nogit-"));
    try {
      assert.equal(changedFiles(bare, "main"), null, "unknown must not read as empty");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  /** A real repository with one commit, so git has something it could diff. */
  const seededRepo = () => {
    const dir = temp("git");
    const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "README.md"), "seed\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed", "--no-verify");
    return dir;
  };

  // The base comes from the gh command the model writes. Handed to git as `--output=x...HEAD`
  // it is parsed as an option: git writes a file and reports an empty diff.
  test("an option-like base is refused, never parsed by git", { skip: !gitAvailable }, () => {
    const dir = seededRepo();
    assert.equal(changedFiles(dir, "--output=x"), null, "unknown, so the gate fails open");
    assert.equal(existsSync(join(dir, "x...HEAD")), false, "git must never see the base as an option");
  });

  test("an empty base is unknown, not an empty diff", { skip: !gitAvailable }, () => {
    assert.equal(changedFiles(seededRepo(), ""), null);
  });

  test("an option-like head is refused too", { skip: !gitAvailable }, () => {
    const dir = seededRepo();
    assert.equal(changedFiles(dir, "main", "--output=y"), null);
    assert.equal(existsSync(join(dir, "y")), false);
  });
});

describe("resolveBody", () => {
  test("--web skips: a human completes the form", () => {
    assert.ok(resolveBody(["--web"], ".").skip);
  });
  test("a body on stdin skips", () => {
    assert.ok(resolveBody(["--body-file", "-"], ".").skip);
  });
  test("no body flag reads as an empty body", () => {
    assert.deepEqual(resolveBody(["--title", "x"], "."), { text: "" });
  });
  test("a CRLF body file is read as written", () => {
    const dir = temp("body");
    writeFileSync(join(dir, "b.md"), "line one\r\nthis does not close #12\r\n");
    const r = resolveBody(["--body-file", "b.md"], dir);
    assert.equal(accidentalClosers(r.text).length, 1);
  });
});

// What main does: find the gh command, then resolve its body from what the shell will feed it.
describe("resolveBody — bodies the shell builds", () => {
  const body = (cmd, cwd = temp("body")) => {
    const f = findGhTarget(cmd);
    return resolveBody(f.args, cwd, bodySources(cmd, f));
  };

  test("--body \"$(cat <<'EOF' ...)\" is the heredoc's body", () => {
    assert.deepEqual(body(`gh pr create --body "$(cat <<'EOF'\n## Summary\n\nRefs #12\nEOF\n)"`), {
      text: "## Summary\n\nRefs #12",
    });
  });

  test("the --body= form too", () => {
    assert.deepEqual(body(`gh pr create --body="$(cat <<'EOF'\nRefs #12\nEOF\n)"`), { text: "Refs #12" });
  });

  test("an expansion with no heredoc on the gh command's line is skipped, never read as text", () => {
    assert.ok(body(`gh issue create --body "$(cat issue.md)"`).skip);
    assert.ok(body(`gh issue create --body "$BODY"`).skip);
    assert.ok(body("gh issue create --body \"`cat issue.md`\"").skip);
    assert.ok(body(`gh issue create --body "\${BODY}"`).skip);
  });

  // The closing gate judges what is literal in such a body: expansions only add text, and a
  // literal `does not close #12` stays in it. A command substitution's own text is not the body.
  test("an expanded inline body skips, but carries its literal text", () => {
    const r = body(`gh pr create --body "This does not close #12 for $USER."`);
    assert.ok(r.skip);
    assert.equal(r.literal, "This does not close #12 for $USER.");
    assert.equal(body("gh pr create --body \"Does not close #12, see `x`\"").literal, "Does not close #12, see  ");
    assert.equal(body(`gh pr create --body "A $(printf 'does not close #%s' 12) B"`).literal, "A   B");
  });

  test("a heredoc on an earlier line is not the gh command's body", () => {
    const cmd = `BODY=$(cat <<'EOF'\nRefs #12\nEOF\n)\ngh pr create --body "$BODY"`;
    assert.ok(body(cmd).skip);
  });

  test("a single-quoted body with backticks and dollars is literal text", () => {
    assert.deepEqual(body("gh pr create --body 'Use `x` for $5'"), { text: "Use `x` for $5" });
  });

  test("--body-file - takes the heredoc on the gh command's line", () => {
    assert.deepEqual(body(`gh pr create --body-file - <<'EOF'\nRefs #12\nEOF`), { text: "Refs #12" });
  });

  test("--body-file - with no heredoc still skips", () => {
    assert.ok(body(`gh pr create --body-file -`).skip);
  });

  test("--body-file F written by an earlier heredoc is that heredoc, without reading the disk", () => {
    const dir = temp("body");
    writeFileSync(join(dir, "pr.md"), "stale: does not close #12\n");
    const r = body(`cat > pr.md <<'EOF'\nRefs #12\nEOF\ngh pr create --body-file pr.md`, dir);
    assert.equal(r.text.trim(), "Refs #12");
  });

  test("a heredoc target and the --body-file path match through the cwd", () => {
    const dir = temp("body");
    mkdirSync(join(dir, "sub"));
    const r = body(`cat > ./sub/pr.md <<'EOF'\nRefs #12\nEOF\ngh pr create --body-file sub/pr.md`, dir);
    assert.equal(r.text.trim(), "Refs #12");
  });

  test("an appending heredoc adds to what the file holds", () => {
    const dir = temp("body");
    writeFileSync(join(dir, "pr.md"), "first\n");
    const r = body(`cat >> pr.md <<'EOF'\nsecond\nEOF\ngh pr create --body-file pr.md`, dir);
    assert.equal(r.text, "first\nsecond\n");
  });

  test("--body-file F that the command writes another way is skipped", () => {
    const dir = temp("body");
    writeFileSync(join(dir, "pr.md"), "stale\n");
    assert.ok(body(`printf 'x' > pr.md && gh pr create --body-file pr.md`, dir).skip);
    assert.ok(body(`echo x | tee pr.md; gh pr create --body-file pr.md`, dir).skip);
  });

  test("a heredoc written to another file does not stand in for the body file", () => {
    const dir = temp("body");
    writeFileSync(join(dir, "pr.md"), "on disk\n");
    const r = body(`cat > other.md <<'EOF'\nnot this\nEOF\ngh pr create --body-file pr.md`, dir);
    assert.deepEqual(r, { text: "on disk\n" });
  });
});

// Git Bash hands Node POSIX paths; Node on Windows resolves `/tmp/x` as `C:\tmp\x`.
describe("nativePath", () => {
  const win = { platform: "win32", env: { PATH: "" } }; // no cygpath: the fallback mapping

  test("leaves every path alone off Windows", () => {
    assert.deepEqual(nativePath("/tmp/pr.md", { platform: "linux", env: {} }), { path: "/tmp/pr.md" });
  });
  test("leaves a relative or drive path alone on Windows", () => {
    assert.deepEqual(nativePath("pr.md", win), { path: "pr.md" });
    assert.deepEqual(nativePath("C:/x/pr.md", win), { path: "C:/x/pr.md" });
  });
  test("maps /<letter>/rest to the drive", () => {
    assert.deepEqual(nativePath("/c/Users/Jane Doe/pr.md", win), { path: "C:/Users/Jane Doe/pr.md" });
  });
  test("maps /tmp/rest to the temp directory", () => {
    assert.deepEqual(nativePath("/tmp/pr.md", win), { path: join(tmpdir(), "pr.md") });
  });
  test("any other POSIX path cannot be placed, so it skips", () => {
    assert.ok(nativePath("/home/me/pr.md", win).skip);
  });
  test("asks cygpath first when there is one", { skip: process.platform !== "win32" || !resolveExecutable("cygpath") }, () => {
    const r = nativePath("/usr/bin");
    assert.ok(r.path && !r.path.startsWith("/"), `not translated: ${JSON.stringify(r)}`);
  });
});

describe("CRLF bodies", () => {
  test("a CRLF Deploy impact line with an answer counts", () => {
    assert.equal(hasDeployImpact("## Risk\r\n\r\nDeploy impact: none\r\n"), true);
  });
  test("a CRLF Deploy impact label with nothing after it does not", () => {
    assert.equal(hasDeployImpact("Deploy impact:\r\n\r\n## Next\r\n"), false);
  });
  test("a CRLF fenced block still hides nothing from the closing check", () => {
    assert.equal(accidentalClosers("```\r\nCloses #123\r\n```\r\n").length, 1);
  });
});

describe("parseConfig", () => {
  test("accepts a minimal config", () => {
    assert.deepEqual(parseConfig('{"version":1}'), { config: { version: 1 } });
  });
  test("strips a UTF-8 BOM and tolerates CRLF", () => {
    assert.equal(parseConfig('\uFEFF{"version":1,\r\n"repo":"a/b"}\r\n').config.repo, "a/b");
  });
  test("names invalid JSON", () => {
    assert.match(parseConfig("{nope").error, /not valid JSON/);
  });
  test("rejects a non-object", () => {
    assert.match(parseConfig("[]").error, /object/);
  });
  test("rejects an unknown version", () => {
    assert.match(parseConfig('{"version":2}').error, /version/);
  });
  test("rejects gates that are not an object", () => {
    assert.match(parseConfig('{"version":1,"gates":true}').error, /gates/);
  });
  test("rejects deployImpact without a paths array", () => {
    assert.match(
      parseConfig('{"version":1,"gates":{"deployImpact":{"paths":"x"}}}').error,
      /deployImpact/,
    );
  });
});

describe("loadRepoContext", () => {
  const repo = (config) => {
    const dir = temp("repo");
    mkdirSync(join(dir, ".git"));
    if (config !== undefined) {
      mkdirSync(join(dir, ".github"));
      writeFileSync(join(dir, ".github", "github-workflow.json"), config);
    }
    return dir;
  };

  test("finds the config at the repository root", () => {
    const dir = repo('{"version":1,"repo":"acme/shop"}');
    const ctx = loadRepoContext(dir);
    assert.equal(ctx.config.repo, "acme/shop");
    assert.equal(ctx.root, dir);
  });

  test("walks up from a subdirectory", () => {
    const dir = repo('{"version":1}');
    const sub = join(dir, "src", "cart");
    mkdirSync(sub, { recursive: true });
    assert.deepEqual(loadRepoContext(sub).config, { version: 1 });
  });

  test("only the repository root's config counts, never one in a subdirectory", () => {
    const dir = repo('{"version":1,"repo":"acme/shop"}');
    const sub = join(dir, "fixtures", "other");
    mkdirSync(join(sub, ".github"), { recursive: true });
    writeFileSync(join(sub, ".github", "github-workflow.json"), '{"version":1,"repo":"x/y"}');
    const ctx = loadRepoContext(sub);
    assert.equal(ctx.root, dir);
    assert.equal(ctx.config.repo, "acme/shop");
  });

  test("stops at the repository root: a parent's config never leaks in", () => {
    const parent = temp("parent");
    mkdirSync(join(parent, ".github"));
    writeFileSync(join(parent, ".github", "github-workflow.json"), '{"version":1}');
    const child = join(parent, "nested");
    mkdirSync(join(child, ".git"), { recursive: true });
    const ctx = loadRepoContext(child);
    assert.equal(ctx.config, undefined);
    assert.equal(ctx.root, child);
  });

  test("a repository without a config is guest mode", () => {
    const ctx = loadRepoContext(repo());
    assert.equal(ctx.config, undefined);
    assert.equal(ctx.error, undefined);
  });

  test("a malformed config reports its error and path", () => {
    const ctx = loadRepoContext(repo("{nope"));
    assert.match(ctx.error, /not valid JSON/);
    assert.match(ctx.path, /github-workflow\.json$/);
  });
});

describe("normalizeRepo", () => {
  test("owner/name, any case", () => assert.equal(normalizeRepo("Acme/Shop"), "acme/shop"));
  test("HOST/OWNER/REPO", () => assert.equal(normalizeRepo("github.com/acme/shop"), "acme/shop"));
  test("a URL with .git", () => {
    assert.equal(normalizeRepo("https://github.com/acme/shop.git"), "acme/shop");
  });
  test("a trailing slash", () => assert.equal(normalizeRepo("acme/shop/"), "acme/shop"));
  test("a bare name is not a repo", () => assert.equal(normalizeRepo("shop"), null));
  test("a non-string is not a repo", () => assert.equal(normalizeRepo(undefined), null));
});

describe("isAdopted", () => {
  const ctx = { config: { version: 1, repo: "acme/shop" } };
  test("no config is guest", () => assert.equal(isAdopted({}, null), false));
  test("a config and no --repo is adopted", () => assert.equal(isAdopted(ctx, null), true));
  test("--repo naming the same repo in another form is adopted", () => {
    assert.equal(isAdopted(ctx, "https://github.com/ACME/shop"), true);
  });
  test("--repo naming another repo is guest", () => {
    assert.equal(isAdopted(ctx, "acme/other"), false);
  });
  test("--repo with a config that names no repo is guest -- unknown never blocks", () => {
    assert.equal(isAdopted({ config: { version: 1 } }, "acme/shop"), false);
  });
});

describe("closing gate switches", () => {
  test("on by default", () => assert.equal(closingGateEnabled({}, undefined), true));
  for (const v of ["false", "0", "no", "off", "OFF", " false "]) {
    test(`the user option ${JSON.stringify(v)} turns it off`, () => {
      const env = { CLAUDE_PLUGIN_OPTION_CLOSING_KEYWORD_GATE: v };
      assert.equal(closingOptionOff(env), true);
      assert.equal(closingGateEnabled(env, {}), false);
    });
  }
  for (const v of ["true", "1", ""]) {
    test(`the user option ${JSON.stringify(v)} leaves it on`, () => {
      assert.equal(closingGateEnabled({ CLAUDE_PLUGIN_OPTION_CLOSING_KEYWORD_GATE: v }, {}), true);
    });
  }
  test("the repo switch turns it off", () => {
    assert.equal(closingGateEnabled({}, { closingKeywords: false }), false);
  });
});

describe("deploy globs", () => {
  test("** spans directories", () => {
    assert.deepEqual(deployTriggersIn(["migrations/2026/01_add.sql"], ["migrations/**"]), [
      "migrations/2026/01_add.sql",
    ]);
  });
  test("* stays within one segment", () => {
    assert.deepEqual(
      deployTriggersIn(["config/production.yml", "config/production/x.yml"], ["config/production.*"]),
      ["config/production.yml"],
    );
  });
  test("a trailing slash means everything below", () => {
    assert.equal(deployTriggersIn(["infra/main.tf"], ["infra/"]).length, 1);
  });
  test("patterns are anchored at the repository root", () => {
    assert.deepEqual(deployTriggersIn(["docs/infra/notes.md"], ["infra/**"]), []);
  });
  test("**/ matches zero or more directories", () => {
    assert.equal(deployTriggersIn(["schema.sql", "db/schema.sql"], ["**/schema.sql"]).length, 2);
  });
  test("regex metacharacters are literal", () => {
    assert.deepEqual(deployTriggersIn(["a+b/c.txt", "aab/c.txt"], ["a+b/*.txt"]), ["a+b/c.txt"]);
  });
  test("? is one character within a segment", () => {
    assert.ok(globToRegExp("v?.sql").test("v1.sql"));
    assert.ok(!globToRegExp("v?.sql").test("v/.sql"));
  });
  test("backslashes in paths are normalised", () => {
    assert.equal(deployTriggersIn(["infra\\main.tf"], ["infra/**"]).length, 1);
  });
});

describe("deployBases", { skip: !gitAvailable }, () => {
  test("--base is tried on the remote first, then locally", () => {
    assert.deepEqual(deployBases(temp("nogit"), "develop"), ["origin/develop", "develop"]);
  });
  test("with no origin/HEAD it falls back to main", () => {
    const dir = temp("git");
    spawnSync("git", ["init", "-q"], { cwd: dir });
    assert.deepEqual(deployBases(dir, null), ["origin/main", "main"]);
  });
  test("an option-like --base yields no base at all", () => {
    assert.deepEqual(deployBases(temp("nogit"), "--output=x"), []);
  });
});

describe("resolveExecutable", () => {
  // The host's own platform, so the fixture is named the way this OS looks a binary up.
  const exe = process.platform === "win32" ? "tool.exe" : "tool";
  const binDir = () => {
    const d = temp("bin");
    writeFileSync(join(d, exe), "");
    return d;
  };
  const pathOf = (...entries) => ({ PATH: entries.join(delimiter) });
  /** Run `fn` with the process cwd at `dir`, which is where an empty or relative entry points. */
  const inDir = (dir, fn) => {
    const prev = process.cwd();
    process.chdir(dir);
    try {
      return fn();
    } finally {
      process.chdir(prev);
    }
  };

  test("finds a file in an absolute PATH directory, in PATH order", () => {
    const first = binDir();
    const second = binDir();
    assert.equal(resolveExecutable("tool", pathOf(temp("empty"), first, second)), join(first, exe));
  });

  test("ignores a relative entry even when that directory holds the file", () => {
    const d = binDir();
    mkdirSync(join(d, "planted"));
    writeFileSync(join(d, "planted", exe), "");
    assert.equal(inDir(d, () => resolveExecutable("tool", pathOf(".", "planted"))), null);
  });

  test("ignores empty entries, which would also mean the working directory", () => {
    const d = binDir();
    assert.equal(inDir(d, () => resolveExecutable("tool", pathOf("", ""))), null);
    const other = binDir();
    assert.equal(inDir(d, () => resolveExecutable("tool", pathOf("", other))), join(other, exe));
  });

  test("strips the double quotes Windows allows around an entry", () => {
    const d = binDir();
    assert.equal(resolveExecutable("tool", pathOf(`"${d}"`)), join(d, exe));
  });

  test("skips a directory that carries the executable's name", () => {
    const decoy = temp("bin");
    mkdirSync(join(decoy, exe));
    const real = binDir();
    assert.equal(resolveExecutable("tool", pathOf(decoy, real)), join(real, exe));
  });

  test("returns null when nothing matches", () => {
    assert.equal(resolveExecutable("tool", pathOf(temp("empty"))), null);
    assert.equal(resolveExecutable("tool", {}), null);
  });
});

describe("plugin-relative paths", () => {
  test("the linter resolves next to the skill, not in the user's repo", () => {
    assert.match(
      LINTER.replace(/\\/g, "/"),
      /\/skills\/github-workflow\/scripts\/lint-issue-labels\.sh$/,
    );
  });
  test("so does the duplicate search", () => {
    assert.match(
      FIND_DUPLICATES.replace(/\\/g, "/"),
      /\/skills\/github-workflow\/scripts\/find-duplicates\.sh$/,
    );
  });
});

// ---------------------------------------------------------------- git commands
//
// The ask gates read git commands out of the Bash command the model writes. Quoted text and
// heredoc bodies are data, never commands, and the directory each command runs in is tracked
// through `cd` and `git -C`, because the incident's edit landed in a checkout other than the cwd.

describe("gitCommands", () => {
  const subs = (cmd, cwd = temp("cmd")) => gitCommands(cmd, cwd).map((g) => g.sub);

  test("finds every git command in a compound command, with its subcommand and own args", () => {
    const d = temp("cmd");
    const found = gitCommands("git add . && git commit -m 'x y'; git push | cat", d);
    assert.deepEqual(found.map((g) => g.sub), ["add", "commit", "push"]);
    assert.deepEqual(found[1].args, ["-m", "x y"]);
    assert.equal(found[0].dir, resolve(d));
  });

  test("a cd earlier in the command moves the directory", () => {
    const d = temp("cmd");
    assert.equal(gitCommands("cd sub && git status", d)[0].dir, resolve(d, "sub"));
    assert.equal(gitCommands("cd sub; cd ../other && git status", d)[0].dir, resolve(d, "other"));
  });

  test("git -C applies cumulatively, after any cd", () => {
    const d = temp("cmd");
    assert.equal(gitCommands("cd a && git -C b -C c status", d)[0].dir, resolve(d, "a", "b", "c"));
    assert.equal(gitCommands('git -C "" status', d)[0].dir, resolve(d), "an empty -C changes nothing");
  });

  test("a directory the shell expands is unknown, until an absolute cd", () => {
    const d = temp("cmd");
    assert.equal(gitCommands('cd "$X" && git status', d)[0].dir, null);
    assert.equal(gitCommands("cd ~/x && git status", d)[0].dir, null);
    assert.equal(gitCommands("git -C $(pwd) status", d)[0].dir, null);
    assert.equal(gitCommands("cd - && git status", d)[0].dir, null);
    assert.equal(gitCommands('cd "$X" && cd sub && git status', d)[0].dir, null);
    const abs = temp("abs").replace(/\\/g, "/");
    assert.equal(gitCommands(`cd "$X" && cd "${abs}" && git status`, d)[0].dir, resolve(abs));
  });

  test("--git-dir, --work-tree or a GIT_DIR= prefix makes the directory unknown", () => {
    const d = temp("cmd");
    assert.equal(gitCommands("git --git-dir=x/.git checkout -- lib", d)[0].dir, null);
    assert.equal(gitCommands("git --work-tree x checkout -- lib", d)[0].dir, null);
    assert.equal(gitCommands("GIT_DIR=x git checkout -- lib", d)[0].dir, null);
    assert.equal(gitCommands("LC_ALL=C git checkout -- lib", d)[0].dir, resolve(d));
  });

  test("skips git's global options", () => {
    const g = gitCommands("git --no-pager -c core.x=y --namespace n -p --literal-pathspecs checkout -- lib", temp("cmd"))[0];
    assert.equal(g.sub, "checkout");
    assert.deepEqual(g.args, ["--", "lib"]);
  });

  test("recognises git.exe and an absolute path to git", () => {
    assert.deepEqual(subs("/usr/bin/git status"), ["status"]);
    assert.deepEqual(subs('"C:\\Program Files\\Git\\cmd\\git.exe" status'), ["status"]);
  });

  test("an option git takes in place of a subcommand yields none", () => {
    assert.deepEqual(subs("git --version"), []);
  });

  test("git counts in command position, or after a wrapper; a mere mention does not", () => {
    assert.deepEqual(subs("echo git push origin main"), []);
    assert.deepEqual(subs("grep -rn git checkout.md"), []);
    assert.deepEqual(subs("sudo -u bob git reset --hard"), ["reset"]);
    assert.deepEqual(subs("time git commit -m x"), ["commit"]);
    assert.deepEqual(subs("A=1 B=2 git status"), ["status"]);
  });

  test("heredoc bodies and quoted text are never commands", () => {
    assert.deepEqual(subs("git commit -F - <<'EOF'\ngit checkout -- lib\nEOF"), ["commit"]);
    assert.deepEqual(subs('gh pr create --title t --body "git checkout -- lib"'), []);
    assert.deepEqual(subs("echo 'git reset --hard'"), []);
  });

  test("redirects are not arguments", () => {
    assert.deepEqual(gitCommands("git checkout -- lib 2>/dev/null >out.txt", temp("cmd"))[0].args, ["--", "lib"]);
    assert.deepEqual(gitCommands("git checkout -- lib > out.txt", temp("cmd"))[0].args, ["--", "lib"]);
  });

  test("marks the arguments the shell expands", () => {
    assert.deepEqual(gitCommands('git checkout -- "$P" lib', temp("cmd"))[0].expands, [false, true, false]);
  });

  test("a subshell's parentheses hide neither its cd nor its git", () => {
    const d = temp("cmd");
    assert.equal(gitCommands("(cd sub && git status)", d)[0].dir, resolve(d, "sub"));
    assert.deepEqual(gitCommands("(git checkout -- lib)", d)[0].args, ["--", "lib"]);
  });

  test("an unquoted $( ... ) is one word the shell expands", () => {
    const g = gitCommands("git -C $(git rev-parse --show-toplevel) checkout -- lib", temp("cmd"))[0];
    assert.equal(g.sub, "checkout");
    assert.equal(g.dir, null);
    assert.deepEqual(g.args, ["--", "lib"]);
  });

  test("notes a gh command that switches the checkout's branch", () => {
    const found = gitCommands("gh issue develop 7 --name x --checkout && git commit -m y", temp("cmd"));
    assert.equal(found[0].moves, true);
    assert.equal(found[1].sub, "commit");
  });
});

describe("discardForm", () => {
  const form = (cmd, dir = temp("form")) => discardForm(gitCommands(cmd, dir)[0]);
  const whole = (label, kinds = ["tracked"]) => ({ label, paths: [], unknown: false, kinds });

  test("checkout: -f/--force is the whole tree", () => {
    assert.deepEqual(form("git checkout -f"), whole("checkout"));
    assert.deepEqual(form("git checkout --force feature"), whole("checkout"));
    assert.deepEqual(form("git checkout -qf feature"), whole("checkout"));
  });

  test("checkout: the paths after --, with or without a tree-ish", () => {
    assert.deepEqual(form("git checkout -- lib x.txt").paths, ["lib", "x.txt"]);
    assert.deepEqual(form("git checkout HEAD~1 -- lib").paths, ["lib"]);
    assert.equal(form("git checkout feature --"), null, "no paths: a branch switch");
  });

  test("checkout: without --, . or an existing path counts and a branch name does not", () => {
    const d = temp("form");
    mkdirSync(join(d, "lib"));
    assert.deepEqual(form("git checkout .", d).paths, ["."]);
    assert.deepEqual(form("git checkout lib", d).paths, ["lib"]);
    assert.deepEqual(form("git checkout HEAD lib", d).paths, ["lib"]);
    assert.equal(form("git checkout feature", d), null);
    assert.equal(form("git checkout -", d), null);
  });

  test("checkout: -b, -B and --orphan create a branch and keep the tree", () => {
    const d = temp("form");
    mkdirSync(join(d, "lib"));
    assert.equal(form("git checkout -b lib", d), null);
    assert.equal(form("git checkout -B x lib", d), null);
    assert.equal(form("git checkout --orphan x", d), null);
  });

  test("checkout: --pathspec-from-file is the whole tree", () => {
    assert.deepEqual(form("git checkout --pathspec-from-file=list.txt"), whole("checkout"));
  });

  test("restore: the paths, unless --staged alone", () => {
    assert.deepEqual(form("git restore x").paths, ["x"]);
    assert.equal(form("git restore --staged x"), null);
    assert.equal(form("git restore -S x"), null);
    assert.deepEqual(form("git restore --staged --worktree x").paths, ["x"]);
    assert.deepEqual(form("git restore -SW x").paths, ["x"]);
    assert.deepEqual(form("git restore --source HEAD~2 x").paths, ["x"]);
    assert.deepEqual(form("git restore -s HEAD x").paths, ["x"]);
    assert.deepEqual(form("git restore --source=HEAD -- x y").paths, ["x", "y"]);
    assert.deepEqual(form("git restore --pathspec-from-file=f"), whole("restore"));
    assert.equal(form("git restore"), null, "git refuses a restore with no paths");
  });

  test("reset: --hard only", () => {
    assert.deepEqual(form("git reset --hard HEAD~1"), whole("reset --hard"));
    assert.equal(form("git reset"), null);
    assert.equal(form("git reset --soft HEAD~1"), null);
    assert.equal(form("git reset HEAD x"), null);
  });

  test("clean: forced and not a dry run; -x and -X reach ignored files", () => {
    assert.deepEqual(form("git clean -fd"), { label: "clean", paths: ["."], unknown: false, kinds: ["untracked"] });
    assert.deepEqual(form("git clean --force src").paths, ["src"]);
    assert.equal(form("git clean -d"), null);
    assert.equal(form("git clean -n"), null);
    assert.equal(form("git clean -fn"), null);
    assert.equal(form("git clean -f --dry-run"), null);
    assert.deepEqual(form("git clean -xdf").kinds, ["untracked", "ignored"]);
    assert.deepEqual(form("git clean -fX").kinds, ["ignored"]);
    assert.deepEqual(form("git clean -fd -e keep").paths, ["."], "the -e value is not a path");
  });

  test("switch: -f, --force or --discard-changes", () => {
    assert.deepEqual(form("git switch --discard-changes main"), whole("switch"));
    assert.deepEqual(form("git switch -f main"), whole("switch"));
    assert.deepEqual(form("git switch --force main"), whole("switch"));
    assert.equal(form("git switch main"), null);
    assert.equal(form("git switch -c x"), null);
  });

  test("stash: drop and clear", () => {
    assert.equal(form("git stash drop").label, "stash drop");
    assert.equal(form("git stash drop stash@{1}").ref, "stash@{1}");
    assert.equal(form("git stash clear").label, "stash clear");
    assert.equal(form("git stash list"), null);
    assert.equal(form("git stash"), null);
  });

  test("worktree remove: only when forced", () => {
    assert.equal(form("git worktree remove --force ../wt").worktree, "../wt");
    assert.equal(form("git worktree remove -f ../wt").worktree, "../wt");
    assert.equal(form("git worktree remove ../wt"), null);
    assert.equal(form("git worktree add -f ../wt"), null);
  });

  test("a path the shell expands makes the loss unknown", () => {
    assert.equal(form('git checkout -- "$P"').unknown, true);
    assert.equal(form("git restore $(cat list)").unknown, true);
    assert.equal(form('git worktree remove --force "$WT"').unknown, true);
  });

  test("anything else is not a discard", () => {
    for (const c of ["git status", "git add .", "git commit -m x", "git diff -- lib", "git log --oneline"]) {
      assert.equal(form(c), null, c);
    }
  });
});

describe("pushTargets", () => {
  test("no refspec pushes the current branch", () => {
    assert.deepEqual(pushTargets([]), { all: false, current: true, dests: [] });
    assert.deepEqual(pushTargets(["origin"]), { all: false, current: true, dests: [] });
    assert.deepEqual(pushTargets(["-u", "origin"]), { all: false, current: true, dests: [] });
  });

  test("an explicit refspec's destination", () => {
    assert.deepEqual(pushTargets(["origin", "main"]).dests, ["main"]);
    assert.deepEqual(pushTargets(["origin", "HEAD:refs/heads/main"]).dests, ["main"]);
    assert.deepEqual(pushTargets(["origin", "+feature:main"]).dests, ["main"]);
    assert.deepEqual(pushTargets(["origin", "+main"]).dests, ["main"]);
    assert.deepEqual(pushTargets(["-u", "origin", "feat/x"]).dests, ["feat/x"]);
    assert.deepEqual(pushTargets(["-o", "ci.skip", "origin", "main"]).dests, ["main"]);
    assert.equal(pushTargets(["origin", "main"]).current, false);
  });

  test("HEAD is the current branch", () => {
    assert.equal(pushTargets(["origin", "HEAD"]).current, true);
  });

  test("a deletion's destination", () => {
    assert.deepEqual(pushTargets(["origin", ":main"]).dests, ["main"]);
    assert.deepEqual(pushTargets(["--delete", "origin", "main"]).dests, ["main"]);
    assert.deepEqual(pushTargets(["origin", "-d", "main"]).dests, ["main"]);
  });

  test("--all and --mirror", () => {
    assert.equal(pushTargets(["--all", "origin"]).all, true);
    assert.equal(pushTargets(["--mirror"]).all, true);
  });
});

describe("discard gate switches", () => {
  test("on by default", () => assert.equal(discardGateEnabled({}, undefined), true));
  for (const v of ["false", "0", "no", "off", "OFF", " false "]) {
    test(`the user option ${JSON.stringify(v)} turns it off`, () => {
      const env = { CLAUDE_PLUGIN_OPTION_DISCARD_GATE: v };
      assert.equal(discardOptionOff(env), true);
      assert.equal(discardGateEnabled(env, {}), false);
    });
  }
  for (const v of ["true", "1", ""]) {
    test(`the user option ${JSON.stringify(v)} leaves it on`, () => {
      assert.equal(discardGateEnabled({ CLAUDE_PLUGIN_OPTION_DISCARD_GATE: v }, {}), true);
    });
  }
  test("the repo switch turns it off", () => {
    assert.equal(discardGateEnabled({}, { discardChanges: false }), false);
  });
  test("the closing gate's option does not touch it", () => {
    assert.equal(discardGateEnabled({ CLAUDE_PLUGIN_OPTION_CLOSING_KEYWORD_GATE: "off" }, {}), true);
  });
});

// The branch gate runs on every Edit and Write in every repository, so it finds the checkout and
// its branch by reading files, never by spawning git.
describe("checkoutAt and headBranch", () => {
  test("a .git directory", () => {
    const d = temp("co");
    mkdirSync(join(d, ".git"));
    mkdirSync(join(d, "src"));
    assert.deepEqual(checkoutAt(join(d, "src")), { root: d, gitDir: join(d, ".git") });
  });

  test("a .git file, as in a linked worktree, with its gitdir resolved against the root", () => {
    const d = temp("co");
    writeFileSync(join(d, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
    assert.deepEqual(checkoutAt(d), { root: d, gitDir: resolve(d, "../main/.git/worktrees/wt") });
  });

  test("walks up from a path that does not exist yet", () => {
    const d = temp("co");
    mkdirSync(join(d, ".git"));
    assert.equal(checkoutAt(join(d, "not", "yet", "here")).root, d);
  });

  test("outside any repository there is none", () => {
    assert.equal(checkoutAt(temp("nogit")), null);
  });

  test("the default-branch candidates come from origin/HEAD on disk, else main and master", () => {
    const git = temp("co");
    assert.deepEqual(defaultCandidates(git), ["main", "master"]);
    mkdirSync(join(git, "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(git, "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/develop\n");
    assert.deepEqual(defaultCandidates(git), ["develop"]);
    // A linked worktree's git directory names the common one, where the refs live.
    const wt = join(git, "worktrees", "wt");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "commondir"), "../..\n");
    assert.deepEqual(defaultCandidates(wt), ["develop"]);
  });

  test("the branch HEAD names, and none when detached or unreadable", () => {
    const d = temp("co");
    writeFileSync(join(d, "HEAD"), "ref: refs/heads/feat/x\n");
    assert.equal(headBranch(d), "feat/x");
    writeFileSync(join(d, "HEAD"), "3f2a9c0e8b1d4a6f7e5c2b9a8d7e6f5a4b3c2d1e\n");
    assert.equal(headBranch(d), null);
    assert.equal(headBranch(join(d, "missing")), null);
  });
});

describe("selfCheck — the ask gates without git", () => {
  test("both rows are NOT RUNNING, git not found", () => {
    const d = temp("co");
    mkdirSync(join(d, ".git"));
    mkdirSync(join(d, ".github"));
    writeFileSync(join(d, ".github", "github-workflow.json"), '{"version":1}');
    const rows = Object.fromEntries(selfCheck(d, { PATH: "" }).map((r) => [r.name, r]));
    assert.deepEqual(rows["branch gate"], { name: "branch gate", ready: false, note: "git not found" });
    assert.deepEqual(rows["discard gate"], { name: "discard gate", ready: false, note: "git not found" });
  });
});

describe("gitCommands — review round 1", () => {
  const subs = (cmd, cwd = temp("cmd")) => gitCommands(cmd, cwd).map((g) => g.sub);

  test("shell keywords before a command are skipped", () => {
    assert.deepEqual(subs("if true; then git checkout -- .; fi"), ["checkout"]);
    assert.deepEqual(subs('for f in a; do git checkout -- "$f"; done'), ["checkout"]);
    assert.deepEqual(subs("if false; then :; elif x; then git reset --hard; else git clean -fd; fi"), ["reset", "clean"]);
    assert.deepEqual(subs("while git diff --quiet; do sleep 1; done"), ["diff"]);
    assert.deepEqual(subs("until ! git pull; do :; done"), ["pull"]);
  });

  test("a cd inside a subshell is undone when the subshell closes", () => {
    const d = temp("cmd");
    assert.equal(gitCommands("(cd sub && ls) && git status", d)[0].dir, resolve(d));
    assert.equal(gitCommands("( cd sub; ls ) ; git status", d)[0].dir, resolve(d));
    assert.equal(gitCommands("(cd sub && git status)", d)[0].dir, resolve(d, "sub"));
  });
});

describe("branchExists", () => {
  test("a loose ref, a packed one, origin's, and nothing else", () => {
    const git = temp("refs");
    mkdirSync(join(git, "refs", "heads", "feat"), { recursive: true });
    writeFileSync(join(git, "refs", "heads", "feat", "x"), "0\n");
    writeFileSync(join(git, "packed-refs"), "# pack-refs\nabc refs/heads/packed\nabc refs/remotes/origin/remote-only\n");
    assert.equal(branchExists(git, "feat/x"), true);
    assert.equal(branchExists(git, "packed"), true);
    assert.equal(branchExists(git, "remote-only"), true);
    assert.equal(branchExists(git, "feat"), false, "a directory of refs is not a branch");
    assert.equal(branchExists(git, "lib"), false);
    assert.equal(branchExists(git, "../x"), false);
  });
});
