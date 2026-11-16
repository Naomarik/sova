// The main chat's `lookbook` read of a design's page: the latest unless a version is named, each labelled with which
// version it is and when it was made, several at once, and a clear refusal for a design or version that isn't there.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { DesignRecord } from "../../shared/design";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "design-read-"));
after(() => rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true }));
const { mainDesignTools } = await import("./tools");
const { versionsLine } = await import("./versions");
const store = await import("./store");

const sid = "read-1";
const parent = { sessionId: sid, path: join(process.env.PI_CODING_AGENT_DIR!, "main.jsonl") };
const at = (n: number) => `2026-11-16T10:0${n}:30.000Z`;
const page = (label: string, n: number) => `<!doctype html><p>${label} page ${n}</p>`;
const design = (label: string, versions: number, over: Partial<DesignRecord> = {}): DesignRecord => ({
  label, runId: "r1", direction: "Quiet", model: "zai/a", modelName: "a", parents: [], status: "ready", route: "tool", workerState: "idle", vision: true, createdAt: at(0), updatedAt: at(0),
  versions: Array.from({ length: versions }, (_, i) => ({ n: i + 1, at: at(i + 1), chars: 10, by: "first" as const })), ...over,
});
store.changeDesigns(sid, (s) => {
  // A has three versions; B is writing its second; C has none yet.
  s.designs.push(design("A", 3), design("B", 1, { status: "writing", live: { version: 2, chars: 400 } }), design("C", 0, { status: "writing" }));
});
for (const n of [1, 2, 3]) store.writePage(sid, "A", n, page("A", n));
store.writePage(sid, "B", 1, page("B", 1));

const read = async (label: string): Promise<string> => {
  const tool = mainDesignTools(() => parent, () => "/cwd").find((t) => t.name === "lookbook")!;
  const out = await tool.execute("t", { op: "read", ...(label ? { label } : {}) }, undefined, undefined, undefined as never);
  return (out.content[0] as { text: string }).text;
};

test("a label alone reads the latest version; every read starts by saying which version it is, when it was made, and which exist", async () => {
  assert.equal(await read("A"), `Design A · version 3 of 3 (latest) · made 2026-11-16 10:03 UTC · versions 1–3\n\n${page("A", 3)}`);
  assert.equal(await read("a1"), `Design A · version 1 of 3 · made 2026-11-16 10:01 UTC · versions 1–3\n\n${page("A", 1)}`);
});

test("the overview read lists each design's version count", async () => {
  const out = await read("");
  assert.deepEqual(out.split("\n").filter((l) => /^[A-C] · /.test(l)), ["A · Quiet · zai/a · ready · 3 versions", "B · Quiet · zai/a · writing · 1 version", "C · Quiet · zai/a · writing · no version yet"]);
});

test("the versions that exist read as ranges, with any gap shown", () => {
  const vs = (...n: number[]) => n.map((x) => ({ n: x }));
  for (const [list, line] of [[vs(1), "1"], [vs(1, 2, 3), "1–3"], [vs(1, 2, 4, 5, 7), "1–2, 4–5, 7"], [vs(3, 1, 2), "1–3"]] as const) assert.equal(versionsLine(list), line);
});

test("a design still writing says a newer version is being written, above the page that is finished", async () => {
  assert.equal(await read("B"), `Design B · version 1 of 1 (latest) · made 2026-11-16 10:01 UTC · version 1\nVersion 2 is being written now; this isn't it.\n\n${page("B", 1)}`);
});

test("several pages at once, in the order named, each once", async () => {
  const out = await read("A1, B A1,A3");
  const heads = out.split("\n").filter((l) => l.startsWith("Design "));
  assert.deepEqual(heads.map((h) => h.split(" · ").slice(0, 2).join(" · ")), ["Design A · version 1 of 3", "Design B · version 1 of 1 (latest)", "Design A · version 3 of 3 (latest)"]);
  for (const p of [page("A", 1), page("B", 1), page("A", 3)]) assert.ok(out.includes(p));
});

test("a design or version that isn't there is refused by name, and nothing is read", async () => {
  // Each refusal, and that a good name beside a bad one doesn't get read on its own.
  const cases: [string, RegExp][] = [
    ["Z", /^No design Z in this chat\. Its designs: A, B, C\.$/],
    ["A4", /^Design A has no version 4\. Its versions: 1–3\.$/],
    ["B0", /^Design B has no version 0\. Its versions: 1\.$/],
    ["C", /^Design C has no finished page yet\.$/],
    ["A1, A9", /no version 9/],
    ["A-1", /^No design A-1/],
    [" , ", /names no design/],
  ];
  for (const [label, why] of cases) await assert.rejects(read(label), (e: Error) => why.test(e.message), label);
});
