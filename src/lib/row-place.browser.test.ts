// Run: pnpm test -- src/lib/row-place.browser.test.ts (Solid's reactive build).
// The row place's lane over a whole list (§app.extensions/row-chips): no request at all without an
// extension that adds to rows, however the list changes; one request per such extension per list,
// never one per row, a list change asking again no sooner than ROW_ASK_MIN_MS after; a session on
// another host never shows a chip.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createRowAdditions, ROW_ASK_MIN_MS, ROW_OFF_KEY } = await import("./row-place");
const { createSlotPolicy } = await import("./reply-slot");
const mesh = await import("./mesh");
type ExtensionInfo = import("../../shared/protocol").ExtensionInfo;
type SessionSummary = import("../../shared/protocol").SessionSummary;
type RowClock = import("./row-place").RowClock;

const tick = () => new Promise((r) => setTimeout(r, 0));
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const row = (i: number, path = `/state/sessions/${i}.jsonl`): SessionSummary =>
  ({ id: `s-${i}`, path, cwd: "/w", title: `S${i}`, createdAt: "2026-02-01T00:00:00.000Z", lastActiveAt: "2026-02-01T00:00:00.000Z", model: null }) as SessionSummary;
const many = (n: number) => Array.from({ length: n }, (_, i) => row(i));

const plain: ExtensionInfo = { id: "notes", title: "Notes", status: "ok" };
const replyOnly: ExtensionInfo = { id: "tickets", title: "Tickets", status: "ok", offers: { screens: ["reply"] } };
const ci: ExtensionInfo = { id: "ci", title: "CI", status: "ok", offers: { screens: ["row"] } };

function clock() {
  let now = 5_000_000;
  const timers = new Set<{ at: number; fn: () => void }>();
  const c: RowClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.add(t);
      return t;
    },
    clearTimeout: (t) => void timers.delete(t as never),
  };
  return {
    c,
    advance(ms: number) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at))
        if (t.at <= now && timers.has(t)) {
          timers.delete(t);
          t.fn();
        }
    },
  };
}

function pane(opts: { extensions: ExtensionInfo[]; answer?: unknown }) {
  const calls: string[] = [];
  const time = clock();
  const [sessions, setSessions] = solid.createSignal<SessionSummary[] | undefined>(undefined);
  const [extensions, setExtensions] = solid.createSignal<ExtensionInfo[] | undefined>(opts.extensions);
  let chips!: ReturnType<typeof createRowAdditions>;
  const dispose = solid.createRoot((d) => {
    chips = createRowAdditions({
      sessions,
      extensions,
      policy: createSlotPolicy(memory(), ROW_OFF_KEY),
      clock: time.c,
      fetch: async (url, init) => {
        calls.push(`${init.method ?? "GET"} ${url}`);
        return new Response(JSON.stringify(opts.answer ?? { sessions: { "s-1": { chips: [{ label: "CI green", tone: "ok" }] }, "s-r": { chips: [{ label: "CI red", tone: "error" }] } } }));
      },
    });
    return d;
  });
  return { calls, chips, setSessions, setExtensions, dispose, advance: time.advance };
}

describe("the row place's requests", () => {
  test("no extension adds to rows: no request at all, ever, and no row has a chip", async () => {
    const p = pane({ extensions: [plain, replyOnly] });
    p.setSessions(many(480));
    await tick();
    for (let i = 0; i < 5; i++) {
      p.setSessions(many(480));
      p.advance(ROW_ASK_MIN_MS * 2);
      await tick();
    }
    assert.deepEqual(p.calls, []);
    assert.equal(p.chips(row(1)), undefined);
    p.dispose();
  });

  test("nothing is asked before the list is there", async () => {
    const p = pane({ extensions: [ci] });
    await tick();
    assert.deepEqual(p.calls, []);
    p.dispose();
  });

  test("480 rows: one request for the whole list, keyed by session, never one per row", async () => {
    const p = pane({ extensions: [plain, ci, replyOnly] });
    p.setSessions(many(480));
    await tick();
    await tick();
    assert.deepEqual(p.calls, ["GET /ext/ci/api/screens/row"]);
    assert.deepEqual(p.chips(row(1))?.map((c) => [c.label, c.extensionTitle]), [["CI green", "CI"]]);
    assert.equal(p.chips(row(2)), undefined);
    p.dispose();
  });

  test(`the list changing asks again once, no sooner than ${ROW_ASK_MIN_MS / 1000}s after the last ask`, async () => {
    const p = pane({ extensions: [ci] });
    p.setSessions(many(10));
    await tick();
    for (let i = 0; i < 30; i++) {
      p.setSessions(many(10));
      p.advance(100);
    }
    await tick();
    assert.equal(p.calls.length, 1);
    p.advance(ROW_ASK_MIN_MS);
    await tick();
    assert.equal(p.calls.length, 2);
    p.dispose();
  });

  test("the set of extensions changing asks at once; one gone, its chips go", async () => {
    const p = pane({ extensions: [ci] });
    p.setSessions(many(3));
    await tick();
    await tick();
    assert.ok(p.chips(row(1)));
    p.setExtensions([ci, { ...plain, offers: { screens: ["row"] } }]);
    await tick();
    assert.deepEqual(p.calls, ["GET /ext/ci/api/screens/row", "GET /ext/ci/api/screens/row", "GET /ext/notes/api/screens/row"]);
    p.setExtensions([{ ...ci, status: "down" }]);
    await tick();
    assert.equal(p.chips(row(1)), undefined, "a down backend shows nothing");
    p.setExtensions([{ ...ci, status: "down" }]);
    await tick();
    assert.equal(p.calls.length, 3, "a poll that changes nothing asks nothing");
    p.dispose();
  });

  test("a session on another host never shows a chip", async () => {
    const remote = row(0, "/peer/sessions/r.jsonl");
    mesh.noteHost(remote.path, "peer-1");
    const p = pane({ extensions: [ci] });
    p.setSessions([row(1), { ...remote, id: "s-r" }]);
    await tick();
    await tick();
    assert.ok(p.chips(row(1)));
    assert.equal(p.chips({ ...remote, id: "s-r" }), undefined);
    mesh.noteHost(remote.path, null);
    p.dispose();
  });
});
