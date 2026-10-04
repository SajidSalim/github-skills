/** What the plugin ships for agents to copy must be what its own hook accepts. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, missingMarkers } from "../../hooks/check-issue-workflow.mjs";

const HOOK = fileURLToPath(new URL("../../hooks/check-issue-workflow.mjs", import.meta.url));
const read = (rel) => readFileSync(new URL(`../../skills/github-workflow/${rel}`, import.meta.url), "utf8");

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

test("the example config parses without error", () => {
  const r = parseConfig(read("assets/github-workflow.example.json"));
  assert.equal(r.error, undefined);
  assert.equal(r.config.version, 1);
});

/** The first ```markdown block after `heading` in issue-authoring.md. */
function bodyUnder(heading) {
  const doc = read("references/issue-authoring.md").replace(/\r\n/g, "\n");
  const at = doc.indexOf(`\n${heading}\n`);
  assert.notEqual(at, -1, `heading not found: ${heading}`);
  const open = doc.indexOf("```markdown\n", at);
  const close = doc.indexOf("\n```\n", open);
  return doc.slice(open + "```markdown\n".length, close + 1);
}

// The file says every issue body must carry the duplicate-search record; its own templates and
// its example of "a bug filed properly" must too, or an agent copying them gets blocked.
for (const heading of ["## Bug body", "## Feature / enhancement body", "## Worked example — a bug filed properly"]) {
  test(`issue-authoring.md "${heading.slice(3)}" carries the duplicate-search record`, () => {
    assert.deepEqual(missingMarkers(bodyUnder(heading)), []);
  });
}

test("the worked example, filed as written, passes the hook's duplicate gate in an adopted repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "ghwf assets-"));
  temps.push(dir);
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, ".github", "github-workflow.json"), JSON.stringify({ version: 1, repo: "acme/shop" }));
  writeFileSync(join(dir, "issue.md"), bodyUnder("## Worked example — a bug filed properly"));
  const payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    cwd: dir,
    tool_input: {
      command: `gh issue create --title "[SEV-2] Checkout returns 500 when the coupon code is blank" --body-file issue.md`,
    },
  };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
