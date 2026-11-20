import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { clearHandlesForTest, PART_LEAD, PARTS_HEAD, setLookupPlaceForTest, specLookupTools } from "./spec-lookup";
import { scratchRoot } from "./test-scratch";

// A split topic in the look-up (§app.spec-lookup/tool, /outsider-view): the real spec tools on a main line whose
// claim is cut into parts. Every way in reaches each part: find names the best part with a ref of its own, and
// reading or outlining the topic lists its parts as refs, in the outsider view (handles only) and the full view.

let root: string;
const g = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const PARTS = { "§site.gate/rules": "The token and the cross-site rules", "§site.gate/exceptions": "What is never asked for the token" };

before(() => {
  root = scratchRoot("spec-lookup-parts");
  g("init", "-q", "-b", "master");
  const spec = join(root, ".sova", "spec");
  mkdirSync(join(spec, "claims", "site"), { recursive: true });
  writeFileSync(join(spec, "manifest.json"), JSON.stringify({ formatVersion: 1, claims: {
    "§site/gate": { kind: "surface", authority: "accepted", requires: [] },
    "§site.gate/check": { kind: "behavior", authority: "accepted", requires: Object.keys(PARTS) },
    "§site.gate/rules": { kind: "behavior", authority: "accepted", requires: [] },
    "§site.gate/exceptions": { kind: "behavior", authority: "accepted", requires: [] },
  } }));
  writeFileSync(join(spec, "claims", "site", "gate.md"), [
    "# §site/gate — The gate", "", "The gate stands in front of every page.", "",
    "## §site.gate/check — What the gate checks", "", ...Object.entries(PARTS).map(([id, t]) => `- ${id} — ${t}`), "",
    `## §site.gate/rules — ${PARTS["§site.gate/rules"]}`, "", "A visit without the token is turned away, and so is one from another site.", "",
    `## §site.gate/exceptions — ${PARTS["§site.gate/exceptions"]}`, "", "The health page is never asked for the token, and a peer's forwarded address is trusted.", "",
  ].join("\n"));
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "spec");
});
after(() => {
  clearHandlesForTest();
  setLookupPlaceForTest(null);
});

const run = async (t: { execute: Function }, params: Record<string, unknown>) => (await t.execute("c", params, undefined, undefined, { branch: () => [] })).content[0].text as string;
const tools = (view: "outsider" | "full", sessionId: string) => {
  setLookupPlaceForTest(() => ({ root, name: "Shop", names: [] }));
  return specLookupTools({ sessionId, projects: [{ id: "p1", name: "Shop" }], view })[0]!;
};
const refOf = (out: string, title: string) => new RegExp(`(s\\d+) — ${title}`).exec(out)?.[1];

test("outsider: find names the best part with a ref that reads it; reading or outlining the topic gives every part a ref", async () => {
  clearHandlesForTest();
  const t = tools("outsider", "parts-out");
  const found = await run(t, { op: "find", words: "health page forwarded peer" });
  assert.ok(!found.includes("§"), found);
  assert.match(found, new RegExp(`- s\\d+ — What the gate checks.*\\n  ${PART_LEAD} s\\d+ — ${PARTS["§site.gate/exceptions"]}`), found);
  const best = refOf(found, PARTS["§site.gate/exceptions"])!;
  assert.match(await run(t, { op: "read", ref: best }), /The health page is never asked for the token/);
  const topic = refOf(found, "What the gate checks")!;
  const read = await run(t, { op: "read", ref: topic });
  assert.ok(read.includes(PARTS_HEAD) && !read.includes("§"), read);
  for (const title of Object.values(PARTS)) {
    const ref = refOf(read.slice(read.indexOf(PARTS_HEAD)), title);
    assert.ok(ref, `${title} has a ref after the topic's text`);
    assert.ok((await run(t, { op: "read", ref })).length > 0);
  }
  const outline = await run(t, { op: "outline", ref: topic });
  for (const title of Object.values(PARTS)) assert.ok(refOf(outline, title), `outline lists ${title}: ${outline}`);
});

test("full view: find and read name the parts by § id, each readable", async () => {
  clearHandlesForTest();
  const t = tools("full", "parts-full");
  const found = await run(t, { op: "find", words: "health page forwarded peer" });
  assert.match(found, new RegExp(`\\n  ${PART_LEAD} §site\\.gate/exceptions — ${PARTS["§site.gate/exceptions"]}`), found);
  const read = await run(t, { op: "read", ref: "§site.gate/check" });
  for (const id of Object.keys(PARTS)) assert.ok(read.slice(read.indexOf(PARTS_HEAD)).includes(`- ${id} — `), read);
  assert.match(await run(t, { op: "read", ref: "§site.gate/rules" }), /turned away/);
});
