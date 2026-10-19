// Run: pnpm test -- src/lib/card-place.browser.test.ts (Solid's reactive build).
// The home-card place (§app.extensions/card-status): Sova's own line first, the extension's status
// line after; the extension lane's requests: none without an extension that names `card`, one per
// such extension per drawing of the section, never one per poll; the validator, the caps, the time
// limit, the auto-mute and the off switch.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { CARD_OFF_KEY, cardStorage, CARD_ANSWER_MAX_BYTES, CARD_TEXT_MAX, cardExtensions, cardLines, createCardAdditions, validateCardAnswer } = await import("./card-place");
const { createSlotPolicy, MUTE_AFTER, OFF_KEY } = await import("./reply-slot");
const { offersOf } = await import("../../shared/extension-offers");
type ExtensionInfo = import("../../shared/protocol").ExtensionInfo;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

const plain: ExtensionInfo = { id: "notes", title: "Notes", status: "ok" };
const timer: ExtensionInfo = { id: "timer", title: "Timer", status: "ok", offers: { screens: ["card"] } };
const replyOnly: ExtensionInfo = { id: "tickets", title: "Tickets", status: "ok", offers: { screens: ["reply"] } };
const good = { status: { text: "This week: 12 h", tone: "ok" } };

describe("the offer", () => {
  test("`card` is kept in screens; a place not on the list is still dropped", () => {
    assert.deepEqual(offersOf("t", { screens: ["card", "home", "reply"] }).offers, { screens: ["reply", "card"] });
    assert.deepEqual(offersOf("t", { screens: ["cards"] }), { offers: null, dropped: ["1 of its screens"] });
  });
});

describe("the place", () => {
  test("Sova's own reason line first, word for word as the card always said it; then the extension's", () => {
    const down: ExtensionInfo = { ...timer, status: "down", error: "connection refused" };
    assert.deepEqual(cardLines(down, () => undefined), [{ kind: "down", text: "Its backend isn't answering: connection refused.", reason: "connection refused" }]);
    assert.deepEqual(cardLines({ ...down, error: undefined }, () => undefined).map((l) => l.text), ["Its backend isn't answering: no reason given."]);
    const added = validateCardAnswer(good, "timer").line!;
    assert.deepEqual(cardLines(timer, () => undefined), []);
    assert.deepEqual(cardLines(timer, () => added).map((l) => l.kind), ["status"]);
  });

  test("a card that is down shows only Sova's reason, never what the extension said while running", () => {
    const added = validateCardAnswer(good, "timer").line!;
    assert.deepEqual(cardLines({ ...timer, status: "down", error: "x" }, () => added).map((l) => l.kind), ["down"]);
  });

  test("the card's off switch has its own key and leaves the reply switch alone", () => {
    const m = memory();
    createSlotPolicy(cardStorage(m)).setOff("timer", true);
    assert.equal(m.getItem(CARD_OFF_KEY), JSON.stringify(["timer"]));
    assert.equal(m.getItem(OFF_KEY), null);
  });

  test("only running extensions that name the card place", () => {
    assert.deepEqual(cardExtensions([plain, replyOnly, { ...timer, status: "down" }]), []);
    assert.deepEqual(cardExtensions([plain, timer, replyOnly]), ["timer"]);
  });
});

describe("validateCardAnswer", () => {
  test("plain text and a known tone; muted when absent; no status is fine and draws nothing", () => {
    assert.deepEqual(validateCardAnswer(good, "timer"), { line: { kind: "status", text: "This week: 12 h", tone: "ok", extension: "timer" }, bad: false });
    assert.equal(validateCardAnswer({ status: { text: "Idle" } }, "timer").line?.tone, "muted");
    assert.deepEqual(validateCardAnswer({}, "timer"), { line: null, bad: false });
  });

  test("markup, overlong text, an unknown tone or a wrong shape is refused whole and bad", () => {
    for (const raw of [
      null,
      [],
      "x",
      { status: "x" },
      { status: { text: "<b>12 h</b>" } },
      { status: { text: "a\"b" } },
      { status: { text: " padded" } },
      { status: { text: "" } },
      { status: { text: "x".repeat(CARD_TEXT_MAX + 1) } },
      { status: { text: "ok", tone: "loud" } },
      { status: { text: "Running", tone: "ok" } },
      { status: { text: "down" } },
      { status: { text: "Its backend is not answering: x", tone: "error" } },
    ])
      assert.deepEqual(validateCardAnswer(raw, "timer"), { line: null, bad: true }, JSON.stringify(raw));
    assert.equal(validateCardAnswer({ status: { text: "x".repeat(CARD_TEXT_MAX) } }, "timer").bad, false);
  });
});

/** A section's lane over a stand-in fetch that records every request. */
function lane(answer: (url: string) => Response | Promise<Response>, timeoutMs?: number) {
  const calls: string[] = [];
  const policy = createSlotPolicy(memory());
  let api!: ReturnType<typeof createCardAdditions>;
  const dispose = solid.createRoot((d) => {
    api = createCardAdditions({
      policy,
      timeoutMs,
      fetch: async (url, init) => {
        calls.push(`${init.method ?? "GET"} ${url}`);
        return answer(url);
      },
    });
    return d;
  });
  return { calls, api, policy, dispose };
}
const json = (v: unknown) => () => new Response(JSON.stringify(v));

describe("the extension lane", () => {
  test("no extension that names card: no request at all", async () => {
    const l = lane(json(good));
    l.api.sync(undefined);
    l.api.sync([plain, replyOnly, { ...timer, status: "down" }]);
    await tick();
    assert.deepEqual(l.calls, []);
    l.dispose();
  });

  test("one request per extension per drawing, never on a later poll; its line is drawn", async () => {
    const l = lane(json(good));
    l.api.sync([plain, timer]);
    l.api.sync([plain, timer]);
    l.api.sync([{ ...timer }]);
    await tick();
    assert.deepEqual(l.calls, ["GET /ext/timer/api/screens/card"]);
    assert.equal(l.api.line("timer")?.text, "This week: 12 h");
    const other: ExtensionInfo = { ...timer, id: "other" };
    l.api.sync([timer, other]);
    await tick();
    assert.deepEqual(l.calls, ["GET /ext/timer/api/screens/card", "GET /ext/other/api/screens/card"], "one that appears later is asked once");
    l.dispose();
    const again = lane(json(good));
    again.api.sync([timer]);
    await tick();
    assert.equal(again.calls.length, 1, "a new drawing asks again");
    again.dispose();
  });

  test("off: never asked, and a line already drawn hides", async () => {
    const l = lane(json(good));
    l.policy.setOff("timer", true);
    l.api.sync([timer]);
    await tick();
    assert.deepEqual(l.calls, []);
    const m = lane(json(good));
    m.api.sync([timer]);
    await tick();
    assert.ok(m.api.line("timer"));
    m.policy.setOff("timer", true);
    assert.equal(m.api.line("timer"), undefined);
    l.dispose();
    m.dispose();
  });

  test("an answer that is late, too large, not 2xx or invalid draws nothing and counts a miss; misses mute", async () => {
    const big = { status: { text: "ok" }, pad: "x".repeat(CARD_ANSWER_MAX_BYTES) };
    const answers: Array<() => Response | Promise<Response>> = [
      () => new Promise<Response>(() => {}),
      json(big),
      () => new Response("{}", { status: 500 }),
      json({ status: { text: "<i>" } }),
    ];
    for (const a of answers) {
      // Each kind of bad answer, MUTE_AFTER drawings in a row on one page: each draws nothing and
      // counts a miss, and the last miss mutes it.
      const policy = createSlotPolicy(memory());
      for (let i = 0; i < MUTE_AFTER; i++) {
        assert.equal(policy.isMuted("timer"), false, `${i} misses mute nothing`);
        let api!: ReturnType<typeof createCardAdditions>;
        const d = solid.createRoot((dispose) => {
          api = createCardAdditions({ policy, timeoutMs: 20, fetch: async () => a() });
          return dispose;
        });
        api.sync([timer]);
        await tick(40);
        assert.equal(api.line("timer"), undefined);
        d();
      }
      assert.equal(policy.isMuted("timer"), true);
    }
    const policy = createSlotPolicy(memory());
    for (let i = 0; i < MUTE_AFTER; i++) policy.note("timer", false);
    const calls: string[] = [];
    const before = calls.length;
    const l = solid.createRoot((d) => {
      const api = createCardAdditions({ policy, fetch: async (url) => (calls.push(url), new Response(JSON.stringify(good))) });
      api.sync([timer]);
      return d;
    });
    await tick();
    assert.equal(calls.length, before, "a muted extension is not asked");
    l();
  });
});
