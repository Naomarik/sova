// Run: pnpm test -- shared/playbook-delivery.test.ts
// The playbook inside every fire (§chat.schedules/delivery): what a session holds, folded from its own
// branch; full, then unchanged, then a diff; over a third changed goes whole; a compaction resets;
// files read and then edited are listed until read again, never-read files never; a plain read counts
// only from the bytes it returned; the block parses back.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import type { HEntry } from "./harness-history";
import { changedReads, decideLoad, foldHeld, parseBlockTags, PLAYBOOK_NOTE, PLAYBOOK_READ_TOOL, renderBlock, type BundleRef } from "./playbook-delivery";
import { parseWakeNudge } from "./wake";

const hash = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
const B: BundleRef = { id: "merge-round", dir: "/p/.sova/playbooks/merge-round", entry: "PLAYBOOK.md" };
let k = 0;
const base = () => ({ id: `e${++k}`, parentId: null });
const user = (text: string): HEntry => ({ ...base(), kind: "user", blocks: [{ type: "text", text }] });
const call = (id: string, name: string, args: unknown): HEntry => ({ ...base(), kind: "assistant", blocks: [{ type: "toolCall", id, name, arguments: args }] });
const result = (callId: string, tool: string, text: string, details?: unknown, isError = false): HEntry => ({ ...base(), kind: "tool-result", callId, tool, blocks: [{ type: "text", text }], details, isError });
const compaction = (): HEntry => ({ ...base(), kind: "compaction" });

/** A world of files and kept versions, and the fold over it. */
function world(files: Record<string, string>) {
  const kept = new Set<string>(Object.values(files).map(hash));
  const currentSha = (f: string) => (f in files ? hash(files[f]!) : null);
  const fold = (branch: HEntry[]) => foldHeld(branch, B, { hash, knownVersion: (s) => kept.has(s), resolve: (p) => (p.startsWith("/") ? p : `/p/${p}`), currentSha });
  return { files, kept, currentSha, fold };
}
const fire = (sha: string, load = "full") => user(`[schedule s1] Scheduled run fired (merge-ready, playbook merge-round).\nReason: x\n${renderBlock(B, sha, { load: load as "full", body: "…" }, [])}`);

describe("the entry: full, unchanged, a change", () => {
  const v1 = `# Merge round\n\n${Array.from({ length: 30 }, (_, i) => `line ${String.fromCharCode(97 + (i % 26))}${i} of the round, long enough to matter`).join("\n")}\n`;
  const v2 = v1.replace("line c2 ", "line C2 ");
  test("a session that never had it gets it whole; one that holds this version, unchanged", () => {
    const w = world({ "PLAYBOOK.md": v1 });
    assert.equal(decideLoad(w.fold([]).entry, { sha: hash(v1), text: v1 }, null, false).load, "full");
    const held = w.fold([fire(hash(v1))]);
    assert.equal(held.entry, hash(v1));
    const d = decideLoad(held.entry, { sha: hash(v1), text: v1 }, v1, false);
    assert.deepEqual([d.load, d.base, d.body], ["unchanged", hash(v1), "Unchanged since you last loaded it."]);
  });
  test("a small edit goes as a unified diff against the version the session holds", () => {
    const d = decideLoad(hash(v1), { sha: hash(v2), text: v2 }, v1, false);
    assert.equal(d.load, "diff");
    assert.equal(d.base, hash(v1));
    assert.match(d.body, /^Changed since you last loaded version [0-9a-f]{16}:\n@@ -3,5 \+3,5 @@\n/);
    assert.ok(d.body.includes("\n-line c2 of the round, long enough to matter\n+line C2 of the round, long enough to matter\n"), d.body);
    assert.ok(d.body.length < v2.length, "smaller than the file");
  });
  test("more than a third of the lines changed, the old text gone, or memory replacing history: whole", () => {
    const v3 = v1.split("\n").map((l, i) => (i % 2 ? `${l} (rewritten)` : l)).join("\n");
    assert.equal(decideLoad(hash(v1), { sha: hash(v3), text: v3 }, v1, false).load, "full");
    assert.equal(decideLoad(hash(v1), { sha: hash(v2), text: v2 }, null, false).load, "full");
    assert.equal(decideLoad(hash(v1), { sha: hash(v1), text: v1 }, v1, true).load, "full");
  });
  test("a compaction resets what the session holds; the re-prime note after it counts as a whole load", () => {
    const w = world({ "PLAYBOOK.md": v1 });
    assert.equal(w.fold([fire(hash(v1)), compaction()]).entry, undefined);
    const note: HEntry = { ...base(), kind: "note", noteType: PLAYBOOK_NOTE, content: "…", display: true, details: { v: 1, playbook: "merge-round", sha: hash(v1), load: "full" }, inMessage: true };
    assert.equal(w.fold([fire(hash(v2)), compaction(), note]).entry, hash(v1));
  });
  test("another playbook's block is not this one's", () => {
    const other = user(renderBlock({ ...B, id: "other" }, "aaaaaaaaaaaaaaaa", { load: "full", body: "x" }, []));
    assert.equal(world({}).fold([other]).entry, undefined);
  });
});

describe("detail files read, then changed", () => {
  const land1 = "land v1\n";
  const land2 = "land v2\n";
  test("a file read through playbook_read and edited since is listed, until it is read again", () => {
    const w = world({ "PLAYBOOK.md": "e", "references/land.md": land2, "references/check.md": "c" });
    const read = (id: string, sha: string) => [call(id, PLAYBOOK_READ_TOOL, { file: "references/land.md" }), result(id, PLAYBOOK_READ_TOOL, "…", { v: 1, playbook: "merge-round", file: "references/land.md", sha })];
    const once = w.fold([...read("c1", hash(land1))]);
    assert.deepEqual(changedReads(once, "PLAYBOOK.md", w.currentSha), [{ file: "references/land.md", removed: false }], "check.md was never read: never listed");
    const again = w.fold([...read("c1", hash(land1)), ...read("c2", hash(land2))]);
    assert.deepEqual(changedReads(again, "PLAYBOOK.md", w.currentSha), []);
  });
  test("a file read and then removed is listed as removed; after a compaction nothing counts as read", () => {
    const w = world({ "PLAYBOOK.md": "e" });
    const branch = [call("c1", PLAYBOOK_READ_TOOL, {}), result("c1", PLAYBOOK_READ_TOOL, "…", { v: 1, playbook: "merge-round", file: "references/old.md", sha: hash("old") })];
    assert.deepEqual(changedReads(w.fold(branch), "PLAYBOOK.md", w.currentSha), [{ file: "references/old.md", removed: true }]);
    assert.deepEqual(changedReads(w.fold([...branch, compaction()]), "PLAYBOOK.md", w.currentSha), []);
  });
  test("a failed playbook_read changes nothing", () => {
    const w = world({ "references/land.md": land2 });
    const held = w.fold([call("c1", PLAYBOOK_READ_TOOL, {}), result("c1", PLAYBOOK_READ_TOOL, "nope", { v: 1, playbook: "merge-round", file: "references/land.md", sha: hash(land1) }, true)]);
    assert.deepEqual(held.reads, {});
  });
});

describe("a plain read counts only from the bytes it returned", () => {
  const w = world({ "references/land.md": "land now\n" });
  const plain = (args: unknown, text: string) => [call("r1", "read", args), result("r1", "read", text)];
  test("the whole file as it is now, by absolute or relative path: a read of this version", () => {
    assert.deepEqual(w.fold(plain({ path: `${B.dir}/references/land.md` }, "land now\n")).reads, { "references/land.md": hash("land now\n") });
    assert.deepEqual(w.fold(plain({ path: ".sova/playbooks/merge-round/references/land.md" }, "land now\n")).reads, { "references/land.md": hash("land now\n") });
  });
  test("a whole older version Sova kept: a read of that version, so the file is listed as changed", () => {
    w.kept.add(hash("land before\n"));
    const held = w.fold(plain({ path: `${B.dir}/references/land.md` }, "land before\n"));
    assert.deepEqual(changedReads(held, "PLAYBOOK.md", w.currentSha), [{ file: "references/land.md", removed: false }]);
  });
  test("a partial, clipped or ranged read, or a file outside the folder, is no read at all", () => {
    assert.deepEqual(w.fold(plain({ path: `${B.dir}/references/land.md` }, "land")).reads, {});
    assert.deepEqual(w.fold(plain({ path: `${B.dir}/references/land.md`, offset: 1 }, "land now\n")).reads, {});
    assert.deepEqual(w.fold(plain({ path: `${B.dir}/../other/land.md` }, "land now\n")).reads, {});
    assert.deepEqual(w.fold(plain({ path: "/elsewhere/land.md" }, "land now\n")).reads, {});
  });
});

describe("the block", () => {
  test("renders and parses back; a diff or unchanged names how to get the base, and the changed files", () => {
    const text = renderBlock(B, "0123456789abcdef", { load: "diff", base: "fedcba9876543210", body: "Changed since…" }, [{ file: "references/land.md", removed: false }, { file: "references/old.md", removed: true }]);
    assert.deepEqual(parseBlockTags(`head\n${text}`), [{ id: "merge-round", dir: B.dir, entry: "PLAYBOOK.md", sha: "0123456789abcdef", load: "diff", base: "fedcba9876543210" }]);
    assert.ok(text.includes(`If you no longer have version fedcba9876543210, call ${PLAYBOOK_READ_TOOL} with file "PLAYBOOK.md".`));
    assert.ok(text.includes("Changed since you read it: references/land.md, references/old.md (removed). Call playbook_read to read them again."));
    assert.ok(text.endsWith("</playbook>"));
  });
  test("the wake card reads the load from the fire's message, and its reason still from the two lines after the tag", () => {
    const info = parseWakeNudge(`[schedule s1] Scheduled run fired (every 6h, automation merge-round).\nReason: Run this playbook\nRun the playbook "Merge round": its entry is in the playbook block below.\n${renderBlock(B, "0123456789abcdef", { load: "unchanged", base: "0123456789abcdef", body: "Unchanged since you last loaded it." }, [])}`);
    assert.deepEqual(info, { id: "s1", schedule: true, reason: "Run this playbook", playbook: { id: "merge-round", load: "unchanged" } });
  });
});
