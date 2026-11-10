// The `spec` tool on the real spec tools (`sova-spec.mjs`, a child process): a throwaway project's spec,
// its draft, and a folder with none.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { StateView, ToolCtx } from "../shared/harness";
import { NO_SPEC_HERE, specCodingTool } from "./spec-coding-tool";

const root = mkdtempSync(join(tmpdir(), "spec-tool-int-"));
after(() => rmSync(root, { recursive: true, force: true }));

function writeSpec(dir: string, word: string): void {
  mkdirSync(join(dir, "claims/g"), { recursive: true });
  writeFileSync(join(dir, "claims/g/doc.md"), `# §g/doc — Doc\n\nThe doc ${word}.\n\n## §g.doc/part — Part\n\nThe part ${word} the password reset email.\n`);
  const rec = { kind: "behavior", requires: [], code: ["src/a.ts"], authority: "accepted", evidence: "verified" };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ formatVersion: 1, claims: { "§g/doc": { ...rec, kind: "surface" }, "§g.doc/part": rec } }));
}
const project = join(root, "project");
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(join(project, "src/a.ts"), "export const a = 1;\n");
writeSpec(join(project, ".sova/spec"), "sends");
const draft = join(project, ".sova/spec/drafts/d/spec");
cpSync(join(project, ".sova/spec/claims"), join(draft, "claims"), { recursive: true });
writeSpec(draft, "expires");

const ctx = (cwd: string): ToolCtx => ({ sessionId: "s", cwd, leafId: () => null, branch: () => [], state: () => ({ latest: () => null }) as unknown as StateView });
const tool = specCodingTool();
const run = async (cwd: string, params: Parameters<typeof tool.execute>[1]) => ((await tool.execute("t", params, undefined, undefined, ctx(cwd))).content[0] as { text: string }).text;

test("where, map, toc, read and impact answer the spec tools' JSON for the chat's own tree", async () => {
  const where = JSON.parse(await run(project, { op: "where", query: "password reset email" }));
  assert.equal(where.command, "where");
  assert.ok(JSON.stringify(where.lines).includes("§g.doc/part"), "the matching claim is found");
  assert.equal(JSON.parse(await run(project, { op: "map" })).command, "map");
  assert.equal(JSON.parse(await run(project, { op: "toc", id: "§g/doc", dir: "down" })).command, "toc");
  const read = await run(project, { op: "read", id: "§g.doc/part", noFrame: true });
  assert.match(read, /sends the password reset email/);
  assert.equal(JSON.parse(await run(project, { op: "impact", id: "§g.doc/part", near: true })).command, "impact");
});

test("a draft is read by its name", async () => {
  assert.match(await run(project, { op: "read", id: "§g.doc/part", draft: "d" }), /expires the password reset email/);
});

test("a folder with no spec answers plainly", async () => {
  const bare = join(root, "bare");
  mkdirSync(bare);
  assert.equal(await run(bare, { op: "read", id: "§g/doc" }), NO_SPEC_HERE);
  assert.equal(await run(bare, { op: "where", query: "password reset email" }), NO_SPEC_HERE);
  assert.equal(await run(bare, { op: "impact", id: "§g/doc" }), NO_SPEC_HERE);
});
