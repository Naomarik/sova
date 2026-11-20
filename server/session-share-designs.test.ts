// §app.session-share/lookbook, /lookbook-serving: where a share's Lookbooks sit (anchors beside the
// items), which designs and versions it shows (snapshot design cut vs Follow live), the allowlisted
// shape, the walled documents and their headers, and the design-cut side file. Session files in a
// throwaway temp dir; the design store in the runner's throwaway agent dir.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import type { DesignRecord, DesignRun } from "../shared/design";
import { SESSION_SHARE_DESIGN_KINDS, type SessionShareDesign } from "../shared/session-share";
import { DESIGN_PAGE_CSP, DESIGN_SHARE_SHELL_CSP, DESIGN_STREAM_CSP } from "../src/lib/design-frame";
import { changeDesigns, designDirOf, forgetDesignCache, writePage } from "./design/store";
import { historyOf } from "./harness/pi/reader";
import { DESIGN_CUTS_FILE, designCutOf, resetDesignCuts, setDesignCut } from "./session-share-design-cuts";
import { anchoredRun, designDocumentCsp, designDocumentHeaders, lookbookAnchors } from "./session-share-designs";
import { resetShareViewCache, sessionShareDesign, sessionShareSignedInPictures, sessionShareView, type ShareSource } from "./session-share-view";
import { ByteBudget } from "./share/session-routes";
import { stateRoot } from "./state-root";
import type { Entry } from "./transcript";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-designs-")));
after(() => rmSync(root, { recursive: true, force: true }));

const T = (min: number) => new Date(Date.UTC(2026, 9, 1, 10, min, 0)).toISOString();
const msg = (id: string, parentId: string | null, role: string, text: string, min: number): Entry =>
  ({ type: "message", id, parentId, timestamp: T(min), message: { role, content: [{ type: "text", text }] } }) as Entry;
const card = (id: string, parentId: string | null, runId: string, min: number, isError = false): Entry =>
  ({ type: "message", id, parentId, timestamp: T(min), message: { role: "toolResult", toolCallId: `c-${id}`, toolName: "lookbook", content: [{ type: "text", text: "card" }], details: { designCard: { runId } }, isError } }) as Entry;
const runMark = (id: string, parentId: string, runId: string, min: number): Entry =>
  ({ type: "custom", id, parentId, timestamp: T(min), customType: "sova-design-run", data: { v: 1, runId, at: T(min), setup: {} } }) as unknown as Entry;

function sessionFile(name: string, entries: Entry[]): string {
  const p = join(root, `${name}.jsonl`);
  writeFileSync(p, `${[{ type: "session", version: 3, id: name, cwd: "/tmp/proj" }, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
  resetShareViewCache();
  return p;
}

const run = (id: string): DesignRun => ({ id, setup: { brief: "SECRET-BRIEF", models: [], directions: [] }, phase: "done", labels: [], createdAt: T(0), updatedAt: T(0) });
const design = (label: string, runId: string, versions: { n: number; min: number; views?: string[] }[], more: Partial<DesignRecord> = {}): DesignRecord => ({
  label,
  runId,
  direction: `Style ${label}`,
  layout: label === "B" ? undefined : `Layout ${label}`,
  model: "prov/SECRET-MODEL-REF",
  parents: [],
  status: "ready",
  route: "tool",
  versions: versions.map((v) => ({ n: v.n, at: T(v.min), chars: 10, by: "first", note: { layout: "SECRET-NOTE", sections: "", type: "", color: "" }, ...(v.views ? { views: v.views.map((name) => ({ name, source: "declared" as const, state: "ok" as const, problem: "SECRET-PROBLEM" })) } : {}) })),
  sessionId: "SECRET-DESIGN-SESSION",
  sessionFile: "/var/SECRET-DESIGN-FILE.jsonl",
  modelName: `Model ${label}`,
  workerState: "idle",
  vision: true,
  usage: { input: 1, output: 2, cost: 0.987654 },
  createdAt: T(0),
  updatedAt: T(0),
  ...more,
});
/** Code the redactor's name guesses would rewrite (`e.key=[redacted]'Escape'`), which a page keeps as written. */
const CODE = `addEventListener('keydown',(e)=>{if(e.key==='Escape')close()});let key='draft';key=chatKey(x);const cfg={"token": "abc"};`;
const page = (mark: string) => `<!doctype html><html><head><style>h1{color:red}</style></head><body><h1>${mark}</h1><script>document.title="ran"</script><script>${CODE}</script></body></html>`;

/** A chat: u1 · a1 · card(run1) · a2 · u3 · card(run2) · a3, runs run1 and run2; and its design store. */
function chat(sid: string): string {
  forgetDesignCache();
  changeDesigns(sid, (s) => {
    s.runs = [run("run1"), run("run2"), run("run-unanchored")];
    s.designs = [
      design("A", "run1", [{ n: 1, min: 5, views: ["Home", "Pricing"] }, { n: 2, min: 20 }]),
      design("B", "run1", [{ n: 1, min: 6 }], { status: "writing", live: { version: 2, chars: 5 } }),
      design("C", "run1", [], { status: "failed", error: "SECRET-ERROR" }),
      design("D", "run1", [{ n: 1, min: 6 }], { removed: { at: T(7), by: "user" } }),
      design("E", "run2", [{ n: 1, min: 30 }]),
      design("F", "run-unanchored", [{ n: 1, min: 6 }]),
    ];
    s.pending = { B: { html: "SECRET-PENDING", at: T(8) } };
  });
  for (const [l, n] of [["A", 1], ["A", 2], ["B", 1], ["D", 1], ["E", 1], ["F", 1]] as const) writePage(sid, l, n, page(`PAGE-${l}${n} sk-ant-api03-${"x".repeat(40)}`));
  return sessionFile(sid, [
    msg("u1", null, "user", "make a lookbook", 1),
    msg("a1", "u1", "assistant", "on it", 2),
    card("t1", "a1", "run1", 3),
    msg("a2", "t1", "assistant", `here it is: ${CODE}`, 4),
    msg("u3", "a2", "user", "another", 10),
    card("t2", "u3", "run2", 11),
    runMark("m2", "t2", "run1", 12),
    msg("a3", "m2", "assistant", "done", 12),
  ]);
}

const src = (sessionPath: string, sid: string, over: Partial<ShareSource> = {}): ShareSource => ({ sessionPath, sessionId: sid, cutEntryId: null, from: null, title: "T", sharedAt: T(0), mode: "live", ...over });

describe("anchors", () => {
  test("a lookbook card or a run record anchors; an errored card, another tool or another record never does", () => {
    const [okCard, errCard, other, mark, otherMark] = historyOf([
      card("x1", "r", "runA", 1),
      card("x2", "r", "runB", 1, true),
      { type: "message", id: "x3", parentId: "r", message: { role: "toolResult", toolCallId: "c", toolName: "read", content: [], details: { designCard: { runId: "runC" } } } } as Entry,
      runMark("x4", "r", "runD", 1),
      { type: "custom", id: "x5", parentId: "r", customType: "sova-other", data: { v: 1, runId: "runE", at: T(1) } } as unknown as Entry,
    ]);
    assert.deepEqual([okCard, errCard, other, mark, otherMark].map((e) => anchoredRun(e!)), ["runA", null, null, "runD", null]);
  });

  test("first anchor wins, beside the item it follows; a run first anchored before the slice is left out whole", () => {
    const branch = historyOf([msg("u1", null, "user", "a", 1), card("c1", "u1", "r1", 2), msg("a1", "c1", "assistant", "b", 3), card("c2", "a1", "r2", 4), card("c3", "c2", "r1", 5)]);
    const itemOf = new Map([[branch[0]!, 0], [branch[2]!, 1]]);
    assert.deepEqual(lookbookAnchors(branch, branch, itemOf), [{ runId: "r1", after: 0 }, { runId: "r2", after: 1 }]);
    const slice = branch.slice(2);
    assert.deepEqual(lookbookAnchors(branch, slice, new Map([[branch[2]!, 0]])), [{ runId: "r2", after: 0 }], "r1's card is before the slice");
    const top = historyOf([card("c0", null, "r0", 1), msg("u1", "c0", "user", "a", 2)]);
    assert.deepEqual(lookbookAnchors(top, top, new Map([[top[1]!, 0]])), [{ runId: "r0", after: -1 }], "before every item");
  });
});

describe("the view's Lookbooks", () => {
  const sid = "0199aaaa-share-designs-view";
  const path = chat(sid);

  test("live: every finished version of every shown design, by run, beside the items; nothing else of them", async () => {
    const view = (await sessionShareView(src(path, sid)))!;
    assert.deepEqual(view.items.map((i) => i.n), [0, 1, 2, 3, 4], "no item is renumbered");
    assert.deepEqual(view.lookbooks, [
      {
        id: "lb1",
        after: 1,
        designs: [
          { label: "A", style: "Style A", layout: "Layout A", modelName: "Model A", versions: [{ n: 1, at: T(5), views: ["Home", "Pricing"] }, { n: 2, at: T(20) }] },
          { label: "B", style: "Style B", modelName: "Model B", versions: [{ n: 1, at: T(6) }] },
        ],
      },
      { id: "lb2", after: 3, designs: [{ label: "E", style: "Style E", modelName: "Model E", layout: "Layout E", versions: [{ n: 1, at: T(30) }] }] },
    ]);
    const json = JSON.stringify(view);
    for (const secret of ["SECRET", "run1", "run2", "prov/", "0.987654", "ready", "writing"]) assert.ok(!json.includes(secret), secret);
  });

  test("a snapshot shows only versions finished by its design cut; a design with none, and then a run with none, is left out", async () => {
    const at = (designsAt: string) => sessionShareView(src(path, sid, { mode: "snapshot", cutEntryId: "a3", designsAt })).then((v) => v!.lookbooks!);
    const shape = (lbs: { designs: SessionShareDesign[] }[]) => lbs.map((lb) => lb.designs.map((d) => `${d.label}:${d.versions.map((v) => v.n).join(",")}`));
    assert.deepEqual(shape(await at(T(25))), [["A:1,2", "B:1"]], "E finished after the cut");
    assert.deepEqual(shape(await at(T(5))), [["A:1"]]);
    assert.deepEqual(shape(await at(T(4))), []);
    // Absent: the cut entry's time (12), which leaves A2 (20) and E out.
    assert.deepEqual(shape((await sessionShareView(src(path, sid, { mode: "snapshot", cutEntryId: "a3" })))!.lookbooks!), [["A:1", "B:1"]]);
  });

  test("a slice shows only the runs anchored in it; an earlier cut drops the later card", async () => {
    assert.deepEqual((await sessionShareView(src(path, sid, { from: "u3" })))!.lookbooks!.map((l) => [l.after, l.designs.map((d) => d.label)]), [[0, ["E"]]], "run1's card (and its later record) are before u3");
    assert.deepEqual((await sessionShareView(src(path, sid, { mode: "snapshot", cutEntryId: "a2", designsAt: T(59) })))!.lookbooks!.map((l) => l.designs.map((d) => d.label)), [["A", "B"]]);
  });

  test("every page carries the whole view's Lookbooks; a source with no session carries none", async () => {
    const page0 = await sessionShareView(src(path, sid), { before: 2 });
    assert.deepEqual(page0!.lookbooks!.map((l) => l.id), ["lb1", "lb2"]);
    assert.deepEqual((await sessionShareView({ ...src(path, sid), sessionId: undefined }))!.lookbooks, []);
  });

  test("another chat's store is never read: the same run id there shows nothing here", async () => {
    const other = "0199aaaa-share-designs-other";
    forgetDesignCache();
    changeDesigns(other, (s) => {
      s.runs = [run("run9")];
      s.designs = [design("A", "run9", [{ n: 1, min: 1 }], { direction: "OTHER-CHAT-STYLE" })];
    });
    writePage(other, "A", 1, page("OTHER-CHAT-PAGE"));
    const p = sessionFile("other-anchor", [msg("u1", null, "user", "x", 1), card("t1", "u1", "run9", 2)]);
    assert.deepEqual((await sessionShareView(src(p, sid)))!.lookbooks, [], "run9 is not this chat's");
    assert.equal(await sessionShareDesign(src(p, sid), "A", 1, "page"), null);
  });
});

describe("design documents", () => {
  const sid = "0199aaaa-share-designs-docs";
  const path = chat(sid);

  test("only a shown version of a shown design is served", async () => {
    const live = src(path, sid);
    const snap = src(path, sid, { mode: "snapshot", cutEntryId: "a3", designsAt: T(10) });
    assert.ok(await sessionShareDesign(live, "A", 2, "page"));
    assert.equal(await sessionShareDesign(snap, "A", 2, "page"), null, "after the cut");
    assert.ok(await sessionShareDesign(snap, "A", 1, "still"));
    for (const [l, n] of [["D", 1], ["C", 1], ["F", 1], ["B", 2], ["Z", 1]] as const) assert.equal(await sessionShareDesign(live, l, n, "page"), null, `${l}${n}`);
  });

  test("page and tile run in the two-frame wall; still and tile-still run nothing; secrets are scrubbed, the page stays whole", async () => {
    const live = src(path, sid);
    for (const kind of SESSION_SHARE_DESIGN_KINDS) {
      const doc = (await sessionShareDesign(live, "A", 1, kind))!;
      assert.ok(doc.includes("PAGE-A1"), kind);
      assert.ok(!doc.includes("sk-ant-api03-"), `${kind}: the secret is scrubbed`);
      if (kind === "page" || kind === "tile") {
        assert.ok(doc.includes("createElement(\"iframe\")") && doc.includes("URL.createObjectURL(new Blob([html]"), `${kind}: the shell makes the page's frame, a blob: document`);
        assert.ok(!doc.includes(".srcdoc"), `${kind}: never srcdoc, whose base URL would be the shell's address under the link`);
        assert.ok(doc.includes('document.title=\\"ran\\"'), `${kind}: the page's own script is kept`);
        assert.ok(doc.includes(JSON.stringify(CODE).slice(1, -1)), `${kind}: its code is byte for byte as written`);
      } else {
        assert.ok(!doc.includes("createElement(\"iframe\")") && doc.startsWith("<!doctype html>"), `${kind}: one document, no shell`);
        assert.ok(doc.includes(`<script>${CODE}</script>`), `${kind}: its code is byte for byte as written`);
      }
    }
  });

  test("the conversation keeps the whole redactor: the same code in a message is still guessed at", async () => {
    const text = (await sessionShareView(src(path, sid)))!.items.find((i) => i.text.startsWith("here it is"))!.text;
    assert.ok(!text.includes("key='draft'") && text.includes("key='[redacted]'"), text);
    assert.ok(!text.includes("e.key==='Escape'"), text);
  });

  test("headers: a sandbox (opaque origin), Google Fonts only, framable by its own host only", () => {
    assert.equal(designDocumentCsp("page"), `sandbox allow-scripts allow-forms; ${DESIGN_SHARE_SHELL_CSP}; frame-ancestors 'self'`);
    // The share shell's one difference from the page's own policy: its frame may be a blob: document.
    assert.deepEqual(DESIGN_SHARE_SHELL_CSP.split("; ").filter((d) => !DESIGN_PAGE_CSP.split("; ").includes(d)), ["frame-src blob:"]);
    assert.equal(designDocumentCsp("still"), `sandbox; ${DESIGN_STREAM_CSP}; frame-ancestors 'self'`);
    assert.ok(!/script-src/.test(designDocumentCsp("tile-still")));
    const h = designDocumentHeaders("tile");
    assert.equal(h["X-Frame-Options"], "SAMEORIGIN");
    assert.equal(h["X-Content-Type-Options"], "nosniff");
    assert.equal(h["Cache-Control"], "no-store");
    assert.equal(h["Referrer-Policy"], "no-referrer");
    const sources = designDocumentCsp("page").match(/https:\/\/[^\s;]+/g);
    assert.deepEqual([...new Set(sources)].sort(), ["https://fonts.googleapis.com", "https://fonts.gstatic.com"]);
  });

  test("signed-in pictures: said only when a shown version's page uses a picture of a signed-in capture", async () => {
    const live = src(path, sid);
    assert.equal(await sessionShareSignedInPictures(live), false);
    const catalogue = join(designDirOf(sid), "assets", "catalogue.json");
    mkdirSync(dirname(catalogue), { recursive: true });
    writeFileSync(catalogue, JSON.stringify({ v: 1, named: 1, assets: [], captures: [{ url: "https://x.invalid/", at: T(1), names: ["a1"], skipped: [], notes: {}, signedIn: true, bytes: 1, ms: 1 }], signedInConsent: [] }));
    assert.equal(await sessionShareSignedInPictures(live), false, "no shown page uses a1");
    writePage(sid, "A", 2, page("PAGE-A2 <img src=\"sova-asset:a1\">"));
    assert.equal(await sessionShareSignedInPictures(live), true);
    assert.equal(await sessionShareSignedInPictures(src(path, sid, { mode: "snapshot", cutEntryId: "a3", designsAt: T(10) })), false, "A2 is after the cut");
  });
});

describe("the design cut side file", () => {
  const share = (over: Record<string, unknown> = {}) => ({ id: "ss_designcut0000000", mode: "snapshot" as const, cut: { entryId: "e1", at: T(10) }, createdAt: T(15), ...over });

  test("live has none; with no entry, the later of the cut entry's time and the creation", () => {
    resetDesignCuts();
    rmSync(join(stateRoot(), DESIGN_CUTS_FILE), { force: true });
    assert.equal(designCutOf(share({ mode: "live", cut: null })), null);
    assert.equal(designCutOf(share()), T(15));
    assert.equal(designCutOf(share({ createdAt: T(5) })), T(10));
  });

  test("an entry counts only with the cut entry it was taken with; a broken file reads as none", () => {
    resetDesignCuts();
    setDesignCut("ss_designcut0000000", "e1", T(40));
    resetDesignCuts();
    assert.equal(designCutOf(share()), T(40), "read back from disk");
    assert.equal(designCutOf(share({ cut: { entryId: "e2", at: T(30) } })), T(30), "the cut moved without it");
    writeFileSync(join(stateRoot(), DESIGN_CUTS_FILE), "{not json");
    resetDesignCuts();
    assert.equal(designCutOf(share()), T(15));
  });

  test("a write drops entries of shares that no longer exist", () => {
    resetDesignCuts();
    setDesignCut("ss_a", "e1", T(1));
    setDesignCut("ss_b", "e1", T(2), new Set(["ss_b"]));
    assert.equal(designCutOf({ id: "ss_a", mode: "snapshot", cut: { entryId: "e1", at: null }, createdAt: T(0) }), T(0));
    assert.equal(designCutOf({ id: "ss_b", mode: "snapshot", cut: { entryId: "e1", at: null }, createdAt: T(0) }), T(2));
  });
});

describe("ByteBudget", () => {
  test("an answer that doesn't fit the window is refused and not counted; the window slides", () => {
    const b = new ByteBudget(100, 1000);
    assert.equal(b.spend("k", 60, 0), true);
    assert.equal(b.spend("k", 50, 10), false);
    assert.equal(b.spend("k", 40, 20), true);
    assert.equal(b.spend("other", 100, 20), true, "per key");
    assert.equal(b.spend("k", 60, 1001), true, "the first answer left the window");
  });
});
