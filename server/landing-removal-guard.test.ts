// Run: pnpm test -- server/landing-removal-guard.test.ts
// Branches land one way: Sova's merge queue, on the user's Land or their "land it" typed in the branch's own
// chat (AGENTS.md, Landing). The old ways are gone: the Landing card in a branch's chat, the Merge Captain's
// rows card and its Land All, Not Yet / Not Now for landing, Go on an Overseer card's Ready to land row
// (sova_land), the captain's merge round (its playbook, round.mjs, its profile and the merge-ready trigger) and
// the files they kept (landing-queue.json, landing-shown.json). This guard fails when any tracked file names
// one of them again, outside the history (changelogs, the spec tools' story) and the product spec, whose
// drafts carry their own removal. Each hit names the file, line and phrase.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO = join(import.meta.dirname, "..");
const SELF = "server/landing-removal-guard.test.ts";

/** Gone everywhere, tests included: nothing may still show, name or exercise them. */
const GONE: readonly [string, RegExp][] = [
  ["the Landing card", /\bLanding cards?\b/],
  ["Land All", /\bLand All\b/],
  ["Overseer Go on a Ready to land row", /\bOverseer Go\b|\bGo on (?:a|an Overseer card's) Ready to land row/],
  ["sova_land", /\bsova_land\b/],
  ["the captain's landing queue file", /\blanding-queue\.json\b/],
  ["the captain's shown-cards file", /\blanding-shown\.json\b/],
  ["Merge Without Specs", /\bMerge Without Specs\b/],
  ["the captain landing branches", /\b(?:merge captain|Merge Captain|captain) lands\b/],
  ["the merge round's playbook", /\.sova\/playbooks\/merge-round\b/],
];

/** Gone from what ships and what agents read (source, prompts, docs, playbooks); a test may still use the old
    words as a neutral fixture name or to assert they are refused. */
const GONE_FROM_SOURCE: readonly [string, RegExp][] = [
  ["the Merge Captain", /\bmerge[ -]captain\b/i],
  // The private-names file keeps its old name (`<state root>/merge-round.json`): a line naming that file is about the file.
  ["the merge round", /^(?!.*merge-round\.json).*\bmerge[ -]round\b/i],
  ["the merge-ready trigger", /\bmerge-ready\b/],
  ["Land It", /\bLand It\b/],
  ["round.mjs", /\bround\.mjs\b/],
];

/** History and the product spec: they tell what was, or change only through drafts. */
const EXEMPT = [/(^|\/)CHANGELOG\.md$/, /(^|\/)EVOLUTION\.md$/, /^\.sova\/spec\//, /^pi-config\/extensions\/spec\/tests\/search\//, /^pi-config\/docs\//];
const isTest = (f: string) => /\.test\.(?:[cm]?[jt]sx?)$/.test(f) || /\/tests?\//.test(f) || /(^|\/)fixtures?\//.test(f) || /\.snapshot\.json$/.test(f) || /\/golden\//.test(f);
const TEXT = /\.(?:[cm]?[jt]sx?|md|mdx|json|css|html|ya?ml|sh|toml|txt|cljc?|cljs|edn)$/;

function tracked(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
  return out.split("\0").filter((f) => f && TEXT.test(f) && f !== SELF && !EXEMPT.some((r) => r.test(f)));
}

/** Every hit of the rules in `text`, as "file:line: phrase". */
export function hits(file: string, text: string): string[] {
  const rules = isTest(file) ? GONE : [...GONE, ...GONE_FROM_SOURCE];
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const [name, re] of rules) if (re.test(line)) out.push(`${file}:${i + 1}: ${name}`);
  });
  return out;
}

test("the scan reads the repository (it cannot pass by reading nothing)", () => {
  const files = tracked();
  assert.ok(files.length > 1000, `${files.length} files`);
  for (const f of ["AGENTS.md", "server/session-offers.ts", "server/overseer-prompt.md", "pi-config/extensions/worktrees/index.ts", ".sova/offers.json"]) assert.ok(files.includes(f), `${f} is scanned`);
});

test("each rule catches its phrase, in source and, for the gone-everywhere ones, in tests too", () => {
  for (const line of ["Press Land It on the Landing card.", "Land All", "Overseer Go", "Go on a Ready to land row", "call sova_land", "landing-queue.json", "landing-shown.json", "Merge Without Specs…", "the merge captain lands it", ".sova/playbooks/merge-round/PLAYBOOK.md"])
    assert.ok(hits("server/x.ts", line).length > 0, line);
  for (const line of ["the Merge Captain", "merge-captain", "the merge round", "when: merge-ready", "Land It", "round.mjs"]) {
    assert.ok(hits("server/x.ts", line).length > 0, `source: ${line}`);
    assert.ok(hits("site/src/content/docs/x.md", line).length > 0, `docs: ${line}`);
  }
  assert.deepEqual(hits("server/x.test.ts", 'profile: "merge-captain"'), [], "a test may keep a neutral fixture name");
  assert.ok(hits("server/x.test.ts", "the Landing card").length > 0, "never the gone ones, even in a test");
  // Today's words pass.
  assert.deepEqual(hits("server/x.ts", "Sova's own project keeps <state root>/merge-round.json"), [], "the names file keeps its name");
  for (const line of ['Press Land, or type "land it" in this chat.', "the merge queue lands it", "Landing specs · docs don't fit", "Ready to land", "Not Now"])
    assert.deepEqual(hits("server/x.ts", line), [], line);
});

test("no tracked file names a removed landing path", () => {
  const found: string[] = [];
  for (const f of tracked()) {
    let text: string;
    try {
      text = readFileSync(join(REPO, f), "utf8");
    } catch {
      continue; // listed but not on disk (a deletion not yet staged)
    }
    found.push(...hits(f, text));
  }
  assert.deepEqual(found, [], `Landing goes through the merge queue only; these name a removed way:\n${found.join("\n")}`);
});
