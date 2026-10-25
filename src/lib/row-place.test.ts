// Run: pnpm test -- src/lib/row-place.test.ts
// The row place (§app.extensions/row-chips): the readiness badge as its built-in, the validator and
// the caps on what extensions add, and the per-list lane's asks, auto-mute, off switch and throttle.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createRowAnswers,
  isRowSovaWord,
  readinessItems,
  ROW_ASK_MIN_MS,
  ROW_BUILT_INS,
  ROW_CHIPS_PER_ROW,
  ROW_OFF_KEY,
  ROW_SESSIONS_MAX,
  rowChipTitle,
  rowExtensions,
  sameRowExtensions,
  validateRowAnswer,
  validRowChip,
  type RowChip,
  type RowClock,
  type RowSource,
} from "./row-place";
import { createSlotPolicy, MUTE_AFTER, OFF_KEY } from "./reply-slot";
import { readinessBadge, readinessTitle } from "./readiness";
type ExtensionInfo = import("../../shared/protocol").ExtensionInfo;
type SessionReadiness = import("../../shared/protocol").SessionReadiness;

const ext = { id: "ci", title: "CI" };
const memory = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the built-in", () => {
  const restart: SessionReadiness = { trees: [{ path: "/w/a", branch: "feat/a", state: "merged", merged: true }], badge: "restart", since: 0 };
  test("the readiness badge is the place's one built-in, worded and titled as the row always had it", () => {
    assert.deepEqual(ROW_BUILT_INS.map((b) => b.id), ["sova.readiness"]);
    assert.deepEqual(readinessItems(restart), [{ label: readinessBadge(restart)!, class: "session-readiness", title: readinessTitle(restart)! }]);
    assert.deepEqual(readinessItems(undefined), []);
    assert.deepEqual(readinessItems({ ...restart, badge: "merged" }), [], "merged without follow-ups: no badge");
    // A badge with no worktree lines has no title attribute at all, as before.
    assert.deepEqual(readinessItems({ trees: [], badge: "restart", since: 0 }), [{ label: "restart pending", class: "session-readiness" }]);
  });
});

describe("a chip", () => {
  test("label, tone and an optional title: copied field by field, naming its extension", () => {
    assert.deepEqual(validRowChip({ label: "CI green", tone: "ok", title: "All 12 checks passed", extra: { x: 1 } }, ext), {
      extension: "ci",
      extensionTitle: "CI",
      label: "CI green",
      tone: "ok",
      title: "All 12 checks passed",
    });
    assert.deepEqual(validRowChip({ label: "PR 12", tone: "muted" }, ext), { extension: "ci", extensionTitle: "CI", label: "PR 12", tone: "muted" });
  });

  test("anything that is not plain, short data is dropped", () => {
    for (const bad of [
      null,
      "CI",
      [],
      { tone: "ok" },
      { label: "", tone: "ok" },
      { label: "x".repeat(17), tone: "ok" },
      { label: " padded", tone: "ok" },
      { label: "<b>x</b>", tone: "ok" },
      { label: 'say "hi"', tone: "ok" },
      { label: "a&b", tone: "ok" },
      { label: "CI", tone: "loud" },
      { label: "CI", tone: "ok", title: "x".repeat(121) },
      { label: "CI", tone: "ok", title: "<script>" },
      { label: "CI", tone: "ok", title: 7 },
    ])
      assert.equal(validRowChip(bad, ext), null, JSON.stringify(bad));
    assert.ok(validRowChip({ label: "x".repeat(16), tone: "ok" }, ext), "16 characters is the limit, not past it");
  });

  test("a row chip does nothing when pressed: one with a link or an action is dropped", () => {
    assert.equal(validRowChip({ label: "Open PR", tone: "info", href: "https://example.test/pr" }, ext), null);
    assert.equal(validRowChip({ label: "Rerun", tone: "info", action: "rerun" }, ext), null);
  });

  test("a chip may not take one of Sova's own words on a row", () => {
    for (const w of ["TUI", "tui", "Draft", "restart pending", "Restart Pending", "1 follow-up", "12 follow-ups", "merged", "stale", "in progress", "blocked", "ready to merge", "waiting for your OK", "removed", "down", "refused", "hidden", "other version", "Other Version", "2 of 3", "0 of 1"]) {
      assert.equal(isRowSovaWord(w), true, w);
      assert.equal(validRowChip({ label: w, tone: "ok" }, ext), null, w);
    }
    assert.equal(isRowSovaWord("CI green"), false);
    assert.equal(isRowSovaWord("2 of 3 checks"), false, "only the bare count is Sova's");
  });

  test("its tooltip names its extension", () => {
    const c: RowChip = { extension: "ci", extensionTitle: "CI", label: "CI green", tone: "ok" };
    assert.equal(rowChipTitle(c), "CI green · From CI");
    assert.equal(rowChipTitle({ ...c, title: "All 12 checks passed" }), "All 12 checks passed · From CI");
  });
});

describe("an answer, keyed by session", () => {
  test("each session read on its own; one chip per extension per row", () => {
    const v = validateRowAnswer(
      {
        sessions: {
          "s-1": { chips: [{ label: "CI green", tone: "ok" }] },
          "s-2": { chips: [{ label: "A", tone: "ok" }, { label: "B", tone: "warn" }] },
          "s-3": { chips: [{ label: "Open", tone: "ok", href: "https://x.test" }] },
          "s-4": {},
        },
      },
      ext,
    );
    assert.deepEqual([...v.bySession.keys()], ["s-1", "s-2"]);
    assert.deepEqual(v.bySession.get("s-2")!.map((c) => c.label), ["A"], "past one is dropped");
    assert.equal(v.bad, true, "a dropped chip makes the answer bad; the rest still draws");
    assert.equal(validateRowAnswer({ sessions: { "s-1": { chips: [{ label: "ok", tone: "ok" }] } } }, ext).bad, false);
  });

  test("a malformed answer or session is bad", () => {
    for (const raw of [null, [], "x", {}, { sessions: [] }, { sessions: "x" }]) {
      const v = validateRowAnswer(raw, ext);
      assert.equal(v.bad && v.malformed, true, JSON.stringify(raw));
    }
    for (const sessions of [{ "bad id!": { chips: [] } }, { "s-1": [] }, { "s-1": { chips: "x" } }, { "s-1": null }]) {
      const v = validateRowAnswer({ sessions }, ext);
      assert.equal(v.bad, true, JSON.stringify(sessions));
      assert.equal(v.malformed, false, "one bad session is not a malformed answer");
      assert.equal(v.bySession.size, 0);
    }
  });

  test(`past ${ROW_SESSIONS_MAX} sessions the rest are not read, and the answer is bad`, () => {
    const sessions: Record<string, unknown> = {};
    for (let i = 0; i <= ROW_SESSIONS_MAX; i++) sessions[`s${i}`] = { chips: [{ label: "x", tone: "ok" }] };
    const v = validateRowAnswer({ sessions }, ext);
    assert.equal(v.bySession.size, ROW_SESSIONS_MAX);
    assert.equal(v.bySession.has(`s${ROW_SESSIONS_MAX}`), false);
    assert.equal(v.bad, true);
  });
});

describe("which extensions are asked", () => {
  const list: ExtensionInfo[] = [
    { id: "plain", title: "Plain", status: "ok" },
    { id: "reply", title: "Reply", status: "ok", offers: { screens: ["reply"] } },
    { id: "down", title: "Down", status: "down", offers: { screens: ["row"] } },
    { id: "ci", title: "CI", status: "ok", offers: { screens: ["reply", "row"] } },
  ];
  test("running ones whose offers name the row place, in manifest order", () => {
    assert.deepEqual(rowExtensions(list), [{ id: "ci", title: "CI" }]);
    assert.deepEqual(rowExtensions(undefined), []);
    assert.equal(sameRowExtensions(rowExtensions(list), rowExtensions(structuredClone(list))), true);
    assert.equal(sameRowExtensions(rowExtensions(list), [{ id: "ci", title: "CI 2" }]), false);
  });
});

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: RowClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (t) => void timers.delete(t as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [k, t] of [...timers].sort((a, b) => a[1].at - b[1].at))
      if (t.at <= now && timers.has(k)) {
        timers.delete(k);
        t.fn();
      }
  };
  return { clock, advance, pending: () => timers.size };
}

function lane(answers: Record<string, () => unknown>, policy = createSlotPolicy(memory(), ROW_OFF_KEY)) {
  const asked: string[] = [];
  const draws: Map<string, string[]>[] = [];
  const c = fakeClock();
  const a = createRowAnswers(policy, (m) => draws.push(new Map([...m].map(([k, v]) => [k, v.map((x) => `${x.extension}:${x.label}`)]))), { clock: c.clock, timeoutMs: 2000 });
  const sources = (ids: string[]): RowSource[] =>
    ids.map((id) => ({
      ext: { id, title: id.toUpperCase() },
      ask: async () => {
        asked.push(id);
        return answers[id]!();
      },
    }));
  return { a, asked, draws, sources, policy, ...c, last: () => draws.at(-1) };
}

describe("the lane", () => {
  test("extensions in order, at most two chips on a row", async () => {
    const chip = (label: string) => ({ sessions: { "s-1": { chips: [{ label, tone: "ok" }] } } });
    const l = lane({ a: () => chip("A"), b: () => chip("B"), c: () => chip("C") });
    l.a.ask(l.sources(["a", "b", "c"]));
    await flush();
    assert.deepEqual(l.last()!.get("s-1"), ["a:A", "b:B"]);
    assert.equal(ROW_CHIPS_PER_ROW, 2);
  });

  test(`after ${MUTE_AFTER} bad answers in a row it is muted, its last good answer stays until then`, async () => {
    let good = true;
    const l = lane({ a: () => (good ? { sessions: { "s-1": { chips: [{ label: "A", tone: "ok" }] } } } : { nope: 1 }) });
    l.a.ask(l.sources(["a"]));
    await flush();
    assert.deepEqual(l.last()!.get("s-1"), ["a:A"]);
    good = false;
    for (let i = 1; i < MUTE_AFTER; i++) {
      l.a.ask(l.sources(["a"]));
      await flush();
      assert.equal(l.policy.isMuted("a"), false);
      assert.deepEqual(l.last()!.get("s-1"), ["a:A"], "the last good answer stays");
    }
    l.a.ask(l.sources(["a"]));
    await flush();
    assert.equal(l.policy.isMuted("a"), true);
    assert.equal(l.last()!.size, 0, "a muted extension draws nothing");
    const before = l.asked.length;
    l.a.ask(l.sources(["a"]));
    await flush();
    assert.equal(l.asked.length, before, "and is never asked again this page");
  });

  test("a partly bad answer draws the rest and counts as bad", async () => {
    const l = lane({ a: () => ({ sessions: { "s-1": { chips: [{ label: "A", tone: "ok" }] }, "s-2": { chips: [{ label: "TUI", tone: "ok" }] } } }) });
    l.a.ask(l.sources(["a"]));
    await flush();
    assert.deepEqual([...l.last()!.keys()], ["s-1"]);
    for (let i = 1; i < MUTE_AFTER; i++) {
      l.a.ask(l.sources(["a"]));
      await flush();
    }
    assert.equal(l.policy.isMuted("a"), true);
  });

  test("a late answer counts as bad", async () => {
    const l = lane({ a: () => new Promise(() => {}) });
    l.a.ask(l.sources(["a"]));
    l.advance(2000);
    await flush();
    assert.equal(l.policy.isMuted("a"), false);
    for (let i = 1; i < MUTE_AFTER; i++) {
      l.a.ask(l.sources(["a"]));
      l.advance(2000);
      await flush();
    }
    assert.equal(l.policy.isMuted("a"), true);
  });

  test("the user's switch: off asks nothing and draws nothing, kept apart from the reply place's", async () => {
    const store = memory();
    const policy = createSlotPolicy(store, ROW_OFF_KEY);
    const l = lane({ a: () => ({ sessions: { "s-1": { chips: [{ label: "A", tone: "ok" }] } } }) }, policy);
    l.a.ask(l.sources(["a"]));
    await flush();
    assert.deepEqual(l.last()!.get("s-1"), ["a:A"]);
    policy.setOff("a", true);
    assert.equal(l.last()!.size, 0, "hidden at once");
    assert.deepEqual(JSON.parse(store.m.get(ROW_OFF_KEY)!), ["a"]);
    assert.equal(store.m.has(OFF_KEY), false, "the reply place's switch is untouched");
    assert.equal(createSlotPolicy(store).isOff("a"), false, "and reads as on for replies");
    const before = l.asked.length;
    l.a.ask(l.sources(["a"]));
    await flush();
    assert.equal(l.asked.length, before);
  });

  test(`a list change asks no sooner than ${ROW_ASK_MIN_MS / 1000}s after the last ask, once however many changes`, async () => {
    const l = lane({ a: () => ({ sessions: {} }) });
    l.a.ask(l.sources(["a"]));
    await flush();
    assert.equal(l.asked.length, 1);
    for (let i = 0; i < 20; i++) {
      l.advance(100);
      l.a.ask(l.sources(["a"]), true);
    }
    await flush();
    assert.equal(l.asked.length, 1, "nothing yet");
    l.advance(ROW_ASK_MIN_MS);
    await flush();
    assert.equal(l.asked.length, 2, "one trailing ask");
    l.advance(ROW_ASK_MIN_MS * 3);
    l.a.ask(l.sources(["a"]), true);
    await flush();
    assert.equal(l.asked.length, 3, "long after the last ask, a change asks at once");
  });

  test("an extension that leaves is forgotten: its chips go, its waiting ask is dropped", async () => {
    const l = lane({ a: () => ({ sessions: { "s-1": { chips: [{ label: "A", tone: "ok" }] } } }), b: () => ({ sessions: {} }) });
    l.a.ask(l.sources(["a", "b"]));
    await flush();
    l.a.ask(l.sources(["a", "b"]), true);
    assert.equal(l.pending(), 2, "two trailing asks wait");
    l.a.ask(l.sources(["b"]));
    await flush();
    assert.equal(l.last()!.size, 0);
    l.advance(ROW_ASK_MIN_MS);
    await flush();
    assert.deepEqual(l.asked, ["a", "b", "b"], "a was never asked again");
  });

  test("stop: no answer draws, no timer is left", async () => {
    let release!: (v: unknown) => void;
    const l = lane({ a: () => new Promise((r) => (release = r)) });
    l.a.ask(l.sources(["a"]));
    l.a.ask(l.sources(["a"]), true);
    l.a.stop();
    release({ sessions: { "s-1": { chips: [{ label: "A", tone: "ok" }] } } });
    await flush();
    assert.equal(l.draws.length, 0);
    assert.equal(l.policy.isMuted("a"), false, "a stopped ask is not counted");
  });
});
