// Phase 3 of transcript cards: extension card types and drawing kinds (§app.extensions/views) and a
// project's own drawing kinds (§chat.transcript-cards/drawing-kinds), on the server. The manifest,
// the extension's dist and the project's folders are real files in a throwaway dir; summaries are
// stubbed through setCardDeps as in transcript-cards.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";
import { parseVis } from "../src/vis/parse";
import { KIND_WORDS } from "../src/vis/registry";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-drawings-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.SOVA_EXTENSIONS_FILE = join(root, "extensions.json");
after(() => rmSync(root, { recursive: true, force: true }));

const cards = await import("./transcript-cards");
const { validateExtension } = await import("./extensions");
const { ownAwareParse } = await import("./vis-check");
const { VIS_OWN_KINDS_HOOK } = await import("../pi-config/extensions/mode/minor.ts");

const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const project = join(root, "project");
const dist = join(root, "notes-dist");
put(join(project, ".sova/drawings/gantt/kind.json"), JSON.stringify({ version: 1, toolkit: 1, accepts: "data", data: { type: "object", properties: { tasks: { type: "array", items: { type: "string" } } }, required: ["tasks"] }, height: 200 }));
put(join(project, ".sova/drawings/gantt/view.tsx"), "export {};");
put(join(project, ".sova/drawings/gantt/GUIDE.md"), "Write {\"tasks\": [...]}.");
put(join(project, ".sova/drawings/noguide/kind.json"), JSON.stringify({ version: 1, toolkit: 1, accepts: "text" }));
put(join(project, ".sova/drawings/noguide/view.tsx"), "export {};");
put(join(project, ".sova/drawings/extra/kind.json"), JSON.stringify({ version: 1, toolkit: 1, accepts: "text", colour: "red" }));
put(join(dist, "index.html"), "<p>notes</p>");
put(join(dist, "cards/review.js"), "export {};");
put(join(dist, "drawings/mindmap.js"), "export {};");
put(join(dist, "drawings/mindmap.md"), "One idea per line.");

const notes = {
  id: "notes",
  title: "Notes",
  dist,
  api: "http://127.0.0.1:4840",
  cards: [
    { name: "review", title: "Review", when: "When a note needs review.", draws: "view", view: "cards/review.js", toolkit: 1, answer: "at-once", data: { type: "object" } },
    { name: "ok", title: "OK?", draws: "buttons", answer: "at-once", toolkit: 1 },
    { name: "Bad", title: "x", draws: "table", toolkit: 1 },
    { name: "out", title: "x", draws: "view", view: "../escape.js", toolkit: 1, data: { type: "object" } },
    { name: "missing", title: "x", draws: "view", view: "cards/nope.js", toolkit: 1, data: { type: "object" } },
  ],
  drawings: [
    { name: "mindmap", accepts: "text", view: "drawings/mindmap.js", guide: "drawings/mindmap.md", toolkit: 1 },
    { name: "noguide", accepts: "text", view: "drawings/mindmap.js", guide: "drawings/none.md", toolkit: 1 },
    { name: "flow", accepts: "text", view: "drawings/mindmap.js", guide: "drawings/mindmap.md", toolkit: 1, colour: 1 },
  ],
};
const manifest = (extensions: unknown[]) => writeFileSync(process.env.SOVA_EXTENSIONS_FILE!, JSON.stringify({ version: 1, extensions }));

let n = 0;
const fresh = () => {
  const id = `01b00000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  return { id, path: join(root, "sessions", `x_${id}.jsonl`) };
};

beforeEach(() => {
  manifest([notes]);
  cards.resetCardsForTest();
  cards.setCardDeps({
    async summary(path) {
      const id = /x_(.+)\.jsonl$/.exec(path)?.[1] ?? "nope";
      return { id, path, cwd: project, title: `Session ${id}` } as SessionSummary;
    },
    async head(path) {
      const id = /x_(.+)\.jsonl$/.exec(path)?.[1];
      return id ? { id, cwd: project } : null;
    },
    async lastEntry() {
      return "e1";
    },
    async request() {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
});

describe("an extension's cards and drawings in its offers (§app.extensions/views)", () => {
  test("each declaration is checked on its own: a bad one is left out, never the entry or the others", () => {
    const v = validateExtension(notes);
    assert.ok("entry" in v);
    const offers = (v as { offers?: { cards?: { type: string }[]; drawings?: { kind: string; view: string; guide: string }[] } }).offers;
    assert.deepEqual(offers?.cards?.map((c) => c.type), ["notes.review", "notes.ok"]);
    assert.deepEqual(offers?.drawings?.map((d) => [d.kind, d.view, d.guide]), [["notes.mindmap", "drawings/mindmap.js", "drawings/mindmap.md"]]);
  });

  test("a view or guide that links outside dist is left out", () => {
    put(join(root, "secret.js"), "export {};");
    symlinkSync(join(root, "secret.js"), join(dist, "cards/link.js"));
    const v = validateExtension({ ...notes, cards: [{ name: "link", title: "x", draws: "view", view: "cards/link.js", toolkit: 1, data: { type: "object" } }], drawings: undefined });
    assert.equal((v as { offers?: unknown }).offers, undefined);
  });

  test("an entry with neither has no offers, as before v1.17; an id of project declares none", () => {
    const { cards: _c, drawings: _d, ...plain } = notes;
    assert.equal((validateExtension(plain) as { offers?: unknown }).offers, undefined);
    assert.equal((validateExtension({ ...notes, id: "project" }) as { offers?: unknown }).offers, undefined);
    assert.equal((validateExtension({ ...notes, id: "Project" }) as { offers?: unknown }).offers, undefined);
  });
});

describe("a project's drawing folders (§chat.transcript-cards/drawing-kinds)", () => {
  test("each folder is its kind or what is wrong, listed on the project page", async () => {
    const folders = cards.readDrawingFolders(project);
    const by = Object.fromEntries(folders.map((f) => [f.name, f.ok ? f.decl.kind : f.error]));
    assert.equal(by.gantt, "project.gantt");
    assert.match(String(by.noguide), /GUIDE\.md is missing/);
    assert.match(String(by.extra), /"colour" is not a key/);
    const page = await cards.projectCards(project);
    assert.deepEqual(page.drawings?.map((d) => [d.name, d.ok]), [["extra", false], ["gantt", true], ["noguide", false]]);
  });
});

describe("the snapshot takes the project's and the installed extensions' (§chat.transcript-cards/files)", () => {
  test("types and kinds with their guides, fixed per chat: a later manifest edit changes nothing", async () => {
    const s = fresh();
    const snap = await cards.cardSnapshotFor(s.id, s.path, project);
    assert.deepEqual(snap?.types.map((t) => t.type), ["notes.review", "notes.ok"]);
    assert.deepEqual(snap?.drawings?.map((d) => d.kind), ["project.gantt", "notes.mindmap"]);
    assert.equal(snap?.drawings?.find((d) => d.kind === "notes.mindmap")?.guide, "One idea per line.");
    assert.deepEqual(snap?.drawings?.find((d) => d.kind === "notes.mindmap")?.ext, { id: "notes", title: "Notes", view: "drawings/mindmap.js" });
    manifest([]);
    put(join(dist, "drawings/mindmap.md"), "Changed.");
    cards.resetCardsForTest();
    const again = await cards.cardSnapshotFor(s.id, s.path, project);
    assert.equal(again?.drawings?.find((d) => d.kind === "notes.mindmap")?.guide, "One idea per line.");
    put(join(dist, "drawings/mindmap.md"), "One idea per line.");
  });

  test("a card whose extension is no longer installed is named gone", async () => {
    const s = fresh();
    await cards.cardSnapshotFor(s.id, s.path, project);
    const raised = await cards.raiseCard({ path: s.path, type: "notes.ok", data: { title: "OK?", buttons: [{ label: "Yes", does: { kind: "answer" } }] }, by: { kind: "script" } });
    assert.equal(raised.type, "notes.ok");
    assert.equal((await cards.sessionCardsAt(s.path)).gone, undefined);
    manifest([]);
    assert.deepEqual((await cards.sessionCardsAt(s.path)).gone, ["notes"]);
  });

  test("the page gets the kinds without their guides", async () => {
    const s = fresh();
    await cards.cardSnapshotFor(s.id, s.path, project);
    const a = await cards.sessionCardsAt(s.path);
    assert.deepEqual(a.drawings?.map((d) => d.kind), ["project.gantt", "notes.mindmap"]);
    assert.ok(a.drawings?.every((d) => !("guide" in d)));
  });
});

describe("own kinds never replace or change one of Sova's", () => {
  test("a kind without a dot is never an own kind, and Sova's words still parse as Sova's", () => {
    const own = [{ kind: "flow", accepts: "text" as const, toolkit: 1, guide: "evil" }, { kind: "project.gantt", accepts: "text" as const, toolkit: 1, guide: "" }];
    const snap = cards.snapshotOf(null);
    assert.ok(snap.drawings.every((d) => d.kind.includes(".")));
    const parse = ownAwareParse(own);
    for (const word of KIND_WORDS) {
      const ours = parseVis(word, "a -> b");
      assert.deepEqual(parse(word, "a -> b"), ours, `vis ${word} stays Sova's`);
    }
    assert.equal(parse("project.gantt", "anything").ok, true);
    // A namespaced word outside the chat's kinds is still the ordinary vis error.
    const unknown = parse("project.other", "x");
    assert.equal(unknown.ok, false);
    assert.match((unknown as { message: string }).message, /unknown kind "project\.other"/);
  });

  test("the vis_guide hook gives a session its snapshot's kinds with their guides, and nothing else", async () => {
    cards.installVisOwnKindsHook();
    const hook = (globalThis as Record<symbol, unknown>)[VIS_OWN_KINDS_HOOK] as (id: string) => { kind: string; guide: string; line: string }[];
    const s = fresh();
    await cards.cardSnapshotFor(s.id, s.path, project);
    const got = hook(s.id);
    assert.deepEqual(got.map((k) => k.kind), ["project.gantt", "notes.mindmap"]);
    assert.match(got[1]!.line, /vis notes\.mindmap \(text, from Notes\)/);
    assert.deepEqual(hook("01b00000-0000-7000-8000-999999999999"), []);
  });
});

describe("trust once per extension (§chat.transcript-cards/trust)", () => {
  test("an extension's view asks under its own owner, and only its trust lets it act", async () => {
    const s = fresh();
    await cards.cardSnapshotFor(s.id, s.path, project);
    const card = await cards.raiseCard({ path: s.path, type: "notes.review", data: {}, by: { kind: "script" } });
    await assert.rejects(cards.runCardCommand(s.path, card.id, "session.title.set", { title: "x" }), (err: { needsTrust?: { owner: string; name: string } }) => {
      assert.deepEqual(err.needsTrust, { owner: "ext:notes", name: "Notes" });
      return true;
    });
    // The project's trust is not the extension's.
    cards.setCardsTrusted(`project:${project}`, true);
    await assert.rejects(cards.runCardCommand(s.path, card.id, "session.title.set", { title: "x" }));
    cards.setCardsTrusted("ext:notes", true);
    assert.deepEqual(cards.extensionCardsTrust("notes"), { owner: "ext:notes", name: "Notes", trusted: true });
    const run = await cards.runCardCommand(s.path, card.id, "session.title.set", { title: "x" });
    assert.equal(run.ok, true);
    cards.setCardsTrusted("ext:notes", false);
    assert.equal(cards.extensionCardsTrust("notes").trusted, false);
    assert.throws(() => cards.setCardsTrusted("ext:../x", true));
  });
});
