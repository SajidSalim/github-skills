/**
 * The plugin was extracted from a private repository, and nothing naming it may ship: its owner,
 * its name, its board, its domain terms. Listing those words in a test would ship them too, so
 * this file holds only their SHA-256 hashes, and a failure names the file and line, never the word.
 *
 * Every line is lower-cased and split into `[a-z0-9_]+` tokens; each token, and each pair of
 * adjacent tokens joined by one space, is hashed and looked up. The targets are the scrub test's:
 * everything under the plugin except eval results, plus the marketplace README and manifest.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** SHA-256 (hex) of the seven source-repository terms, lower-cased. */
const PRIVATE = new Set([
  "1a98961c5610987ca3ea2a8db661d27cfb244e5a256d1647112dd28ac4652b96",
  "f35d57cc6b4c6da982684fd666eed9bf2e4c63977bf8debcfc836b9c3f5f3621",
  "841080b2609e5ee0a2cae5ff35cb5ce59496a325f3ffde33fdcb263cb41be502",
  "d0d891c255ad58e3045421a3f075b2faf874645f494f31e2d6366d06d628ef6f",
  "6ead93d0e40f610a4d77390c6aea91e5189ca176b656282d7c8f3dd20ca04234",
  "8c7eedef31312584ad10409822532a5b7185fe08e2378034be70a018b94847d8",
  "5ffac5b10729f4feba10a0463f5634d29b161e8b9b905a55cbe2e97d06e371c3",
]);

export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * The words and adjacent word pairs of one line, lower-cased. A regex or string escape glues its
 * letter to the word after it -- `\bword\b`, `\nword` -- so the line is also read with `\b`,
 * `\n`, `\r` and `\t` taken out.
 */
export function wordsOf(line) {
  const lower = line.toLowerCase();
  const words = new Set();
  for (const text of [lower, lower.replace(/\\[bnrt]/g, " ")]) {
    const tokens = text.match(/[a-z0-9_]+/g) ?? [];
    tokens.forEach((t, i) => {
      words.add(t);
      if (i > 0) words.add(`${tokens[i - 1]} ${t}`);
    });
  }
  return [...words];
}

/** `file:line` for every line of `files` holding a word or word pair whose hash is in `hashes`. */
export function scan(files, hashes) {
  const hits = [];
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (wordsOf(line).some((w) => hashes.has(sha256(w)))) hits.push(`${file}:${i + 1}`);
      });
  }
  return hits;
}

/** Every file under `dir`, skipping eval results (generated, git-ignored transcripts). */
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (relative(PLUGIN_ROOT, p).replace(/\\/g, "/") === "evals/results") continue;
      out.push(...walk(p));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function targets() {
  const extra = [join(REPO_ROOT, "README.md"), join(REPO_ROOT, ".claude-plugin", "marketplace.json")];
  return [...walk(PLUGIN_ROOT), ...extra.filter((f) => existsSync(f))].sort();
}

test("no identifier from the source repository ships", () => {
  const files = targets();
  assert.ok(files.length > 50, `the walk found only ${files.length} files`);
  const hits = scan(files, PRIVATE).map((h) => relative(REPO_ROOT, h).replace(/\\/g, "/"));
  assert.deepEqual(hits, [], `source-repository terms found at:\n  ${hits.join("\n  ")}`);
});

// Positive control: the same scan, seeded with the hash of a made-up word, must find it -- as
// one token and as a two-word pair, in any case -- or a scan that matches nothing would pass.
test("the scan finds a planted word and a planted word pair", () => {
  const dir = mkdtempSync(join(tmpdir(), "ghwf privacy-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const word = ["zq", "canary", "term"].join("_");
  const file = join(dir, "planted.md");
  writeFileSync(
    file,
    `clean line\nsee ${word.toUpperCase()} here\nclean\nthe Zq  Canary-board\nre='\\b${word}\\b|x'\n`,
  );

  assert.deepEqual(scan([file], new Set([sha256(word)])), [`${file}:2`, `${file}:5`]);
  assert.deepEqual(scan([file], new Set([sha256("zq canary")])), [`${file}:4`]);
  assert.deepEqual(scan([file], new Set([sha256("zq canary term x")])), []);
});
