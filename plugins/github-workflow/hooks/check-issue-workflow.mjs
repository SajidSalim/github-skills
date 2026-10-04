#!/usr/bin/env node
/**
 * github-workflow plugin hook: the GitHub-workflow checks that leave no trace when skipped.
 *
 *   PreToolUse   gh pr create|edit     a closing keyword GitHub would act on by accident
 *                                      (negated, quoted, in code) -> exit 2. Every repo.
 *                gh pr create          touches a configured deploy path with no
 *                                      `Deploy impact:` line -> exit 2. Adopted repos.
 *                gh issue create       no Searched:/Candidates:/Verdict: record -> exit 2.
 *                                      Adopted repos.
 *                git checkout -- P, restore, reset --hard, clean -f, switch --discard-changes,
 *                stash drop|clear, worktree remove -f -- with uncommitted work it would lose
 *                                      -> ask the human. Every repo.
 *                git commit|merge|cherry-pick|revert|am on the default branch, or a push to it
 *                                      -> ask the human. Adopted repos.
 *                Edit|Write|MultiEdit|NotebookEdit of a file in a checkout on its default
 *                branch, unless git ignores it -> ask the human. Adopted repos.
 *   PostToolUse  gh issue|pr create|edit -> lint-issue-labels.sh on the item; a FAIL line
 *                                      -> exit 2 carrying the report. Adopted repos.
 *
 * "Adopted" means the repository has .github/github-workflow.json and, when the command names
 * a repo with --repo, that it is the repo the config describes. Everything else is guest mode,
 * where only the closing-keyword and discard gates run. For an edit, the repository is the one
 * holding the FILE, never the session's cwd: a subagent in a worktree can write into the main
 * checkout, and that is the case the branch gate exists for.
 *
 * Exit 2 feeds stderr back to the model, which then corrects itself. An "ask" is different: it
 * exits 0 with permissionDecision "ask", and Claude Code puts a confirm prompt in front of the
 * human -- in every permission mode, and for a subagent's call too. The human's yes is the
 * "unless the operator says so" the rules allow, so these two gates ask rather than block. A
 * block from a gh gate on the same command wins: exit 2, and no ask.
 *
 * Any environment gap -- no git, gh, jq or bash, an unreadable body or payload -- exits 0: a
 * missing dependency must never block the user's work. /github-workflow:doctor and
 * `--self-check` report those gaps instead.
 *
 * Limits, deliberately:
 *   - It verifies a Searched: block EXISTS, not that the searches ran. That turns silently
 *     skipping into actively fabricating: a higher bar, not a wall.
 *   - Hook matchers key on the tool name, so every Bash call and every edit reaches this file.
 *     Everything before the `gh`/`git` match is therefore kept cheap, and an edit is judged by
 *     reading files until it is known to be on a default branch: no git process before that.
 *   - The discard gate asks only when git status shows something would be lost. When it cannot
 *     tell -- a directory or path the shell expands -- it asks with the command alone.
 *   - Not gated: git pull, rebase, reset --soft/--mixed and branch -f on the default branch, and
 *     git run where the command text does not show it -- `bash -c "..."`, a script, find -exec.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS = join(PLUGIN_ROOT, "skills", "github-workflow", "scripts");
export const LINTER = join(SCRIPTS, "lint-issue-labels.sh");
export const FIND_DUPLICATES = join(SCRIPTS, "find-duplicates.sh");
export const CONFIG_PATH = [".github", "github-workflow.json"];

// The three lines references/duplicate-check.md requires. Asterisks are stripped before
// matching, so `**Searched:**` and `Searched:` both satisfy it.
const REQUIRED = ["searched:", "candidates:", "verdict:"];

const ISSUE_URL = /github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/;
const PR_URL = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/;
// `gh <kind> edit` takes a number or either URL form positionally, so the target of an
// edit is matched loosely; a create is matched against its own kind, since that URL is
// gh's own output and the kind is already known.
const ANY_URL = /github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/(\d+)/;

/** Flags that mean "a human finishes this in a browser" -- the form applies labels there. */
const WEB_FLAGS = ["--web", "-w"];

// `Deploy impact: none` is a valid answer and must be written out. Same device as the PR
// template's Risk and rollback section: an explicit "none" is a decision, a missing line is
// a question nobody asked.
// The content must be on the same line as the label: `[^\S\r\n]` is horizontal whitespace
// only. A plain `\s*` would step over the newline and accept the next heading as the answer,
// so a body carrying the template's empty `Deploy impact:` would pass while saying nothing.
//
// Emphasis is stripped before matching (see hasDeployImpact) for the same reason: the PR
// template ships the label bold and unfilled as `**Deploy impact:**`, and the closing `**`
// is a non-space character that would otherwise read as the answer.
const DEPLOY_IMPACT = /^[>\s-]*deploy impact:[^\S\r\n]*\S/im;

// ---------------------------------------------------------------- shell parsing

/**
 * Split a command into tokens, honouring quotes and marking shell operators.
 *
 * Needed because the command arrives as one string and may be compound:
 * `cd foo && gh issue create --body "a && b"`. Operators are kept as distinct tokens so
 * argument collection stops at the end of the gh segment rather than swallowing the next
 * command.
 */
export function tokenize(cmd) {
  const toks = [];
  let cur = "";
  let started = false;
  let expands = false;
  let at = 0;
  let i = 0;

  // Each token records where it starts and ends in `cmd`, and whether the shell expands part of
  // it -- a `$(`, `${`, `$NAME` or backtick outside single quotes -- so its text is not what the
  // command receives.
  const begin = () => {
    if (!started) at = i;
    started = true;
  };
  const flush = () => {
    if (started) toks.push({ v: cur, op: false, at, end: i, expands });
    cur = "";
    started = false;
    expands = false;
  };
  const opensExpansion = (j) =>
    cmd[j] === "`" || (cmd[j] === "$" && /[({A-Za-z_]/.test(cmd[j + 1] ?? ""));

  while (i < cmd.length) {
    const c = cmd[i];

    if (c === "'") {
      begin();
      const end = cmd.indexOf("'", i + 1);
      cur += end === -1 ? cmd.slice(i + 1) : cmd.slice(i + 1, end);
      i = end === -1 ? cmd.length : end + 1;
      continue;
    }

    if (c === '"') {
      begin();
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        // Bash removes a backslash-newline pair inside double quotes too -- it is a line
        // continuation there as much as it is outside quotes, and joins the value's two
        // physical lines with no literal backslash or newline left behind.
        if (cmd[i] === "\\" && cmd[i + 1] === "\n") {
          i += 2;
        } else if (cmd[i] === "\\" && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) {
          cur += cmd[i + 1];
          i += 2;
        } else {
          if (opensExpansion(i)) expands = true;
          cur += cmd[i];
          i++;
        }
      }
      i++;
      continue;
    }

    // A backslash-newline pair, unquoted, is a shell line continuation: bash deletes both
    // characters and joins the two physical lines into one logical one. It is not an escape
    // (nothing is emitted) and not a command separator. Whatever indentation follows
    // on the continued line is ordinary whitespace and flushes on its own. This clause's
    // ordering relative to the plain escape clause below does not matter for correctness --
    // that clause's own `cmd[i + 1] !== "\n"` guard already excludes this case regardless of
    // which is checked first; it is written first only so the two backslash cases read
    // together.
    if (c === "\\" && cmd[i + 1] === "\n") {
      i += 2;
      continue;
    }

    // Any other backslash: an ordinary escape, one character consumed literally.
    if (c === "\\" && i + 1 < cmd.length) {
      begin();
      cur += cmd[i + 1];
      i += 2;
      continue;
    }

    if (/\s/.test(c) && c !== "\n") {
      flush();
      i++;
      continue;
    }

    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      flush();
      toks.push({ v: two, op: true, at: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (c === ";" || c === "|" || c === "\n" || c === "&") {
      flush();
      toks.push({ v: c, op: true, at: i, end: i + 1 });
      i++;
      continue;
    }

    begin();
    if (opensExpansion(i)) expands = true;
    cur += c;
    i++;
  }

  flush();
  return toks;
}

/**
 * Remove heredoc bodies, which are data rather than command text.
 *
 * Found by this hook blocking its own commit: a commit message written with
 * `git commit -F - <<'EOF'` that quotes the words "gh issue create" is not an attempt to
 * create an issue, but the tokenizer saw three bare words and matched them. Quoted strings
 * were already safe -- they tokenize as one unit -- so heredocs were the remaining gap.
 */
export function stripHeredocs(cmd) {
  return scanHeredocs(cmd, () => " ").text;
}

// `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`.
//
// Both guards are load-bearing against `<<<"bar"`: without the lookahead the first two `<`
// match and the third breaks it, but without the lookbehind the LAST two `<` match and `"bar"`
// reads as a quoted delimiter. A test caught exactly that.
const OPENER = /(?<!<)<<(?!<)(-?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/g;

/**
 * The command with each heredoc body and terminator removed and each opener replaced by
 * `mark(n)`; which original line each remaining line was; and the bodies themselves,
 * `[{ delim, body, line }]`, where `line` is the opener's line in `cmd`.
 */
function scanHeredocs(cmd, mark) {
  const lines = cmd.split("\n");
  const kept = [];
  const lineOf = [];
  const docs = [];
  let i = 0;

  while (i < lines.length) {
    const line = i;
    const opened = [];
    kept.push(
      lines[i].replace(OPENER, (_, dash, q1, q2, bare) => {
        opened.push({ delim: q1 ?? q2 ?? bare, dash: dash === "-" });
        return mark(docs.length + opened.length - 1);
      }),
    );
    lineOf.push(i);
    i++;

    // Bodies follow in the order their openers appeared on the line.
    for (const o of opened) {
      const body = [];
      while (i < lines.length && lines[i].trim() !== o.delim) {
        body.push(o.dash ? lines[i].replace(/^\t+/, "") : lines[i]);
        i++;
      }
      i++; // and drop the terminator line itself
      docs.push({ delim: o.delim, body: body.join("\n"), line });
    }
  }

  return { text: kept.join("\n"), lineOf, docs };
}

// Where an opener stood, findGhTarget and heredocBodies see one token of its own, so a heredoc
// can be tied to the command it feeds. It is never handed on as an argument.
const markOf = (n) => ` __ghwf_heredoc_${n}__ `;
const MARK = /^__ghwf_heredoc_(\d+)__$/;
const MARKS = /\s*__ghwf_heredoc_\d+__\s*/g;

/** Split tokens into simple commands at each operator. */
function simpleCommands(toks) {
  const cmds = [[]];
  for (const t of toks) {
    if (t.op) cmds.push([]);
    else cmds[cmds.length - 1].push(t);
  }
  return cmds;
}

/** The files a simple command's output redirects name: `> F`, `>> F`, `>F`, `2> F`; not `>&2`. */
function redirectsIn(words) {
  const out = [];
  for (let k = 0; k < words.length; k++) {
    const m = /^\d*>(>?)(.*)$/.exec(words[k].v);
    if (!m) continue;
    const path = m[2] !== "" ? m[2] : words[k + 1]?.v;
    if (path && !path.startsWith("&") && !MARK.test(path)) out.push({ path, append: m[1] === ">" });
  }
  return out;
}

/**
 * The heredocs in a command, `[{ delim, target, append, body, line }]`.
 *
 * `target` is the file the heredoc's own command writes with `> FILE` or `>> FILE` (`append`),
 * quotes removed, else null -- a heredoc inside `--body "$(cat <<'EOF' ...)"` has none. `line`
 * is the opener's line in `cmd`.
 */
export function heredocBodies(cmd) {
  const scan = scanHeredocs(cmd, markOf);
  const targets = new Map();
  for (const words of simpleCommands(tokenize(scan.text))) {
    const ids = words.map((w) => MARK.exec(w.v)?.[1]).filter((id) => id !== undefined);
    if (ids.length === 0) continue;
    const r = redirectsIn(words).at(-1);
    for (const id of ids) targets.set(Number(id), r);
  }
  return scan.docs.map((d, n) => ({
    ...d,
    target: targets.get(n)?.path ?? null,
    append: targets.get(n)?.append ?? false,
  }));
}

/**
 * Files the tokens write by redirect or `tee`. A command fed by a heredoc is left out: what it
 * writes is that heredoc, which heredocBodies reports with its target.
 */
function writesIn(toks) {
  const files = [];
  for (const words of simpleCommands(toks)) {
    if (words.length === 0 || words.some((w) => MARK.test(w.v))) continue;
    for (const r of redirectsIn(words)) files.push(r.path);
    if (words[0].v.replace(/\\/g, "/").split("/").pop() === "tee") {
      for (const w of words.slice(1)) if (!w.v.startsWith("-") && !/^\d*>/.test(w.v)) files.push(w.v);
    }
  }
  return files;
}

/**
 * Locate a `gh issue|pr create|edit` invocation.
 *
 * Returns its kind, action and own args; `expands`, parallel to args, true where the shell
 * expands that argument; `line` and `endLine`, the lines of `cmd` the gh command spans (a
 * `--body "$(cat <<'EOF'` heredoc opens inside that range); and `writes`, the files the command
 * writes by redirect or `tee` before gh runs.
 */
export function findGhTarget(cmd) {
  const scan = scanHeredocs(cmd, markOf);
  const toks = tokenize(scan.text);
  const lineAt = (offset) => scan.lineOf[(scan.text.slice(0, offset).match(/\n/g) || []).length];

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.op) continue;

    const base = t.v.replace(/\\/g, "/").split("/").pop();
    if (base !== "gh" && base !== "gh.exe") continue;

    const a = toks[i + 1];
    const b = toks[i + 2];
    if (!a || a.op || (a.v !== "issue" && a.v !== "pr")) continue;
    if (!b || b.op || (b.v !== "create" && b.v !== "edit")) continue;

    const args = [];
    const expands = [];
    let last = b;
    for (let j = i + 3; j < toks.length && !toks[j].op; j++) {
      last = toks[j];
      if (MARK.test(toks[j].v)) continue; // a heredoc operator, not an argument
      args.push(toks[j].v.replace(MARKS, " "));
      expands.push(toks[j].expands);
    }
    return {
      kind: a.v,
      action: b.v,
      args,
      expands,
      line: lineAt(t.at),
      endLine: lineAt(last.end - 1),
      writes: writesIn(toks.slice(0, i)),
    };
  }

  return null;
}

/** Where `--name X` or `--name=X` is, as {index, value} -- index of the value's token -- or null. */
function argAt(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return { index: i + 1, value: args[i + 1] ?? "" };
      if (args[i].startsWith(n + "=")) return { index: i, value: args[i].slice(n.length + 1) };
    }
  }
  return null;
}

/** Value of `--name X` or `--name=X`, or null when absent. */
export function argValue(args, names) {
  return argAt(args, names)?.value ?? null;
}

const hasFlag = (args, names) =>
  args.some((a) => names.includes(a) || names.some((n) => a.startsWith(n + "=")));

// ---------------------------------------------------------------- git commands

// git's own options, before the subcommand. `-C` moves the directory and is handled apart;
// `--git-dir` and `--work-tree` point git at a repository the hook does not follow.
const GIT_FLAGS = new Set([
  "--no-pager", "-p", "--paginate", "-P", "--no-replace-objects", "--no-optional-locks",
  "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--bare",
  "--exec-path",
]);
const GIT_VALUED = new Set(["-c", "--namespace"]);
const GIT_ELSEWHERE = ["--git-dir", "--work-tree"];

const baseName = (v) => v.replace(/\\/g, "/").split("/").pop();
const isGit = (v) => ["git", "git.exe"].includes(baseName(v));
const isGh = (v) => ["gh", "gh.exe"].includes(baseName(v));

/**
 * A simple command's words, without heredoc markers or redirects (`> F`, `2>F`, `< F`, `<<< w`).
 * A redirect is recognised from the command's own text, so a quoted ">" stays an argument. An
 * unquoted `$(git rev-parse --show-toplevel)` is one word the shell expands, not four. A `(`
 * opening or `)` closing a subshell sticks to the first or last word, `(cd x && git status)`,
 * or stands alone; it is taken off and counted. Returns `{ words, opens, closes }`.
 */
function plainWords(input, text) {
  const depth = (v) => (v.match(/\(/g) || []).length - (v.match(/\)/g) || []).length;
  const words = [];
  for (let k = 0; k < input.length; k++) {
    let w = input[k];
    if (w.expands && /\$\(/.test(w.v)) {
      let open = depth(w.v);
      while (open > 0 && k + 1 < input.length) {
        const next = input[++k];
        w = { ...w, v: `${w.v} ${next.v}`, end: next.end, expands: true };
        open += depth(next.v);
      }
    }
    words.push(w);
  }

  const out = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (MARK.test(w.v)) continue;
    const raw = text.slice(w.at, w.end);
    const r = /^\d*(?:>>|>\||<<<|<>|>|<)(.*)$/s.exec(raw);
    if (r) {
      if (r[1] === "") k++; // the target is the next word
      continue;
    }
    out.push(w);
  }
  let opens = 0;
  let closes = 0;
  while (out.length > 0 && text.slice(out[0].at, out[0].end).startsWith("(")) {
    const first = out[0];
    const v = first.v.replace(/^\(+/, "");
    opens += first.v.length - v.length;
    out.splice(0, 1, ...(v ? [{ ...first, v }] : []));
    if (v) break;
  }
  while (out.length > 0) {
    const last = out.at(-1);
    if (!/\)$/.test(text.slice(last.at, last.end)) || last.v.includes("(")) break;
    const v = last.v.replace(/\)+$/, "");
    closes += last.v.length - v.length;
    out.splice(-1, 1, ...(v ? [{ ...last, v }] : []));
    if (v) break;
  }
  return { words: out, opens, closes };
}

/**
 * Where a `cd` or `-C` to `target` lands from `dir`, or null when that cannot be known: no target,
 * `-`, a `~` or anything else the shell expands, a POSIX path Windows cannot place, or a relative
 * move from a directory already unknown.
 */
function moveDir(dir, target) {
  if (!target || target.v === "-" || target.expands || target.v.startsWith("~")) return null;
  // No cygpath: any command that merely mentions "git" gets here. /c/... and /tmp/... still map;
  // any other Git Bash mount is unknown.
  const native = nativePath(target.v, { env: {} });
  if (native.skip) return null;
  if (isAbsolute(native.path)) return resolve(native.path);
  return dir === null ? null : resolve(dir, native.path);
}

/** `cd [-L|-P] [--] DIR`. */
function cdTarget(dir, args) {
  let k = 0;
  while (k < args.length && /^-[LPe@]+$/.test(args[k].v)) k++;
  if (args[k]?.v === "--") k++;
  return moveDir(dir, args[k]);
}

// Shell reserved words that can stand before a command: `if true; then git ...; fi`.
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);

// Commands that run the command after them: `sudo -u x git ...`, `time git ...`.
const WRAPPERS = new Set(["sudo", "doas", "command", "exec", "time", "nice", "nohup", "env", "xargs"]);

/**
 * Where the program `is` matches is the command a simple command runs: its first word after any
 * `NAME=value` assignments, or the first match after a wrapper such as sudo or time. Anything else
 * only mentions it -- `echo git push origin main` pushes nothing. -1 when there is none.
 */
function commandAt(words, is) {
  let first = 0;
  while (first < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[first].v)) first++;
  if (first >= words.length) return -1;
  if (is(words[first].v)) return first;
  if (!WRAPPERS.has(baseName(words[first].v))) return -1;
  return words.findIndex((w, i) => i > first && is(w.v));
}

/** `gh pr checkout` and `gh issue develop --checkout` switch the checkout's branch. */
function ghMovesHead(words) {
  const i = commandAt(words, isGh);
  if (i === -1) return false;
  const [a, b] = [words[i + 1]?.v, words[i + 2]?.v];
  if (a === "pr" && b === "checkout") return true;
  return a === "issue" && b === "develop" && words.slice(i + 3).some((w) => ["--checkout", "-c"].includes(w.v));
}

/**
 * Every git command in `cmd`, in order, with the directory the shell will run it in:
 * `[{ dir, sub, args, expands }]`. `dir` starts at `cwd`, follows each earlier `cd`, then the
 * command's own `-C` options; it is null once it cannot be known. `args` are the subcommand's own
 * words and `expands`, parallel to them, marks those the shell expands. A gh command that switches
 * branches is listed too, as `{ moves: true }`, so a later commit is not judged against a HEAD the
 * same command has already moved.
 *
 * The same tokenizer as the gh gates, so a quoted `--body "... git checkout -- lib"` or a heredoc
 * body never reads as a command. git is recognised as `git`, `git.exe` or an absolute path to
 * either, in command position (commandAt).
 */
export function gitCommands(cmd, cwd) {
  const scan = scanHeredocs(cmd, markOf);
  let dir = typeof cwd === "string" && cwd ? resolve(cwd) : null;
  const found = [];

  // A subshell has its own directory: a cd inside `( ... )` is undone when it closes.
  const saved = [];
  for (const simple of simpleCommands(tokenize(scan.text))) {
    const { words, opens, closes } = plainWords(simple, scan.text);
    for (let n = 0; n < opens; n++) saved.push(dir);
    judge(words);
    for (let n = 0; n < closes && saved.length > 0; n++) dir = saved.pop();
  }
  return found;

  function judge(words) {
    while (words.length > 0 && KEYWORDS.has(words[0].v)) words.shift();
    if (words.length === 0) return;

    const head = words[0].v;
    if (head === "cd" || head === "pushd") {
      dir = cdTarget(dir, words.slice(1));
      return;
    }
    if (head === "popd") {
      dir = null;
      return;
    }
    if (ghMovesHead(words)) {
      found.push({ dir, sub: null, args: [], expands: [], moves: true });
      return;
    }

    const at = commandAt(words, isGit);
    if (at === -1) return;
    let here = words.slice(0, at).some((w) => /^GIT_(DIR|WORK_TREE)=/.test(w.v)) ? null : dir;
    let k = at + 1;
    for (; k < words.length; k++) {
      const a = words[k].v;
      if (a === "-C") {
        const target = words[++k];
        if (!(target && target.v === "" && !target.expands)) here = moveDir(here, target); // -C "" is a no-op
      } else if (GIT_VALUED.has(a)) {
        k++;
      } else if (GIT_ELSEWHERE.includes(a)) {
        k++;
        here = null;
      } else if (GIT_ELSEWHERE.some((o) => a.startsWith(`${o}=`))) {
        here = null;
      } else if (!GIT_FLAGS.has(a) && !a.startsWith("--namespace=") && !a.startsWith("--exec-path=")) {
        break;
      }
    }
    const sub = words[k];
    if (!sub || sub.v.startsWith("-")) return; // `git --version`: no subcommand
    const rest = words.slice(k + 1);
    found.push({ dir: here, sub: sub.v, args: rest.map((w) => w.v), expands: rest.map((w) => Boolean(w.expands)) });
  }
}

/**
 * The letters of a short-option cluster, `-fdx` -> f, d, x. A letter in `valued` takes a value and
 * ends the cluster; `next` says the value is the following word rather than the rest of this one.
 * Null for anything that is not a cluster.
 */
function shortFlags(a, valued = "") {
  if (!/^-[A-Za-z]+$/.test(a)) return null;
  const flags = new Set();
  for (let i = 1; i < a.length; i++) {
    flags.add(a[i]);
    if (valued.includes(a[i])) return { flags, next: i === a.length - 1 };
  }
  return { flags, next: false };
}

const wholeTree = (label) => ({ label, paths: [], unknown: false, kinds: ["tracked"] });
/** `fromIndex`: the paths are restored from the index, so a change only staged is not lost. */
const somePaths = (label, words, fromIndex = false) => ({
  label,
  paths: words.map((w) => w.v),
  unknown: words.some((w) => w.expands),
  kinds: ["tracked"],
  ...(fromIndex ? { fromIndex } : {}),
});

/**
 * Whether git command `g` (from gitCommands) discards uncommitted work, and where to look.
 *
 * Null when it does not. Otherwise `{ label, paths, unknown, kinds }`: `paths` are the pathspecs
 * it touches (none: the whole tree), `unknown` that the shell expands one of them, and `kinds`
 * which `git status` entries it destroys -- tracked changes, untracked files, ignored files.
 * `git stash drop|clear` is `{ label, stash: true, ref }`, and `git worktree remove -f`
 * `{ label, worktree, unknown }`.
 */
export function discardForm(g) {
  if (!g || g.moves) return null;
  const words = g.args.map((v, i) => ({ v, expands: Boolean(g.expands?.[i]) }));
  switch (g.sub) {
    case "checkout":
      return checkoutForm(words, g.dir);
    case "restore":
      return restoreForm(words);
    case "reset": {
      const dd = words.findIndex((w) => w.v === "--");
      return (dd === -1 ? words : words.slice(0, dd)).some((w) => w.v === "--hard") ? wholeTree("reset --hard") : null;
    }
    case "clean":
      return cleanForm(words);
    case "switch":
      return switchForm(words);
    case "stash":
      return stashForm(words);
    case "worktree":
      return worktreeForm(words);
    default:
      return null;
  }
}

/**
 * `git checkout`: -f is the whole tree; `--` names paths, with or without a tree-ish before it;
 * without `--`, `.` or an argument that is an existing path -- unless -b, -B or --orphan make it
 * a new branch. A plain `git checkout feature` switches branches and is not a discard.
 */
function checkoutForm(words, dir) {
  const dd = words.findIndex((w) => w.v === "--");
  const opts = dd === -1 ? words : words.slice(0, dd);
  let force = false;
  let creates = false;
  let fromFile = false;
  const positional = [];
  for (let k = 0; k < opts.length; k++) {
    const a = opts[k].v;
    if (a === "--force") force = true;
    else if (a === "--orphan" || a.startsWith("--orphan=")) {
      creates = true;
      if (a === "--orphan") k++;
    } else if (a === "--pathspec-from-file" || a.startsWith("--pathspec-from-file=")) {
      fromFile = true;
      if (a === "--pathspec-from-file") k++;
    } else if (a.startsWith("--")) continue;
    else if (a.startsWith("-") && a !== "-") {
      const s = shortFlags(a, "bB");
      if (s?.flags.has("f")) force = true;
      if (s?.flags.has("b") || s?.flags.has("B")) {
        creates = true;
        if (s.next) k++;
      }
    } else positional.push(opts[k]);
  }
  if (fromFile) return wholeTree("checkout");
  if (dd !== -1) {
    const paths = words.slice(dd + 1);
    // With no tree-ish before `--`, the paths come back from the index: only worktree changes go.
    if (paths.length > 0) return somePaths("checkout", paths, !force && positional.length === 0);
    return force ? wholeTree("checkout") : null;
  }
  if (force) return wholeTree("checkout");
  if (creates) return null;
  // git reads a first argument that names a branch as the branch, even when a path shares its name.
  const gitDir = dir === null ? null : checkoutAt(dir)?.gitDir;
  const tree = positional[0] && !positional[0].expands && gitDir && branchExists(gitDir, positional[0].v);
  const rest = tree ? positional.slice(1) : positional;
  const paths = rest.filter((w) => w.v === "." || (!w.expands && dir !== null && pathExists(dir, w.v)));
  if (paths.length === 0) return null;
  return somePaths("checkout", paths, !tree && paths[0] === positional[0]);
}

function pathExists(dir, p) {
  const native = nativePath(p);
  return !native.skip && existsSync(resolve(dir, native.path));
}

/** `git restore`: its paths, unless --staged/-S appears without --worktree/-W. */
function restoreForm(words) {
  let staged = false;
  let worktree = false;
  let fromFile = false;
  let source = false;
  const paths = [];
  for (let k = 0; k < words.length; k++) {
    const a = words[k].v;
    if (a === "--") {
      paths.push(...words.slice(k + 1));
      break;
    }
    if (a === "--staged") staged = true;
    else if (a === "--worktree") worktree = true;
    else if (a === "--source" || a === "-s" || a.startsWith("--source=")) {
      source = true;
      if (!a.includes("=")) k++;
    }
    else if (a === "--pathspec-from-file" || a.startsWith("--pathspec-from-file=")) {
      fromFile = true;
      if (a === "--pathspec-from-file") k++;
    } else if (a.startsWith("--")) continue;
    else if (a.startsWith("-") && a !== "-") {
      const s = shortFlags(a, "s");
      if (s?.flags.has("S")) staged = true;
      if (s?.flags.has("W")) worktree = true;
      if (s?.flags.has("s")) source = true;
      if (s?.next) k++;
    } else paths.push(words[k]);
  }
  if (staged && !worktree) return null;
  if (fromFile) return wholeTree("restore");
  // git refuses a restore with no paths. A worktree-only restore with no --source reads the index.
  return paths.length > 0 ? somePaths("restore", paths, !staged && !source) : null;
}

/** `git clean`, forced and not a dry run. -x adds ignored files to untracked ones; -X has only them. */
function cleanForm(words) {
  let force = false;
  let dry = false;
  let x = false;
  let X = false;
  const paths = [];
  for (let k = 0; k < words.length; k++) {
    const a = words[k].v;
    if (a === "--") {
      paths.push(...words.slice(k + 1));
      break;
    }
    if (a === "--force") force = true;
    else if (a === "--dry-run") dry = true;
    else if (a === "--exclude") k++;
    else if (a.startsWith("--")) continue;
    else if (a.startsWith("-") && a !== "-") {
      const s = shortFlags(a, "e");
      if (s?.flags.has("f")) force = true;
      if (s?.flags.has("n")) dry = true;
      if (s?.flags.has("x")) x = true;
      if (s?.flags.has("X")) X = true;
      if (s?.next) k++;
    } else paths.push(words[k]);
  }
  if (!force || dry) return null;
  return {
    label: "clean",
    paths: paths.length > 0 ? paths.map((w) => w.v) : ["."], // git clean starts from the current directory
    unknown: paths.some((w) => w.expands),
    kinds: x ? ["untracked", "ignored"] : X ? ["ignored"] : ["untracked"],
  };
}

/** `git switch -f|--force|--discard-changes`. */
function switchForm(words) {
  for (const { v } of words) {
    if (v === "--") break;
    if (v === "--force" || v === "--discard-changes") return wholeTree("switch");
    if (!v.startsWith("--") && shortFlags(v, "cC")?.flags.has("f")) return wholeTree("switch");
  }
  return null;
}

function stashForm(words) {
  const [op, ...rest] = words;
  if (op?.v === "drop") {
    const ref = rest.find((w) => !w.v.startsWith("-"));
    return { label: "stash drop", stash: true, ref: ref?.v ?? null };
  }
  if (op?.v === "clear") return { label: "stash clear", stash: true, ref: null };
  return null;
}

/** `git worktree remove -f <worktree>`; without -f git refuses a worktree with changes. */
function worktreeForm(words) {
  if (words[0]?.v !== "remove") return null;
  let force = false;
  let path = null;
  for (const w of words.slice(1)) {
    if (w.v === "--force") force = true;
    else if (w.v.startsWith("-") && w.v !== "-") force ||= Boolean(shortFlags(w.v)?.flags.has("f"));
    else path ??= w;
  }
  if (!force || !path) return null;
  return { label: "worktree remove", worktree: path.v, unknown: path.expands };
}

const PUSH_VALUED = new Set(["--repo", "--receive-pack", "--exec", "-o", "--push-option"]);

/**
 * What `git push <args>` writes to: `{ all, current, dests }`. `all` for --all or --mirror;
 * `current` when it pushes the current branch -- no refspec at all, or `HEAD`; `dests` the
 * branches each explicit refspec names as its destination (the part after `:`, else the whole
 * refspec, without a leading `+` or `refs/heads/`), deletions included.
 */
export function pushTargets(args) {
  let all = false;
  let del = false;
  const pos = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") {
      pos.push(...args.slice(k + 1));
      break;
    }
    if (PUSH_VALUED.has(a)) k++;
    else if (a === "--all" || a === "--mirror" || a === "--branches") all = true;
    else if (a === "--delete") del = true;
    else if (a.startsWith("--")) continue;
    else if (/^-[A-Za-z]+$/.test(a)) del ||= a.includes("d");
    else pos.push(a);
  }
  const refspecs = pos.slice(1); // the first is the remote
  const dests = [];
  let current = refspecs.length === 0;
  for (const r of refspecs) {
    if (!del && ["HEAD", "@"].includes(r.replace(/^\+/, ""))) {
      current = true;
      continue;
    }
    const d = del ? r : r.includes(":") ? r.slice(r.indexOf(":") + 1) : r;
    dests.push(d.replace(/^\+/, "").replace(/^refs\/heads\//, ""));
  }
  return { all, current, dests };
}

// ---------------------------------------------------------------- executables

/**
 * The absolute path of `name`, found only in ABSOLUTE `PATH` entries, in PATH order; or null.
 *
 * git and bash are never spawned by bare name. The hook runs them with cwd set to the user's
 * repository, and Windows has historically searched the working directory before PATH, so a
 * cloned repository holding a git.exe or bash.exe could have it run -- in a repository that can
 * also opt itself into adopted mode. An empty or relative PATH entry names a directory relative
 * to the working directory too, so those are skipped as well.
 */
export function resolveExecutable(name, env = process.env, platform = process.platform) {
  const path = env?.PATH ?? env?.Path;
  if (typeof path !== "string") return null;
  const win = platform === "win32";
  const exts = win ? [".exe", ".com"] : [""];
  for (const entry of path.split(win ? ";" : ":")) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = join(dir, name + ext);
      try {
        if (existsSync(file) && statSync(file).isFile()) return file;
      } catch {
        // unreadable: keep looking
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- the body checks

/**
 * A path from the command, made one Node can open. On Windows the Bash tool is Git Bash, whose
 * `/tmp/pr.md` or `/c/Users/...` Node would resolve as `C:\tmp\pr.md` -- a missing file, or the
 * wrong one. cygpath answers for Git Bash's own mounts; without it, `/<letter>/` is that drive
 * and `/tmp/` the temp directory. Any other POSIX path cannot be placed: {skip}.
 */
export function nativePath(file, { platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32" || !file.startsWith("/")) return { path: file };

  const cygpath = resolveExecutable("cygpath", env, platform);
  if (cygpath) {
    const run = spawnSync(cygpath, ["-w", file], { encoding: "utf8", timeout: 2_000 });
    const out = !run.error && run.status === 0 ? run.stdout.trim() : "";
    if (out) return { path: out };
  }

  const drive = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(file);
  if (drive) return { path: `${drive[1].toUpperCase()}:/${drive[2] ?? ""}` };
  const tmp = /^\/tmp(?:\/(.*))?$/.exec(file);
  if (tmp) return { path: join(tmpdir(), tmp[1] ?? "") };
  return { skip: "POSIX path on Windows" };
}

/**
 * What the shell will feed the gh command `found` in `cmd`, for resolveBody: the heredocs that
 * run before or with it (`own` when opened on the gh command's own lines), the files the command
 * writes before gh by other means, and which arguments the shell expands.
 */
export function bodySources(cmd, found) {
  const heredocs = heredocBodies(cmd)
    .filter((h) => h.line <= found.endLine)
    .map((h) => ({ ...h, own: h.line >= found.line }));
  return { heredocs, writes: found.writes ?? [], expands: found.expands ?? [] };
}

/**
 * Resolve the body the gh command will send.
 *
 * Returns {text} when known, or {skip: reason} when it cannot be read -- an unresolvable
 * body is never treated as a missing one. `sources` (bodySources) is what the shell feeds the
 * command: without it every argument is taken literally and every body file read from disk.
 *
 *   --body "$(cat <<'EOF' ... EOF)"   the heredoc opened on the gh command's own lines
 *   --body "$(cat F)", --body "$X"    {skip}: the shell builds it, and the text is not the body
 *   --body-file - <<'EOF'             that heredoc; with none, {skip}: stdin is unreadable
 *   --body-file F                     an earlier heredoc's `> F`, else F on disk -- unless the
 *                                     command writes F some other way first: {skip}, never the
 *                                     stale copy
 */
export function resolveBody(args, cwd, sources = {}) {
  const { heredocs = [], writes = [], expands = [] } = sources;
  if (hasFlag(args, WEB_FLAGS)) return { skip: "--web: a human completes the form" };

  // What feeds gh itself: a heredoc on its own lines that is not redirected into a file.
  const fed = heredocs.filter((h) => h.own && !h.target);

  const file = argAt(args, ["--body-file", "-F"]);
  if (file !== null) {
    if (file.value === "-" && fed.length > 0) return { text: fed[fed.length - 1].body };
    if (file.value === "-" || file.value === "") return { skip: "body arrives on stdin" };
    return bodyFile(file.value, cwd, heredocs, writes);
  }

  const inline = argAt(args, ["--body", "-b"]);
  if (inline !== null) {
    if (!expands[inline.index]) return { text: inline.value };
    if (fed.length > 0) return { text: fed.map((h) => h.body).join("\n") };
    return { skip: "body built by the shell" };
  }

  return { text: "" }; // no body flag at all -- nothing was searched
}

/** The contents `--body-file file` will hold when gh reads it. */
function bodyFile(file, cwd, heredocs, writes) {
  const native = nativePath(file);
  const keyOf = (p) => {
    const n = p === file ? native : nativePath(p);
    if (n.skip) return p; // unplaceable: only the same spelling can match
    const abs = resolve(cwd, n.path);
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  };
  const key = keyOf(file);

  if (writes.some((w) => keyOf(w) === key)) return { skip: "body file written by this command" };

  // The file as it is now: {text}, {absent}, or {skip} when it exists but cannot be read.
  const onDisk = () => {
    if (native.skip) return { skip: native.skip };
    const path = resolve(cwd, native.path);
    if (!existsSync(path)) return { absent: true };
    try {
      return { text: readFileSync(path, "utf8") };
    } catch {
      return { skip: `body file not readable: ${file}` };
    }
  };

  // Heredocs that write the file before gh reads it, in order: `>` replaces it, `>>` appends.
  const docs = heredocs.filter((h) => h.target && keyOf(h.target) === key);
  if (docs.length > 0) {
    let text = null; // null: not yet written by this command
    for (const d of docs) {
      if (d.append && text === null) {
        const now = onDisk();
        if (now.skip) return now;
        text = now.text ?? "";
      }
      text = `${d.append ? text : ""}${d.body}\n`;
    }
    return { text };
  }

  const now = onDisk();
  return now.absent ? { skip: `body file not readable: ${file}` } : now;
}

/** True when the body answers the deploy question at all -- including "none". */
export function hasDeployImpact(body) {
  return DEPLOY_IMPACT.test(body.replace(/[*_]/g, ""));
}

/**
 * Files this branch changes relative to its base.
 *
 * Returns null when git cannot answer -- no repo, no base branch, a shallow clone. An
 * unknown diff is never treated as an empty one: the caller skips the gate rather than
 * asserting a PR touches nothing.
 *
 * A base that is empty or starts with `-` is unknown too. It comes from the command the model
 * writes, and git would parse `--output=FILE...HEAD` as an option: it writes a file and reports
 * an empty diff.
 */
export function changedFiles(cwd, base) {
  if (typeof base !== "string" || base === "" || base.startsWith("-")) return null;
  const git = resolveExecutable("git");
  if (!git) return null;
  const run = spawnSync(git, ["diff", "--name-only", `${base}...HEAD`], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });

  if (run.error || run.status !== 0) return null;

  return run.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Which of the three required lines are absent from a body. */
export function missingMarkers(body) {
  const flat = body.replace(/\*/g, "").toLowerCase();
  return REQUIRED.filter((m) => !flat.includes(m));
}

// ------------------------------------------------- closing keywords fired by accident

/**
 * GitHub's closing-keyword scanner is a substring matcher, not a parser. It fires from a
 * negation and from inside a quotation, so a body that says "does not close #17" closes #17,
 * and one that quotes `Closes #NNN, #MMM` to explain the syntax closes the first issue it
 * names. Documenting that was not enough in practice -- it closed several issues in one
 * session, including from the PR that added the warning -- hence a gate.
 *
 * There is no escaping syntax in GitHub's markdown. `Refs #N` / `Part of #N` are the safe
 * forms, and examples should use a placeholder such as #NNN.
 *
 * GitHub also accepts a colon after the keyword (`Closes: #12`) and a cross-repository target
 * (`Closes owner/repo#12`), so both count.
 */
const CLOSING_KEYWORD = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;

/** Words that mean the author intends the opposite of what the scanner will do. */
const NEGATORS =
  /(?:\bnot\b|n't\b|\bnever\b|\bwithout\b|\brather than\b|\binstead of\b|\bno longer\b|\bavoid\b|\bdoes not\b|\bwon't\b|\bcannot\b)/i;

/**
 * Closing keywords in a body that will fire but almost certainly should not.
 *
 * Returns `[{ line, text, reason }]`. An ordinary `Closes #123` in prose is not reported -- the
 * gate must not obstruct the common case, which is the whole point of the keyword.
 */
export function accidentalClosers(body) {
  const lines = body.split(/\r?\n/);
  const found = [];
  let inFence = false;

  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }

    CLOSING_KEYWORD.lastIndex = 0;
    let m;
    while ((m = CLOSING_KEYWORD.exec(line)) !== null) {
      const before = line.slice(0, m.index);
      let reason = null;

      if (inFence) {
        reason = "inside a fenced code block";
      } else if (/^\s*>/.test(line)) {
        reason = "inside a blockquote";
      } else if (inCodeSpan(line, m.index)) {
        reason = "inside a `code span`";
      } else if (NEGATORS.test(before.slice(-40))) {
        // Only the run-up matters: "This does not close #17" negates, "Closes #17. It does not
        // fix the migration" does not.
        reason = "negated -- the scanner does not read negations";
      }

      if (reason) found.push({ line: i + 1, text: line.trim(), match: m[0], reason });
    }
  });

  return found;
}

/** Whether `index` falls inside an odd number of backticks, i.e. within a code span. */
function inCodeSpan(line, index) {
  const ticks = (line.slice(0, index).match(/`/g) || []).length;
  return ticks % 2 === 1;
}

/** Shorten a quoted line so the block message stays readable. */
function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The issue or PR number a create/edit acted on, or null. */
export function issueNumber(action, args, stdout, kind = "issue") {
  if (action === "create") {
    const m = (kind === "pr" ? PR_URL : ISSUE_URL).exec(stdout ?? "");
    return m ? m[1] : null;
  }

  // `gh <kind> edit <number|url> [flags]` -- the target is positional and comes first.
  for (const a of args) {
    if (a.startsWith("-")) break;
    if (/^\d+$/.test(a)) return a;
    const m = ANY_URL.exec(a);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------- repo config and mode

/** Parse the repo config, tolerating a BOM and CRLF. Returns {config} or {error}. */
export function parseConfig(text) {
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    return { error: `not valid JSON (${e.message})` };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { error: "the top level must be a JSON object" };
  }
  if (data.version !== 1) {
    return { error: `unsupported "version": ${JSON.stringify(data.version)} (expected 1)` };
  }
  const gates = data.gates;
  if (gates !== undefined && (gates === null || typeof gates !== "object" || Array.isArray(gates))) {
    return { error: `"gates" must be an object` };
  }
  const deploy = gates?.deployImpact;
  if (
    deploy !== undefined &&
    (deploy === null ||
      typeof deploy !== "object" ||
      !Array.isArray(deploy.paths) ||
      !deploy.paths.every((p) => typeof p === "string"))
  ) {
    return { error: `"gates.deployImpact.paths" must be an array of strings` };
  }
  return { config: data };
}

/**
 * Find the repo config by walking up from `cwd`, stopping at the first directory that holds
 * `.git` -- the repository root -- so a parent directory's config never leaks into a nested
 * repository. No git process is spawned: this runs on every `gh issue|pr create|edit`.
 *
 * Returns {} outside any repository, {root} in a repository without a config, and
 * {root, path, config} or {root, path, error} when the config exists.
 */
export function loadRepoContext(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      const file = join(dir, ...CONFIG_PATH);
      if (!existsSync(file)) return { root: dir };
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        return { root: dir, path: file, error: "not readable" };
      }
      return { root: dir, path: file, ...parseConfig(text) };
    }
    const parent = dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

/** `owner/name`, lower-cased, from any form gh accepts for --repo; null if it is not one. */
export function normalizeRepo(value) {
  if (typeof value !== "string") return null;
  const parts = value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/").toLowerCase() : null;
}

/** Whether the repo-specific gates apply: a config, and no --repo naming another repo. */
export function isAdopted(context, repoFlag) {
  if (!context?.config) return false;
  if (repoFlag === null || repoFlag === undefined) return true;
  const want = normalizeRepo(context.config.repo);
  return want !== null && normalizeRepo(repoFlag) === want;
}

const OFF = /^(false|0|no|off)$/i;

/** The plugin's user option, as Claude Code exports it to hook processes. */
export function closingOptionOff(env) {
  const v = env?.CLAUDE_PLUGIN_OPTION_CLOSING_KEYWORD_GATE;
  return typeof v === "string" && OFF.test(v.trim());
}

export function closingGateEnabled(env, gates) {
  return !closingOptionOff(env) && gates?.closingKeywords !== false;
}

/** The discard gate's user option, as Claude Code exports it to hook processes. */
export function discardOptionOff(env) {
  const v = env?.CLAUDE_PLUGIN_OPTION_DISCARD_GATE;
  return typeof v === "string" && OFF.test(v.trim());
}

export function discardGateEnabled(env, gates) {
  return !discardOptionOff(env) && gates?.discardChanges !== false;
}

// ---------------------------------------------------------------- checkouts and branches

/**
 * The checkout holding `path`: walk up from it -- from its nearest existing ancestor, for a file
 * not yet created -- to the first directory with a `.git`. That `.git` is a directory, or, in a
 * linked worktree or a submodule, a file reading `gitdir: <path>` (relative to the root).
 *
 * Returns {root, gitDir}; null outside any repository, or when a `.git` file names no gitdir.
 * Reads files only: the branch gate runs on every Edit and Write in every repository.
 */
export function checkoutAt(path) {
  let dir = resolve(path);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  for (;;) {
    const dotgit = join(dir, ".git");
    if (existsSync(dotgit)) {
      try {
        if (statSync(dotgit).isDirectory()) return { root: dir, gitDir: dotgit };
        const m = /^gitdir:[ \t]*(.+?)\s*$/m.exec(readFileSync(dotgit, "utf8"));
        return m ? { root: dir, gitDir: resolve(dir, m[1]) } : null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The branch the git directory's HEAD names; null when detached or unreadable. No spawn. */
export function headBranch(gitDir) {
  try {
    const m = /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(readFileSync(join(gitDir, "HEAD"), "utf8"));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Where a git directory keeps its refs: a linked worktree's `commondir` names it. */
function commonDir(gitDir) {
  try {
    return resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
  } catch {
    return gitDir; // not a linked worktree: the git directory is the common one
  }
}

/**
 * Whether `name` is a local branch, or one `git checkout <name>` would create from origin's, read
 * from files: a loose ref or a `packed-refs` line. No spawn.
 */
export function branchExists(gitDir, name) {
  if (!name || name.startsWith("-") || /(^|\/)\.\.?($|\/)|[\0\\]/.test(name)) return false;
  const common = commonDir(gitDir);
  const refs = [`refs/heads/${name}`, `refs/remotes/origin/${name}`];
  const isFile = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (refs.some((r) => isFile(join(common, ...r.split("/"))))) return true;
  try {
    const packed = readFileSync(join(common, "packed-refs"), "utf8");
    return refs.some((r) => packed.split("\n").some((l) => l.trimEnd().endsWith(` ${r}`)));
  } catch {
    return false;
  }
}

/**
 * The branches that could be the default, read from files: origin/HEAD's target when the
 * repository's refs/remotes/origin/HEAD says, else main and master. A linked worktree keeps its
 * refs in the repository's common directory, which its `commondir` file names. This is the
 * filter that keeps git from running on an edit to a branch that cannot be the default.
 */
export function defaultCandidates(gitDir) {
  try {
    const text = readFileSync(join(commonDir(gitDir), "refs", "remotes", "origin", "HEAD"), "utf8");
    const m = /^ref:\s*refs\/remotes\/origin\/(.+?)\s*$/.exec(text);
    if (m) return [m[1]];
  } catch {
    // no origin/HEAD on disk
  }
  return ["main", "master"];
}

/**
 * The checkout's default branch, from origin/HEAD, as a list: [name], or main and master when
 * origin/HEAD is not set. A linked worktree shares its repository's refs, so this works there too.
 */
// The ask gates run git in a directory the model chose, before the operator approved anything: a
// repository's own config must not make that git run a program of its choosing.
const SAFE_GIT = ["-c", "core.fsmonitor=false"];

export function defaultBranches(git, root) {
  const run = spawnSync(git, [...SAFE_GIT, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
  });
  const out = !run.error && run.status === 0 ? run.stdout.trim() : "";
  const name = out.includes("/") ? out.slice(out.indexOf("/") + 1) : "";
  return name ? [name] : ["main", "master"];
}

/** Whether the branch gate applies to the checkout at `root`: adopted, and not switched off. */
function branchGateOn(root) {
  const context = loadRepoContext(root);
  return Boolean(context.config) && context.config.gates?.defaultBranch !== false;
}

const within = (dir, file) => {
  const r = relative(dir, file);
  return r === "" || (!/^\.\.(?:[\\/]|$)/.test(r) && !isAbsolute(r));
};

// ---------------------------------------------------------------- deploy globs

/**
 * A repo-root-anchored glob: `**` spans directories (`**\/` also matches zero of them), `*`
 * and `?` stay within one path segment, a trailing `/` means everything below. Everything
 * else is literal.
 */
export function globToRegExp(glob) {
  let g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** Which of `files` (repo-relative) match any of `globs`. */
export function deployTriggersIn(files, globs) {
  const res = globs.map(globToRegExp);
  return files.filter((f) => res.some((re) => re.test(f.replace(/\\/g, "/"))));
}

/**
 * The bases to diff a PR branch against, best first. An explicit --base is tried as a
 * remote-tracking branch and then locally; otherwise origin/HEAD's target, else main. An
 * option-like --base yields none: it is never handed to git, and no base means no diff.
 */
export function deployBases(cwd, baseFlag) {
  if (baseFlag) return baseFlag.startsWith("-") ? [] : [`origin/${baseFlag}`, baseFlag];
  const git = resolveExecutable("git");
  if (!git) return ["origin/main", "main"];
  const head = spawnSync(git, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });
  const remote = !head.error && head.status === 0 ? head.stdout.trim() : "";
  return remote ? [remote] : ["origin/main", "main"];
}

// ---------------------------------------------------------------- payload I/O

function readStdin() {
  // `done`, not `resolve` -- that name is taken by node:path's resolve, imported above.
  return new Promise((done) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => done(data));
    process.stdin.on("error", () => done(""));
  });
}

/** Bash tool_response has varied in shape across versions; accept every one seen. */
function stdoutOf(payload) {
  const r = payload?.tool_response;
  if (typeof r === "string") return r;
  if (r && typeof r === "object") {
    return [r.stdout, r.output, r.stderr].filter((s) => typeof s === "string").join("\n");
  }
  return "";
}

function block(lines) {
  process.stderr.write(lines.join("\n") + "\n");
  process.exit(2);
}

/** Exit 0, surfacing a warning to the user when there is one. */
function pass(warning) {
  if (warning) process.stdout.write(`${JSON.stringify({ systemMessage: warning })}\n`);
  process.exit(0);
}

/** Exit 0 asking the human to confirm the tool call; a config warning rides in the same object. */
function ask(reason, warning) {
  const out = {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason },
  };
  if (warning) out.systemMessage = warning;
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

const slash = (p) => p.replace(/\\/g, "/");

// ---------------------------------------------------------------- messages
//
// Deliberately silent on how to switch a gate off: the model reads these, and a gate that
// explains its own off switch invites being switched off. The README documents the switches.

function closingMessage(found) {
  return [
    "BLOCKED: this PR body contains a closing keyword GitHub will act on when you do not intend it to.",
    "",
    ...found.map((a) => `  line ${a.line}: ${a.reason}\n    ${truncate(a.text, 100)}`),
    "",
    "GitHub's scanner is a substring matcher, not a parser. It does not read negations, and it",
    "fires from code spans, fenced blocks and blockquotes exactly as it does from prose: a body",
    'reading "does not close #17" closes #17 when the PR merges.',
    "",
    "There is no way to escape a keyword. Use a form that is not one:",
    "",
    "  Refs #123 -- three of four acceptance criteria; the issue stays open.",
    "  Part of #123",
    "",
    "In examples and documentation, use a placeholder: #NNN.",
    "",
    "See the github-workflow skill, section 7.",
  ];
}

function deployMessage(touched, doc) {
  return [
    "BLOCKED: this PR touches deploy-sensitive paths and its body has no `Deploy impact:` line.",
    "",
    ...touched.slice(0, 10).map((f) => `  ${f}`),
    ...(touched.length > 10 ? [`  ... and ${touched.length - 10} more`] : []),
    "",
    "This repository marks these paths as needing a deploy decision. Whatever this change needs",
    "done outside the code -- an environment variable, a migration, a restart, a one-off script --",
    "no deploy performs it for you, and you are not there when the deploy happens.",
    "",
    "Add a line to the PR body:",
    "",
    "  Deploy impact: none",
    "  Deploy impact: needs PAYMENTS_API_KEY set before this ships",
    "",
    '"none" is a real answer and most changes are none. Write it rather than omitting the line:',
    "an explicit none is a decision, a missing line is a question nobody asked.",
    ...(typeof doc === "string" && doc
      ? [
          "",
          `If it is not none, record what is needed in ${doc} in this same PR. Only the operator`,
          "marks it done -- you cannot verify the server, so you never do.",
        ]
      : []),
  ];
}

function duplicateMessage(missing) {
  return [
    "BLOCKED: this `gh issue create` has no duplicate-search record.",
    "",
    `  missing: ${missing.map((m) => m.replace(":", "")).join(", ")}`,
    "",
    "This repository has adopted the github-workflow protocol, which makes the duplicate check a",
    "gate, not a courtesy. A search that leaves no trace cannot be told apart from one that never",
    "ran, so the record is what makes it checkable -- by you now, and by the next agent who finds",
    "this issue in a search.",
    "",
    "Run the search, then put its result in the body:",
    "",
    `  bash "${slash(FIND_DUPLICATES)}" "<the title you are about to file>"`,
    "",
    "  **Searched:** the queries themselves, re-runnable -- not 'I searched for duplicates'",
    "  **Candidates:** every hit you rejected, with state, resolution: label and one clause why",
    "                  -- or `none`, which is a legitimate result",
    "  **Verdict:** file / do not file / stop and ask",
    "",
    "A closed issue carrying a resolution: label is an adjudicated decision -- surface it and ask,",
    "never refile silently. See the github-workflow skill, references/duplicate-check.md.",
  ];
}

// The ask gates' reasons go to the human, in one line each. Same silence on the off switches.

/** Who is acting: a subagent by its type when the payload carries one, else Claude. */
function whoOf(payload) {
  const type = payload?.agent_type;
  return typeof type === "string" && type ? `a subagent (${type})` : "Claude";
}

const onDefault = (branch) =>
  `this repository's default branch. The workflow keeps every change on its own branch. ` +
  `Approve only if you asked for this change on ${branch}.`;

const editReason = (who, path, branch) =>
  `github-workflow: ${who} wants to edit ${path} on ${branch}, ${onDefault(branch)}`;
const commitReason = (who, sub, branch) =>
  `github-workflow: ${who} wants to run git ${sub} on ${branch}, ${onDefault(branch)}`;
const pushReason = (who, branch) => `github-workflow: ${who} wants to push to ${branch}, ${onDefault(branch)}`;

/** `lost` null: the hook could not tell what would go, so the command alone is shown. */
function discardReason(who, label, where, lost) {
  const head = `github-workflow: ${who} wants to run git ${label}, which discards uncommitted changes`;
  const tail = "They may not be its own. Approve only if you want them gone.";
  if (!lost) return `${head}${where ? ` in ${where}` : ""}, and the hook could not tell which. ${tail}`;
  const more = lost.length > 5 ? ` and ${lost.length - 5} more` : "";
  return `${head} in ${where}: ${lost.slice(0, 5).join(", ")}${more}. ${tail}`;
}

function taxonomyMessage(kind, n, report) {
  const rules =
    kind === "pr"
      ? [
          "A PR carries exactly one type: and at least one area:, matching the issue it",
          "resolves. priority: and severity: belong to the issue, not to the branch that",
          "fixes it. Never GitHub's stock labels -- they shadow the taxonomy.",
        ]
      : [
          "Exactly one type:, one priority: (or status:needs-triage), one severity: on bugs and",
          "security, at least one area:. [SEV-1]/[SEV-2] title prefix if and only if that severity",
          "label is present. Never GitHub's stock labels -- they shadow the taxonomy.",
        ];
  return [
    `BLOCKED: ${kind === "pr" ? "PR" : "issue"} #${n} violates the label taxonomy.`,
    "",
    report.trimEnd(),
    "",
    ...rules,
    "",
    `  gh ${kind} edit ${n} --add-label ... --remove-label ...`,
    "",
    "Never invent a label. See the github-workflow skill, references/labels.md.",
  ];
}

// ---------------------------------------------------------------- the gates

/** Files under a deploy glob on this branch, or [] when git cannot say -- unknown never blocks. */
function deployTouched(cwd, baseFlag, globs) {
  for (const base of deployBases(cwd, baseFlag)) {
    const files = changedFiles(cwd, base);
    if (files !== null) return deployTriggersIn(files, globs);
  }
  return [];
}

/**
 * The gh gates: exit 2 on a block, else return the config warning (or null) for the caller to
 * pass on -- alone, or beside an ask from the git gates.
 */
function preToolUse({ kind, action, args, cwd, context, adopted, gates, sources }) {
  const warning = context.error
    ? `github-workflow: ${slash(context.path)} is not valid (${context.error}) -- repo gates skipped; run /github-workflow:doctor`
    : null;

  const body = resolveBody(args, cwd, sources);
  if (body.skip) return warning;

  // Closing keywords act from PR descriptions (and default-branch commits), never from an
  // issue body, so issues are not checked here. Edits count: an edited body re-triggers it.
  if (kind === "pr" && closingGateEnabled(process.env, gates)) {
    const found = accidentalClosers(body.text);
    if (found.length > 0) block(closingMessage(found));
  }

  if (kind === "pr" && action === "create" && adopted) {
    const deploy = gates.deployImpact;
    const globs = Array.isArray(deploy?.paths) ? deploy.paths : [];
    if (globs.length > 0 && !hasDeployImpact(body.text)) {
      const touched = deployTouched(cwd, argValue(args, ["--base", "-B"]), globs);
      if (touched.length > 0) block(deployMessage(touched, deploy.doc));
    }
  }

  if (kind === "issue" && action === "create" && adopted && gates.duplicateSearch !== false) {
    const missing = missingMarkers(body.text);
    if (missing.length > 0) block(duplicateMessage(missing));
  }

  return warning;
}

// ---------------------------------------------------------------- the ask gates

/** The directory a payload runs in, as main() has always taken it. */
function payloadCwd(payload) {
  return (typeof payload?.cwd === "string" && payload.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * The branch gate on Edit, Write, MultiEdit and NotebookEdit: the ask reason, or null.
 *
 * The checkout is the one holding the file -- never the payload's cwd, which in the incident was a
 * worktree on a feature branch while the edit landed in the main checkout. Until the edit is known
 * to be in an adopted checkout whose HEAD could be the default branch, only files are read; git
 * runs only then, to confirm the default branch and, if it matches, to ask whether git ignores the
 * file (workflow tools keep ignored scratch in the main checkout). Anything unknown passes.
 */
export function editAsk(payload, env = process.env) {
  const input = payload?.tool_input;
  const raw = payload?.tool_name === "NotebookEdit" ? input?.notebook_path : input?.file_path;
  if (typeof raw !== "string" || raw === "") return null;

  // No cygpath: this is the every-edit path, and Claude Code hands these tools native paths.
  const native = nativePath(raw, { env: {} });
  if (native.skip) return null;
  const file = resolve(payloadCwd(payload), native.path);

  const checkout = checkoutAt(dirname(file));
  if (!checkout) return null;
  if (within(checkout.gitDir, file) || within(join(checkout.root, ".git"), file)) return null;
  if (!branchGateOn(checkout.root)) return null;
  const branch = headBranch(checkout.gitDir);
  if (!branch || !defaultCandidates(checkout.gitDir).includes(branch)) return null;

  const git = resolveExecutable("git", env);
  if (!git || !defaultBranches(git, checkout.root).includes(branch)) return null;
  const path = slash(relative(checkout.root, file));
  const ignored = spawnSync(git, [...SAFE_GIT, "check-ignore", "-q", "--", path], { cwd: checkout.root, timeout: 5_000 });
  if (!ignored.error && ignored.status === 0) return null;

  return editReason(whoOf(payload), path, branch);
}

const COMMITS = new Set(["commit", "merge", "cherry-pick", "revert", "am"]);

/**
 * The ask gates on a Bash command: the reason for the first git command that should ask, or null.
 * Every git command in it is judged, in order, each in the directory the shell will run it in.
 */
export function gitAsk(command, cwd, payload = {}, env = process.env) {
  const cmds = gitCommands(command, cwd);
  if (cmds.length === 0) return null;

  // Resolved on first need: `git status` and its like never get that far.
  let resolved;
  const git = () => (resolved === undefined ? (resolved = resolveExecutable("git", env)) : resolved);
  const who = whoOf(payload);
  const defaults = new Map();
  const defaultsOf = (root) => {
    if (!git()) return [];
    if (!defaults.has(root)) defaults.set(root, defaultBranches(git(), root));
    return defaults.get(root);
  };

  // A branch switch earlier in the same command decides where a later commit lands:
  // `git checkout main && git merge feat` merges into main, `git checkout -b fix/x && git commit`
  // commits to fix/x. Tracked per checkout root; null once it cannot be known (--detach, a gh
  // checkout, a commit-ish that is not a branch), which passes.
  const moved = new Map();
  let movedSomewhere = false; // a switch in a directory the hook could not place
  const moveTo = (dir, branch) => {
    const root = dir === null ? null : checkoutAt(dir)?.root;
    if (root) moved.set(root, branch);
    else movedSomewhere = true;
  };
  const branchOf = (checkout) =>
    movedSomewhere ? null : moved.has(checkout.root) ? moved.get(checkout.root) : headBranch(checkout.gitDir);

  for (const g of cmds) {
    if (g.moves) {
      moveTo(g.dir, null);
      continue;
    }
    const form = discardForm(g);
    const reason =
      (form && discardAsk(git, g, form, who, cwd, env)) || branchAsk(g, branchOf, who, defaultsOf);
    if (reason) return reason;
    const target = switchTarget(g, form);
    if (target !== undefined) moveTo(g.dir, target);
  }
  return null;
}

/**
 * The branch a `git checkout` or `git switch` leaves HEAD on: the new branch of -b/-B/-c/-C/--orphan,
 * or the branch it names; null when that is not a known branch (--detach, `-`, a commit-ish, an
 * expansion); undefined when HEAD does not move (a path checkout, no target).
 */
function switchTarget(g, form) {
  if (g.sub !== "checkout" && g.sub !== "switch") return undefined;
  if (g.sub === "checkout" && form?.paths?.length) return undefined;
  const create = g.sub === "checkout" ? "bB" : "cC";
  const positional = [];
  for (let k = 0; k < g.args.length; k++) {
    const a = g.args[k];
    if (a === "--") break;
    if (a === "--detach") return null;
    if (a === "--orphan" || a === "--create" || a === "--force-create") return g.args[k + 1] ?? null;
    if (a.startsWith("--orphan=")) return a.slice("--orphan=".length);
    if (a.startsWith("--")) continue;
    if (a === "-") return null;
    if (a.startsWith("-")) {
      const s = shortFlags(a, create);
      if (!s) continue;
      if (s.flags.has("d") && g.sub === "switch") return null;
      const at = [...a.slice(1)].findIndex((c) => create.includes(c));
      if (at !== -1) return s.next ? (g.args[k + 1] ?? null) : a.slice(at + 2);
      continue;
    }
    positional.push(k);
  }
  if (positional.length === 0) return undefined;
  const k = positional[0];
  if (g.expands?.[k]) return null;
  const gitDir = g.dir === null ? null : checkoutAt(g.dir)?.gitDir;
  return gitDir && branchExists(gitDir, g.args[k]) ? g.args[k] : null;
}

// Flags under which a commit-adding subcommand adds no commit of its own.
const NO_NEW_COMMIT = ["--abort", "--quit", "--skip", "--show-current-patch"];

/** The branch gate on one git command: a commit-adding subcommand on the default branch, or a push to it. */
function branchAsk(g, branchOf, who, defaultsOf) {
  if (g.dir === null || (!COMMITS.has(g.sub) && g.sub !== "push")) return null;
  const quiet = (a) =>
    NO_NEW_COMMIT.includes(a) || (g.sub === "commit" && a === "--dry-run") || (g.sub === "merge" && a === "--ff-only");
  if (g.args.some(quiet)) return null;
  const checkout = checkoutAt(g.dir);
  if (!checkout || !branchGateOn(checkout.root)) return null;
  const branch = branchOf(checkout);
  const candidates = defaultCandidates(checkout.gitDir);

  if (g.sub !== "push") {
    if (!branch || !candidates.includes(branch)) return null;
    return defaultsOf(checkout.root).includes(branch) ? commitReason(who, g.sub, branch) : null;
  }

  const push = pushTargets(g.args);
  const reaches = (b) => b !== null && candidates.includes(b);
  if (!push.all && !push.dests.some(reaches) && !(push.current && reaches(branch))) return null;
  const defaults = defaultsOf(checkout.root);
  if (defaults.length === 0) return null; // no git
  if (push.all) return pushReason(who, branch && defaults.includes(branch) ? branch : defaults[0]);
  const hit = push.dests.find((d) => defaults.includes(d));
  if (hit) return pushReason(who, hit);
  return push.current && defaults.includes(branch) ? pushReason(who, branch) : null;
}

/**
 * The discard gate on one git command already known to be a discarding form. `git` resolves the
 * executable; without one the gate passes, and the self-check reports it.
 */
function discardAsk(git, g, form, who, cwd, env) {
  const context = loadRepoContext(g.dir ?? cwd);
  if (!discardGateEnabled(env, context.config?.gates) || !git()) return null;
  if (g.dir === null) return discardReason(who, form.label, null, null);
  if (form.unknown) return discardReason(who, form.label, placeOf(g.dir), null);
  const loss = lossOf(git(), g.dir, form);
  if (loss === null || (loss.lost && loss.lost.length === 0)) return null;
  return discardReason(who, form.label, loss.where, loss.lost);
}

/** The checkout root holding `dir`, for the message; `dir` itself when there is none. */
const placeOf = (dir) => slash(checkoutAt(dir)?.root ?? dir);

/**
 * What `form` would destroy, asked of git in `dir`: `{ where, lost }`, `lost` null when git ran
 * out of time (the command alone is then shown); or null when git cannot answer at all -- not a
 * repository, a worktree that does not exist -- which passes.
 *
 * User-derived paths go after `--`, always: they come from the command the model wrote, and git
 * must never read one as an option.
 */
function lossOf(git, dir, form) {
  // The directory comes from the command, before anyone approved it: never let a repository's own
  // config run a program (core.fsmonitor) on the hook's behalf.
  const run = (at, args) =>
    spawnSync(git, [...SAFE_GIT, "--no-optional-locks", ...args], { cwd: at, encoding: "utf8", timeout: 5_000 });
  const timedOut = (r) => r.error?.code === "ETIMEDOUT";

  if (form.stash) {
    const r = run(dir, ["stash", "list"]);
    if (timedOut(r)) return { where: placeOf(dir), lost: null };
    if (r.error || r.status !== 0) return null;
    const entries = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    const named = form.ref ? [entries.find((e) => e.startsWith(`${form.ref}:`)) ?? form.ref] : entries.slice(0, 1);
    const lost = entries.length === 0 ? [] : form.label === "stash drop" ? named : entries;
    return { where: placeOf(dir), lost: lost.map((e) => truncate(e, 60)) };
  }

  let at = dir;
  let kinds = form.kinds;
  // Git Bash converts a /c/... argument before git sees it; this git does not, so convert here. A
  // path that cannot be placed leaves the loss unknown, and the command alone is shown.
  const paths = [];
  for (const p of form.paths ?? []) {
    const native = nativePath(p);
    if (native.skip) return { where: placeOf(dir), lost: null };
    paths.push(native.path);
  }
  if (form.worktree !== undefined) {
    const native = nativePath(form.worktree);
    if (native.skip) return { where: null, lost: null };
    at = resolve(dir, native.path);
    kinds = ["tracked", "untracked"];
    paths.length = 0;
  }

  // Tracked-only forms skip the untracked walk; it cannot change their answer.
  const files = kinds.some((k) => k !== "tracked");
  const r = run(at, [
    "status", "--porcelain=v1", `--untracked-files=${files ? "all" : "no"}`,
    ...(kinds.includes("ignored") ? ["--ignored"] : []), "--", ...paths,
  ]);
  const where = form.worktree !== undefined ? slash(at) : placeOf(at);
  if (timedOut(r)) return { where, lost: null };
  if (r.error || r.status !== 0) return null;

  const lost = [];
  for (const line of r.stdout.split("\n")) {
    if (line.trim().length < 4) continue;
    const code = line.slice(0, 2);
    const kind = code === "??" ? "untracked" : code === "!!" ? "ignored" : "tracked";
    if (kind === "tracked" && form.fromIndex && code[1] === " ") continue; // staged only: kept
    if (kinds.includes(kind)) lost.push(line.slice(3).trim());
  }
  return { where, lost };
}

function postToolUse({ kind, action, args, cwd, adopted, gates, payload }) {
  if (!adopted || gates.labelTaxonomy === false) process.exit(0);

  const n = issueNumber(action, args, stdoutOf(payload), kind);
  const bash = resolveExecutable("bash");
  if (!n || !bash || !existsSync(LINTER)) process.exit(0);

  const repo = argValue(args, ["--repo", "-R"]);
  const argv = [slash(LINTER), n, ...(kind === "pr" ? ["--pr"] : []), ...(repo ? ["--repo", repo] : [])];
  const run = spawnSync(bash, argv, { cwd, encoding: "utf8", timeout: 40_000 });

  if (run.error || run.status === null || run.status === 0) process.exit(0);

  // Non-zero alone does not mean "violation". The linter also exits 1 for a missing jq, an
  // unauthenticated gh, a deleted issue, a network failure -- none of them the model's to fix.
  // A real violation always prints a FAIL line on stdout, so that is the discriminator.
  const report = run.stdout ?? "";
  if (!/^\s*FAIL\s/m.test(report)) process.exit(0);

  block(taxonomyMessage(kind, n, report));
}

// ---------------------------------------------------------------- self-check

/**
 * Whether each gate can actually run in `cwd`. The taxonomy gate degrades to a silent pass
 * when a dependency is missing -- correct, but indistinguishable from a clean bill of health,
 * so this is how anyone can tell. `node check-issue-workflow.mjs --self-check [--cwd DIR]`.
 *
 * Known live cause on Windows: a tool installed by winget lands on the persisted user PATH,
 * but a process inherits its environment from whatever launched it, and that parent keeps
 * handing out the pre-install copy across an app restart. Copying the binary into a directory
 * already on PATH fixes it; so does logging out.
 */
export function selfCheck(cwd = process.cwd(), env = process.env, linter = LINTER) {
  // Resolved, not spawned by bare name -- see resolveExecutable. The `command -v` probe below
  // stays a string: bash's own lookup does not search the working directory.
  const bash = resolveExecutable("bash", env);
  const git = resolveExecutable("git", env);
  const bashOk = bash !== null && spawnSync(bash, ["-c", "exit 0"]).error === undefined;
  const has = (c) => bashOk && spawnSync(bash, ["-c", `command -v ${c}`]).status === 0;
  const gitOk = git !== null && spawnSync(git, ["--version"]).error === undefined;

  const context = loadRepoContext(cwd);
  const gates = context.config?.gates ?? {};
  const missing = ["gh", "jq"].filter((c) => !has(c));
  const linterOk = existsSync(linter);
  const globs = Array.isArray(gates.deployImpact?.paths) ? gates.deployImpact.paths : [];

  return [
    { name: "node", ready: true, note: process.version },
    {
      name: "mode",
      ready: !context.error,
      note: context.error
        ? `config malformed: ${context.error} (${slash(context.path)})`
        : context.config
          ? `adopted (${slash(context.path)})`
          : "guest -- no .github/github-workflow.json here",
    },
    {
      name: "closing gate",
      ready: true,
      note: closingOptionOff(env)
        ? "off -- plugin option closing_keyword_gate"
        : gates.closingKeywords === false
          ? "off -- repo config"
          : "on",
    },
    {
      name: "duplicate gate",
      ready: true,
      note: !context.config
        ? "inactive here (guest mode)"
        : gates.duplicateSearch === false
          ? "off -- repo config"
          : "on",
    },
    {
      name: "taxonomy check",
      ready: bashOk && missing.length === 0 && linterOk,
      note: !bashOk
        ? "bash not found"
        : !linterOk
          ? `linter not found: ${slash(linter)}`
          : missing.length
            ? `not on PATH: ${missing.join(", ")} -- copy into a dir already on PATH; an app restart inherits the stale one`
            : !context.config
              ? "ready (inactive here: guest mode)"
              : gates.labelTaxonomy === false
                ? "ready (off -- repo config)"
                : "gh, jq and the linter all reachable",
    },
    {
      name: "deploy gate",
      ready: globs.length === 0 || gitOk,
      note: globs.length === 0
        ? "not configured"
        : gitOk
          ? `on -- ${globs.length} path pattern(s)`
          : "git not found",
    },
    {
      name: "branch gate",
      ready: !context.config || gates.defaultBranch === false || gitOk,
      note: !context.config
        ? "inactive here (guest mode)"
        : gates.defaultBranch === false
          ? "off -- repo config"
          : gitOk
            ? "on"
            : "git not found",
    },
    {
      name: "discard gate",
      ready: !discardGateEnabled(env, gates) || gitOk,
      note: discardOptionOff(env)
        ? "off -- plugin option discard_gate"
        : gates.discardChanges === false
          ? "off -- repo config"
          : gitOk
            ? "on"
            : "git not found",
    },
  ];
}

// ---------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-check")) {
    const rows = selfCheck(argValue(argv, ["--cwd"]) ?? process.cwd());
    for (const r of rows) {
      process.stdout.write(
        `  ${r.name.padEnd(16)}${(r.ready ? "ready" : "NOT RUNNING").padEnd(14)}${r.note}\n`,
      );
    }
    process.exit(rows.every((r) => r.ready) ? 0 : 1);
  }

  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // never break the workflow over a malformed payload
  }

  const event = payload?.hook_event_name;
  if (EDIT_TOOLS.includes(payload?.tool_name)) {
    if (event === "PreToolUse") {
      const reason = quietly(() => editAsk(payload));
      if (reason) ask(reason);
    }
    process.exit(0);
  }
  if (payload?.tool_name !== "Bash") process.exit(0);

  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || (!command.includes("gh") && !command.includes("git"))) process.exit(0);

  const cwd = payloadCwd(payload);
  // Decided first, acted on last: a block from the gh gates below wins over an ask.
  const reason = event === "PreToolUse" && command.includes("git") ? quietly(() => gitAsk(command, cwd, payload)) : null;

  const found = command.includes("gh") ? findGhTarget(command) : null;
  if (!found) {
    if (reason) ask(reason);
    process.exit(0);
  }

  const context = loadRepoContext(cwd);
  const adopted = isAdopted(context, argValue(found.args, ["--repo", "-R"]));
  const gates = adopted ? (context.config.gates ?? {}) : {};
  const state = { ...found, cwd, context, adopted, gates, payload };

  if (event === "PreToolUse") {
    const warning = preToolUse({ ...state, sources: bodySources(command, found) });
    if (reason) ask(reason, warning);
    pass(warning);
  }
  if (event === "PostToolUse") postToolUse(state);
  process.exit(0);
}

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** An ask gate that throws has found something it does not understand: that never stops work. */
function quietly(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

// Only run when executed as a hook. The tests import the parsers above, and without this guard
// that import would block forever on a stdin that never closes. Compare realpaths: argv[1] is
// resolved without following symlinks, but the ESM loader realpaths the entry module, so on a
// path through a symlink (macOS's /tmp and /var, a symlinked ~/.claude, a linked --plugin-dir)
// a plain comparison never matches and every gate silently stays off. `file://${argv[1]}`
// never matches on Windows either.
function invokedAsScript() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) await main();
