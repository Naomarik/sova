// The main chat's `lookbook` read of a design's page: the latest unless a version is named, each as a header saying which
// version it is and which exist, its size and its saved file's path (never the page), several at once, a path the
// reader's sandbox can open, and a clear refusal for a design or version that isn't there.
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
const { installPageReaderSandbox } = await import("./page-paths");
const { existsSync, readFileSync, statSync } = await import("node:fs");
const store = await import("./store");

const sid = "read-1";
const parent = { sessionId: sid, path: join(process.env.PI_CODING_AGENT_DIR!, "main.jsonl") };
const at = (n: number) => `2026-11-16T10:0${n}:30.000Z`;
// Pages no header could hold by chance, of a known size: 3 lines.
const page = (label: string, n: number) => `<!doctype html>\n<p>${label} page ${n} PAGE-BODY-MARK</p>\n</html>`;
const size = (label: string, n: number) => `Size: ${(page(label, n).length / 1024).toFixed(1)} KB · ${page(label, n).length} characters, 3 lines.`;
const file = (label: string, n: number) => store.pageFile(sid, label, n);
const TAIL = "\n\nThe page isn't in this reply: read the file, in parts with offset and limit, or grep it for what you need.";
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

const read = async (label: string, ctx?: unknown): Promise<string> => {
  const tool = mainDesignTools(() => parent, () => "/cwd").find((t) => t.name === "lookbook")!;
  const out = await tool.execute("t", { op: "read", ...(label ? { label } : {}) }, undefined, undefined, ctx as never);
  return (out.content[0] as { text: string }).text;
};

test("a label alone reads the latest version; every read starts by saying which version it is, when it was made, and which exist", async () => {
  assert.equal(await read("A"), `Design A · version 3 of 3 (latest) · made 2026-11-16 10:03 UTC · versions 1–3\n${size("A", 3)}\nFile: ${file("A", 3)}${TAIL}`);
  assert.equal(await read("a1"), `Design A · version 1 of 3 · made 2026-11-16 10:01 UTC · versions 1–3\n${size("A", 1)}\nFile: ${file("A", 1)}${TAIL}`);
  // The path is the version's own saved file: what it holds is that version's page.
  assert.equal(readFileSync(file("A", 1), "utf8"), page("A", 1));
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
  assert.equal(await read("B"), `Design B · version 1 of 1 (latest) · made 2026-11-16 10:01 UTC · version 1\nVersion 2 is being written now; this isn't it.\n${size("B", 1)}\nFile: ${file("B", 1)}${TAIL}`);
});

test("several pages at once, in the order named, each once", async () => {
  const out = await read("A1, B A1,A3");
  const heads = out.split("\n").filter((l) => l.startsWith("Design "));
  assert.deepEqual(heads.map((h) => h.split(" · ").slice(0, 2).join(" · ")), ["Design A · version 1 of 3", "Design B · version 1 of 1 (latest)", "Design A · version 3 of 3 (latest)"]);
  assert.deepEqual(out.split("\n").filter((l) => l.startsWith("File: ")), [`File: ${file("A", 1)}`, `File: ${file("B", 1)}`, `File: ${file("A", 3)}`]);
  assert.ok(!out.includes("PAGE-BODY-MARK"), "never the page itself");
});

test("a reader whose sandbox can see the design folder gets the file; one whose sandbox hides it gets a read-only copy where it can read, never the page", async () => {
  const ctx = { sessionId: "main-chat", cwd: "/cwd", branch: () => [] };
  const setPageReaderSandboxForTest = (box: (() => unknown) | null) => installPageReaderSandbox(box ? async () => box() as never : null);
  const tmpDir = join(process.env.PI_CODING_AGENT_DIR!, "session-tmp");
  const policy = (hidden: string[]) => ({ on: true, policy: { hidden, tmpDir } }) as never;
  setPageReaderSandboxForTest(() => ({ on: false }));
  assert.ok((await read("A2", ctx)).includes(`File: ${file("A", 2)}\n`), "sandbox off");
  setPageReaderSandboxForTest(() => policy([join(process.env.PI_CODING_AGENT_DIR!, "auth.json")]));
  assert.ok((await read("A2", ctx)).includes(`File: ${file("A", 2)}\n`), "on, the default policy: the folder is visible");
  setPageReaderSandboxForTest(() => policy([process.env.PI_CODING_AGENT_DIR!]));
  const out = await read("A2", ctx);
  const shown = /File: (\S+) \(a read-only copy where your sandbox can read it\)/.exec(out)?.[1];
  const copy = join(tmpDir, "lookbook", sid, "A", "v2.html");
  assert.equal(shown, process.platform === "linux" ? join("/tmp", "lookbook", sid, "A", "v2.html") : copy, "the path its tools see");
  assert.equal(readFileSync(copy, "utf8"), page("A", 2));
  assert.equal(statSync(copy).mode & 0o777, 0o400);
  assert.ok(!out.includes("PAGE-BODY-MARK"));
  assert.ok(existsSync(file("A", 2)), "the saved file stays where it is");
  setPageReaderSandboxForTest(null);
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
