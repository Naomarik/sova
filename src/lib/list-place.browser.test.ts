// Run: pnpm test -- src/lib/list-place.browser.test.ts (Solid's reactive build).
// The list place's lane over the page's list (§app.extensions/list-place): inert when unused (no
// request, no timer, no labels asked, however the list changes, while no extension names `list`);
// with one, one request per list, a list change asking again no sooner than ROW_ASK_MIN_MS after;
// the first good declaration wins; the off switch and the auto-mute take it away.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createListPlace, LIST_OFF_KEY } = await import("./list-place");
const { ROW_ASK_MIN_MS } = await import("./row-place");
const { createSlotPolicy } = await import("./reply-slot");
const labelsAsk = await import("./labels-ask");
type ExtensionInfo = import("../../shared/protocol").ExtensionInfo;
type SessionSummary = import("../../shared/protocol").SessionSummary;
type RowClock = import("./row-place").RowClock;

const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const row = (i: number): SessionSummary =>
  ({ id: `s-${i}`, path: `/state/sessions/${i}.jsonl`, cwd: "/w", title: `S${i}`, createdAt: "", lastActiveAt: "", model: null }) as SessionSummary;
const many = (n: number) => Array.from({ length: n }, (_, i) => row(i));

const plain: ExtensionInfo = { id: "notes", title: "Notes", status: "ok" };
const rowOnly: ExtensionInfo = { id: "ci", title: "CI", status: "ok", offers: { screens: ["row", "reply", "card"] } };
const team: ExtensionInfo = { id: "team-bar", title: "Team bar", status: "ok", offers: { screens: ["list"] } };
const other: ExtensionInfo = { id: "people", title: "People", status: "ok", offers: { screens: ["list"] } };
const DECL = { people: [{ id: "kim", name: "Kim Ortega", initials: "KO", callers: ["operator"] }], ownerKey: "owner", self: "kim" };

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
    timers,
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

function page(opts: { extensions: ExtensionInfo[] | undefined; answers?: Record<string, unknown>; expected?: boolean; fail?: boolean }) {
  const calls: string[] = [];
  const asked: (string | null)[] = [];
  const time = clock();
  const policy = createSlotPolicy(memory(), LIST_OFF_KEY);
  const [sessions, setSessions] = solid.createSignal<SessionSummary[] | undefined>(undefined);
  const [extensions, setExtensions] = solid.createSignal<ExtensionInfo[] | undefined>(opts.extensions);
  let place!: ReturnType<typeof createListPlace>;
  const dispose = solid.createRoot((d) => {
    place = createListPlace({
      sessions,
      extensions,
      policy,
      clock: time.c,
      readLabels: (p) => asked.push(p),
      expected: opts.expected ?? false,
      fetch: async (url, init) => {
        calls.push(`${init.method ?? "GET"} ${url}`);
        if (opts.fail) throw new Error("backend down");
        const id = decodeURIComponent(url.split("/")[2]!);
        return new Response(JSON.stringify(opts.answers?.[id] ?? DECL));
      },
    });
    return d;
  });
  return { calls, asked, place, policy, setSessions, setExtensions, dispose, advance: time.advance, timers: time.timers };
}

describe("inert when unused", () => {
  test("no extension names the list place: no request, no timer, no labels asked, no declaration, however the list changes", async () => {
    const p = page({ extensions: [plain, rowOnly] });
    p.setSessions(many(3));
    await tick();
    for (let i = 0; i < 5; i++) {
      p.setSessions(many(3 + i));
      p.advance(ROW_ASK_MIN_MS * 2);
      await tick();
    }
    p.setExtensions([plain]);
    p.setExtensions(undefined);
    await tick();
    assert.deepEqual(p.calls, []);
    assert.equal(p.timers.size, 0, "no timer");
    assert.equal(p.place.declaration(), null);
    assert.equal(p.place.personOfCaller("operator"), undefined);
    assert.ok(p.asked.every((x) => x === null), "never a label pair");
    p.dispose();
  });

  test("the page module itself sets no labels while nothing declares: every URL is today's", () => {
    assert.equal(labelsAsk.labelsAsk(), null);
    assert.equal(labelsAsk.withLabels("/api/sessions"), "/api/sessions");
    assert.equal(labelsAsk.withLabels("/api/sessions/summary?id=a"), "/api/sessions/summary?id=a");
  });
});

describe("with an extension that declares people", () => {
  test("asked once when the list is there, again no sooner than ROW_ASK_MIN_MS after a list change; never per row", async () => {
    const p = page({ extensions: [team] });
    await tick();
    assert.deepEqual(p.calls, [], "no list yet: no ask");
    p.setSessions(many(200));
    await tick();
    assert.deepEqual(p.calls, ["GET /ext/team-bar/api/screens/list"]);
    assert.equal(p.place.declaration()?.people[0]?.name, "Kim Ortega");
    assert.equal(p.place.personOfCaller("operator")?.id, "kim");
    assert.deepEqual(p.asked.filter((x) => x !== null), ["team-bar:owner"], "the rows carry its owner label from now on");
    for (let i = 0; i < 5; i++) p.setSessions(many(201 + i));
    await tick();
    assert.equal(p.calls.length, 1, "a burst of list changes waits");
    p.advance(ROW_ASK_MIN_MS);
    await tick();
    assert.equal(p.calls.length, 2, "one trailing ask");
    const n = p.asked.length;
    p.dispose();
    assert.equal(p.asked.length, n, "the page going says nothing: the pairs stay for the next load");
  });

  test("labels are said only once known: kept pairs stand until an answer or a loaded extension list says otherwise", async () => {
    // This browser had a declaration: rows get their slot from the first draw, nothing is said yet.
    const p = page({ extensions: undefined, expected: true });
    p.setSessions(many(3));
    await tick();
    assert.equal(p.place.expected(), true);
    assert.deepEqual(p.asked, [], "no extension list yet: nothing known, nothing said");
    p.setExtensions([team]);
    await tick();
    assert.deepEqual(p.asked, ["team-bar:owner"], "the answer names the same pairs: the page's reads were already right");
    p.dispose();

    // Last time's extension is gone: once the extension list is loaded, the pairs and the slot go.
    const gone = page({ extensions: undefined, expected: true });
    assert.equal(gone.place.expected(), true);
    gone.setExtensions([plain]);
    await tick();
    assert.equal(gone.place.expected(), false);
    assert.deepEqual(gone.asked, [null]);
    gone.dispose();

    // A request that fails is not an answer: the kept pairs stand.
    const down = page({ extensions: [team], expected: true, fail: true });
    down.setSessions(many(1));
    await tick();
    assert.equal(down.calls.length, 1);
    assert.equal(down.place.expected(), true);
    assert.deepEqual(down.asked, []);
    down.dispose();
  });

  test("the first extension with a good declaration is the one", async () => {
    const p = page({ extensions: [other, team], answers: { people: { nope: true } } });
    p.setSessions(many(2));
    await tick();
    assert.equal(p.calls.length, 2);
    assert.equal(p.place.declaration()?.extension, "team-bar", "the first one's answer was bad");
    p.dispose();
  });

  test("the user's switch takes it away and brings it back; three bad answers mute it", async () => {
    const p = page({ extensions: [team] });
    p.setSessions(many(2));
    await tick();
    assert.ok(p.place.declaration());
    p.policy.setOff("team-bar", true);
    await tick();
    assert.equal(p.place.declaration(), null);
    assert.equal(p.asked.at(-1), null, "no labels asked while off");
    p.policy.setOff("team-bar", false);
    p.advance(ROW_ASK_MIN_MS);
    await tick();
    assert.ok(p.place.declaration());
    p.dispose();

    const bad = page({ extensions: [team], answers: { "team-bar": { people: [] } } });
    bad.setSessions(many(1));
    await tick();
    for (let i = 0; i < 3; i++) {
      bad.setSessions(many(2 + i));
      bad.advance(ROW_ASK_MIN_MS);
      await tick();
    }
    assert.equal(bad.policy.isMuted("team-bar"), true);
    const n = bad.calls.length;
    bad.setSessions(many(9));
    bad.advance(ROW_ASK_MIN_MS * 3);
    await tick();
    assert.equal(bad.calls.length, n, "muted: never asked again this page");
    bad.dispose();
  });

  test("the extension going away forgets its declaration and its labels", async () => {
    const p = page({ extensions: [team] });
    p.setSessions(many(2));
    await tick();
    assert.ok(p.place.declaration());
    p.setExtensions([plain]);
    await tick();
    assert.equal(p.place.declaration(), null);
    assert.equal(p.asked.at(-1), null);
    assert.equal(p.timers.size, 0);
    p.dispose();
  });
});
