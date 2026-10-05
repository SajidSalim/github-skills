/**
 * The launch as the host performs it: each command in hooks/hooks.json, run through `sh -c` with
 * CLAUDE_PLUGIN_ROOT set and a payload on stdin, and the gate's exit code read back. On macOS and
 * Linux Claude Code runs a shell-form hook with `sh -c`; on Windows it runs Git Bash.
 *
 * This file needs Node and a POSIX sh, and nothing else: CI runs it in a container with no bash
 * (busybox sh), where the launcher must still work. git is used when it is there.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, copyFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../plugins/github-workflow", import.meta.url));
const HOOKS_JSON = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
const LAUNCH = '/bin/sh "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh"';

const temps = [];
const temp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), `ghwf ${prefix}-`));
  temps.push(d);
  return d;
};
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

/** Every command hook in hooks.json, with the event and matcher it hangs under. */
const commands = Object.entries(HOOKS_JSON.hooks).flatMap(([event, groups]) =>
  groups.flatMap((g) => g.hooks.filter((h) => h.type === "command")
    .map((h) => ({ event, matcher: g.matcher, command: h.command, shell: h.shell }))));

/** The outer shell, by absolute path: the child's PATH is under test, so it cannot find sh. */
function findSh() {
  if (process.platform !== "win32") return existsSync("/bin/sh") ? "/bin/sh" : null;
  const key = Object.keys(process.env).find((k) => /^path$/i.test(k)) ?? "PATH";
  for (const dir of (process.env[key] ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "sh.exe"))) return join(dir, "sh.exe");
  }
  return null;
}
const SH = findSh();
/** The distinct command strings, so each check below runs what hooks.json actually says. */
const launches = [...new Set(commands.map((c) => c.command))];
const has = (prog) => spawnSync(prog, ["--version"], { encoding: "utf8" }).status === 0;

/** `sh -c <command>`, as the host runs it, with an environment built only from `env`. */
function host(command, { root = ROOT, cwd, path, payload, env = {} } = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^path$/i.test(k)) delete base[k];
  const r = spawnSync(SH, ["-c", command], {
    cwd,
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...base,
      PATH: path ?? process.env.PATH ?? process.env.Path,
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_PLUGIN_OPTION_CLOSING_KEYWORD_GATE: "",
      CLAUDE_PLUGIN_OPTION_DISCARD_GATE: "",
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}

// The closing-keyword gate runs in every repository and needs nothing but Node.
const CLOSER = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: 'gh pr create --title t --body "This does not close #12"' },
};

const nodeDir = dirname(process.execPath);

/** A copy of the plugin's hooks under a path with a space, as Windows profile paths often have. */
function pluginCopy() {
  const root = join(temp("Jane Doe"), "github-workflow");
  mkdirSync(join(root, "hooks"), { recursive: true });
  for (const f of ["run-hook.sh", "check-issue-workflow.mjs", "hooks.json"]) {
    copyFileSync(join(ROOT, "hooks", f), join(root, "hooks", f));
  }
  return root;
}

describe("hooks.json, launched as the host launches it", { skip: SH ? false : "no POSIX sh found" }, () => {
  test("every command starts the launcher with /bin/sh by absolute path", () => {
    assert.ok(commands.length >= 3, "PreToolUse Bash, PreToolUse edits and PostToolUse Bash");
    for (const c of commands) assert.equal(c.command, LAUNCH, `${c.event} ${c.matcher}`);
  });

  // Without "shell": "bash", Claude Code on Windows without Git Bash hands the string to
  // PowerShell, where /bin/sh means <drive>:\bin\sh.* (see the PowerShell block below).
  test("every command hook sets shell bash, so the host never runs it under PowerShell", () => {
    for (const c of commands) assert.equal(c.shell, "bash", `${c.event} ${c.matcher}`);
  });

  test("CLAUDE_PLUGIN_ROOT in the environment: a block comes through with exit 2", () => {
    for (const c of commands) {
      const r = host(c.command, { root: pluginCopy(), payload: CLOSER, cwd: temp("cwd") });
      assert.equal(r.status, 2, `${c.event} ${c.matcher}: ${r.out}`);
      assert.match(r.out, /BLOCKED/);
    }
  });

  // Claude Code substitutes the placeholder into the string before the shell sees it, and on
  // Windows that is a native path with backslashes.
  test("the placeholder substituted with the native path: still exit 2", () => {
    const root = pluginCopy();
    const r = host(LAUNCH.replace("${CLAUDE_PLUGIN_ROOT}", root), { root: "", payload: CLOSER, cwd: temp("cwd") });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /BLOCKED/);
  });

  test("without node on PATH the launch exits 0 and says nothing", () => {
    for (const cmd of launches) {
      const r = host(cmd, { payload: CLOSER, path: temp("empty"), cwd: temp("cwd") });
      assert.equal(r.status, 0, r.out);
      assert.equal(r.out, "");
    }
  });

  // The point of the absolute interpreter (#31): with `.` first on PATH, the old `bash` launch ran
  // a `bash` committed to the repository. Nothing in the working directory runs now.
  test("a bash, sh or node planted in the working directory never runs", () => {
    const repo = temp("repo");
    for (const name of ["bash", "sh", "node"]) {
      writeFileSync(join(repo, name), "#!/bin/sh\necho PLANTED-RAN\nexit 0\n");
      chmodSync(join(repo, name), 0o755);
    }
    for (const cmd of launches) {
      for (const path of [`.${delimiter}${nodeDir}`, `${delimiter}${nodeDir}`]) {
        const r = host(cmd, { payload: CLOSER, path, cwd: repo });
        assert.doesNotMatch(r.out, /PLANTED-RAN/, `PATH=${path}`);
        assert.equal(r.status, 2, `the real node runs the hook (PATH=${path}): ${r.out}`);
      }
    }
  });

  test("an ask comes through on stdout with exit 0", { skip: has("git") ? false : "git not found" }, () => {
    const repo = temp("repo");
    const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    mkdirSync(join(repo, "lib"));
    writeFileSync(join(repo, "lib", "a.txt"), "a\n");
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed", "--no-verify");
    writeFileSync(join(repo, "lib", "a.txt"), "b\n");
    const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: repo, tool_input: { command: "git checkout -- lib" } };
    const r = host(launches[0], { payload, cwd: repo });
    assert.equal(r.status, 0, `an ask is not a block: ${r.out}`);
    assert.match(r.stdout, /"permissionDecision":"ask"/);
    assert.match(r.stdout, /lib\/a\.txt/);
    assert.equal(readFileSync(join(repo, "lib", "a.txt"), "utf8"), "b\n", "the hook changes nothing");
  });
});

// ------------------------------------------------------------ Windows without Git Bash
//
// There, Claude Code runs a shell-form hook under PowerShell unless the hook says
// "shell": "bash", in which case it reports that Git Bash was not found and runs nothing.
// PowerShell reads /bin/sh as rooted on the current drive and applies PATHEXT, so a
// <drive>:\bin\sh.cmd would run: any local account can create C:\bin, and a repository at a
// drive root can commit one. A subst drive whose root holds bin\sh.cmd stands in for both.

const POWERSHELLS = process.platform === "win32"
  ? ["powershell.exe", "pwsh.exe"].filter((p) =>
    spawnSync(p, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" }).status === 0)
  : [];

/** Map a free drive letter to a temp directory whose root holds a planted bin\sh.cmd. */
function plantedDrive() {
  const dir = temp("drive");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "sh.cmd"), "@echo PLANTED-SH-RAN %*\r\n");
  for (const letter of "QRSTUVWXYPONMLKJ") {
    if (existsSync(`${letter}:\\`)) continue;
    if (spawnSync("subst", [`${letter}:`, dir], { encoding: "utf8" }).status === 0) {
      after(() => spawnSync("subst", [`${letter}:`, "/D"]));
      return `${letter}:\\`;
    }
  }
  return null;
}

/** The string as the host would hand it to PowerShell, the placeholder substituted. */
function underPowerShell(exe, command, cwd) {
  const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", command.replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT)], {
    cwd,
    input: JSON.stringify(CLOSER),
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT },
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

/**
 * The shell Claude Code picks for a hook on Windows when Git Bash is not installed (read from
 * 2.1.289): the hook's own `shell`, else PowerShell. With "bash" it throws "requires bash but Git
 * Bash was not found" and spawns nothing.
 */
const shellWithoutGitBash = (hook) => hook.shell ?? "powershell";

// Registered on Windows only, so the other platforms' CI steps can demand zero skipped cases.
if (process.platform === "win32") describe("Windows without Git Bash: a planted <drive>:\\bin\\sh never runs",
  { skip: POWERSHELLS.length ? false : "no PowerShell found" }, () => {
    const drive = POWERSHELLS.length ? plantedDrive() : null;
    const needsDrive = { skip: drive ? false : "no free drive letter for subst" };

    // The control shows that the rig catches a plant, and why the hooks need "shell": "bash".
    test("control: a bare /bin/sh string under PowerShell does run the drive-root plant", needsDrive, () => {
      for (const exe of POWERSHELLS) {
        for (const cmd of launches) assert.match(underPowerShell(exe, cmd, drive), /PLANTED-SH-RAN/, exe);
      }
    });

    test("no hooks.json command reaches PowerShell, so the plant never runs", needsDrive, () => {
      for (const c of commands) {
        const shell = shellWithoutGitBash(c);
        if (shell === "powershell") {
          for (const exe of POWERSHELLS) {
            assert.doesNotMatch(underPowerShell(exe, c.command, drive), /PLANTED-SH-RAN/, `${exe}: ${c.event} ${c.matcher}`);
          }
        }
        assert.equal(shell, "bash", `${c.event} ${c.matcher} would be handed to PowerShell`);
      }
    });
  });
