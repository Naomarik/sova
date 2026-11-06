// Sessions ping their Overseer (§app/overseer-pings), the parts that need no chat: the tool's rules and
// refusals, the store and its counts shared through one file, the run's standing (who started it, its hop),
// the raised hand in the attention digest and on the phone, routing, outcomes and the limits' settings.
// A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { PingAuditLine, PingRecord, PingRoute, SessionSummary } from "../shared/protocol";
import type { RunStanding } from "../shared/chat-runtime";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-pings-test-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const pings = await import("./overseer-pings");
const { PingStore, makePing, lowerHand, raisedHands, setPingOutcome, routePing, ownWordsOf, pingAnswer, onPing, NOTHING_SENT, PingRefusal } = pings;
const { RunState, SessionLimits } = await import("./session-powers");
const { sessionItems, NEVER_BRIEFED } = await import("./attention");
const { listsInNeedsYou } = await import("../shared/needs-you");
const { pushDecision, pushPayload, PUSH_KIND_LABEL } = await import("./push");
const { defaultPushSettings } = await import("./push-store");
const { parseSettings } = await import("./overseer-store");
const { DEFAULT_PING_LIMITS, pingLimitsOf } = await import("../shared/overseer-limits");
const { pingCardData, pingOutcomeText } = await import("../shared/transcript-cards");
const { PUSH_KINDS } = await import("../shared/protocol");

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
let clock = NOW;
let fileN = 0;

function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return { id, path: `/s/${id}.jsonl`, cwd: "/home/u/proj", title: `Session ${id}`, createdAt: "2026-11-06T10:00:00.000Z", lastActiveAt: new Date(NOW - 60_000).toISOString(), model: "a/b", live: null, busy: false, origin: "web", archived: false, ...over };
}

/** makePing's deps over a fresh store file; `sessions` the summaries it reads. */
function rig(o: { sessions?: SessionSummary[]; overseer?: boolean; limits?: Partial<typeof DEFAULT_PING_LIMITS>; route?: PingRoute } = {}) {
  const file = join(agentDir, `pings-${++fileN}.json`);
  const store = new PingStore(() => file, () => clock);
  const audit: Omit<PingAuditLine, "at">[] = [];
  const cards: string[] = [];
  const sessions = new Map((o.sessions ?? [summary("a")]).map((s) => [s.path, s]));
  const deps: import("./overseer-pings").PingDeps = {
    store,
    summary: async (path) => sessions.get(path) ?? null,
    limits: () => ({ ...DEFAULT_PING_LIMITS, ...o.limits }),
    overseerExists: () => o.overseer ?? true,
    route: async () => o.route ?? { kind: "overseer" },
    card: async (p) => {
      cards.push(p.id);
      return `cd_${cards.length}`;
    },
    audit: (l) => void audit.push(l),
  };
  let call = 0;
  const ping = (params: Record<string, unknown>, standing: RunStanding | null = { attended: true, hop: 0 }, id = "a") =>
    makePing({ sessionId: id, path: `/s/${id}.jsonl`, title: `Session ${id}`, standing, toolCallId: `tc-${++call}` }, params, deps);
  const refusal = async (params: Record<string, unknown>, standing?: RunStanding | null, id?: string): Promise<string> => {
    const before = readFileSafe(file);
    const auditBefore = audit.length;
    try {
      await ping(params, standing === undefined ? { attended: true, hop: 0 } : standing, id);
    } catch (err) {
      assert.ok(err instanceof PingRefusal, String(err));
      assert.ok(err.message.startsWith(NOTHING_SENT), err.message);
      assert.equal(readFileSafe(file), before, "a refusal takes nothing: the file is unchanged");
      assert.equal(audit.length, auditBefore + 1, "and is one line of the log");
      assert.equal(audit.at(-1)!.outcome, "refused");
      return err.message;
    }
    throw new Error(`not refused: ${JSON.stringify(params)}`);
  };
  return { store, file, audit, cards, deps, ping, refusal, sessions };
}
const readFileSafe = (f: string) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

beforeEach(() => {
  clock = NOW;
});

describe("overseer_ping: the call (§app.overseer-pings/tool)", () => {
  test("an accepted ping: kept with the run's standing, counted, logged without its text, its card raised; the answer", async () => {
    const r = rig();
    const heard: PingRecord[] = [];
    const off = onPing((p) => void heard.push(p));
    const p = await r.ping({ kind: "stuck", summary: "  tests   hang on the\nfixture ", detail: "since the bump" });
    off();
    assert.equal(p.id, "pg_1");
    assert.equal(p.summary, "tests hang on the fixture", "one line");
    assert.equal(p.attended, true);
    assert.equal(p.hop, 0);
    assert.equal(p.card, "cd_1");
    assert.deepEqual(heard.map((x) => x.id), ["pg_1"], "the Overseer's side hears it");
    assert.equal(r.store.get("pg_1")!.card, "cd_1", "the card's id is kept with it");
    assert.equal(pingAnswer(p), "Told the Overseer (pg_1). Your hand stays up in Needs you until the user starts a turn here.");
    assert.equal(r.audit.at(-1)!.outcome, "ok");
    assert.ok(!JSON.stringify(r.audit).includes("tests hang"), "the log never holds the text");
    const done = await r.ping({ kind: "done", summary: "migrated the store" });
    assert.equal(pingAnswer(done), "Told the Overseer (pg_2).", "no hand for done");
  });

  test("a project overseer that hears it: the answer names the project", async () => {
    const r = rig({ route: { kind: "project", projectId: "prj_1", projectName: "Billing" } });
    const p = await r.ping({ kind: "news", summary: "the schema changed" });
    assert.equal(pingAnswer(p), "Told Billing's overseer (pg_1).");
  });

  test("every refusal starts 'Nothing was sent:', says why and takes nothing", async () => {
    const r = rig({ sessions: [summary("a"), summary("q", { align: { openQuestions: 2, questionDocs: 1 } as never })] });
    assert.match(await r.refusal({ kind: "urgent", summary: "x" }), /kind is one of/);
    assert.match(await r.refusal({ kind: "stuck", summary: "   " }), /summary must not be blank/);
    assert.match(await r.refusal({ kind: "stuck", summary: "x".repeat(201) }), /at most 200/);
    assert.match(await r.refusal({ kind: "stuck", summary: "x", detail: "y".repeat(2001) }), /at most 2000/);
    assert.match(await r.refusal({ kind: "relay", summary: "give it on" }), /says who it is for in to/);
    assert.match(await r.refusal({ kind: "relay", summary: "give it on", to: "z".repeat(201) }), /to is at most 200/);
    assert.match(await r.refusal({ kind: "news", summary: "x", to: "billing" }), /to is only for a relay/);
    assert.match(await r.refusal({ kind: "decision", summary: "pick a db" }, undefined, "q"), /open alignment questions/);
    // stuck is fine with open questions; only decision is refused.
    await r.ping({ kind: "stuck", summary: "fine" }, undefined, "q");
  });

  test("a relay only in a run the user's own message started, at hop 0: only the user can ask you to pass something on", async () => {
    const r = rig();
    const only = /only the user can ask you to pass something on/;
    assert.match(await r.refusal({ kind: "relay", summary: "s", to: "billing" }, { attended: false, hop: 1 }), only, "a run a topic batch, a wake or an Overseer's prompt opened");
    assert.match(await r.refusal({ kind: "relay", summary: "s", to: "billing" }, { attended: false, hop: 2 }), only, "a run another session's message opened");
    assert.match(await r.refusal({ kind: "relay", summary: "s", to: "billing" }, { attended: true, hop: 1 }), only, "hop 1 even if attended");
    assert.match(await r.refusal({ kind: "relay", summary: "s", to: "billing" }, null), only, "no run record fails closed");
    const p = await r.ping({ kind: "relay", summary: "s", to: "the billing session, sova://s/abc-1", detail: "INJECTED" }, { attended: true, hop: 0, said: `ship it friday ${"x".repeat(700)}` });
    assert.equal(p.said!.length, 600, "at most 600 characters of the user's message");
    assert.ok(p.said!.startsWith("ship it friday"));
    assert.deepEqual(r.audit.at(-1)!.to, ["abc-1"], "the log names linked sessions by id, never the words");
  });

  test("a news or relay ping needs an Overseer on this Sova; a raised hand doesn't", async () => {
    const r = rig({ overseer: false });
    assert.match(await r.refusal({ kind: "news", summary: "s" }), /this Sova has no Overseer/);
    assert.match(await r.refusal({ kind: "relay", summary: "s", to: "b" }, { attended: true, hop: 0, said: "x" }), /this Sova has no Overseer/);
    await r.ping({ kind: "stuck", summary: "still reaches Needs you" });
  });

  test("never a worker's, an Overseer's, a project overseer's, a baton's, a merge queue chat's, an archived or a terminal's session", async () => {
    const odd = [
      summary("w", { workerSession: true } as never),
      summary("o", { overseer: true } as never),
      summary("po", { projectOverseer: { projectId: "p" } } as never),
      summary("b", { baton: {} } as never),
      summary("mq", { queueChat: { role: "thread" } } as never),
      summary("ar", { archived: true }),
      summary("t", { live: {} } as never),
    ];
    const r = rig({ sessions: odd });
    for (const s of odd) await r.refusal({ kind: "stuck", summary: "s" }, undefined, s.id);
  });

  test("the same summary as the session's open ping is refused; another session's is not", async () => {
    const r = rig({ sessions: [summary("a"), summary("b")] });
    await r.ping({ kind: "stuck", summary: "Blocked on creds" });
    assert.match(await r.refusal({ kind: "decision", summary: "blocked on CREDS" }), /same summary as this session's open ping/);
    await r.ping({ kind: "stuck", summary: "Blocked on creds" }, undefined, "b");
  });

  test("limits: 3 an hour and 10 a day per session, counted in the shared file; a refusal takes nothing", async () => {
    const r = rig({ sessions: [summary("a"), summary("b")] });
    for (const s of ["one", "two", "three"]) await r.ping({ kind: "done", summary: s });
    assert.match(await r.refusal({ kind: "done", summary: "four" }), /at most 3 pings an hour from one session \(3 sent\)/);
    await r.ping({ kind: "done", summary: "four" }, undefined, "b");
    clock += 61 * 60_000;
    await r.ping({ kind: "done", summary: "four" });
    // A second process reading the same file sees the same counts.
    const other = new PingStore(() => r.file, () => clock);
    assert.equal(other.today("session:a"), 4);
    assert.equal(other.recent("session:a", 3_600_000), 1);
    const day = rig({ limits: { sessionPerHour: 100, sessionPerDay: 2 } });
    await day.ping({ kind: "done", summary: "1" });
    await day.ping({ kind: "done", summary: "2" });
    assert.match(await day.refusal({ kind: "done", summary: "3" }), /at most 2 pings a day/);
  });

  test("counts the Overseer's side keeps (note, give) are shared too, and a give takes one back", () => {
    const r = rig();
    const at = r.store.note("relay");
    r.store.note("relay");
    const other = new PingStore(() => r.file, () => clock);
    assert.equal(other.today("relay"), 2);
    other.give("relay", at);
    assert.equal(r.store.today("relay"), 1);
  });
});

describe("a raised hand (§app.overseer-pings/raised-hand)", () => {
  test("one hand per session: a newer stuck or decision replaces it, any other ping lowers it", async () => {
    const r = rig();
    await r.ping({ kind: "stuck", summary: "first" });
    await r.ping({ kind: "decision", summary: "second" });
    assert.equal(raisedHands(r.store).get("a")!.summary, "second");
    assert.equal(r.store.get("pg_1")!.lowered!.why, "newer-ping");
    await r.ping({ kind: "news", summary: "third" });
    assert.equal(raisedHands(r.store).get("a"), undefined, "news lowers it");
  });

  test("it survives a turn an Overseer's or a project overseer's prompt starts, and comes down at the user's own turn", async () => {
    const r = rig();
    await r.ping({ kind: "stuck", summary: "need creds" });
    const run = new RunState(undefined, () => void lowerHand("a", "user-turn", r.store));
    const t = turnsRig(run);
    t.turn("[from the project overseer] keep going", { marked: false });
    t.turn("[from session \"Captain\", hop 1] status?", { marked: false, hop: 1 });
    t.turn("[wake] timer", { marked: false });
    assert.equal(raisedHands(r.store).get("a")?.summary, "need creds", "still up");
    t.turn("here are the creds");
    assert.equal(raisedHands(r.store).get("a"), undefined, "down at the user's turn");
    assert.equal(r.store.get("pg_1")!.lowered!.why, "user-turn");
  });

  test("archived: down", async () => {
    const r = rig();
    await r.ping({ kind: "decision", summary: "which db" });
    assert.equal(lowerHand("a", "archived", r.store), true);
    assert.equal(lowerHand("a", "archived", r.store), false, "nothing left to lower");
  });

  test("the digest: stuck and decision are blockers that take the asks-you guess's place; done is a quiet decide line", () => {
    const s = summary("h", { signals: { at: NOW - 5000, turnId: "t", provider: "jev", kinds: ["asks-you"] } } as never);
    const row = (raisedHand?: { kind: "stuck" | "decision" | "done"; summary: string; at: number }) => ({ summary: s, dialogs: [], queued: 0, failedWorkers: 0, activitySince: 0, ...(raisedHand ? { raisedHand } : {}) });
    const items = (h?: Parameters<typeof row>[0]) => sessionItems(row(h), NOW, "/home/u").map((i) => `${i.tier}:${i.kind}:${i.detail}`);
    assert.deepEqual(items({ kind: "stuck", summary: "tests hang", at: NOW - 1000 }), ["act:raised-hand:Stuck: tests hang"]);
    assert.deepEqual(items({ kind: "decision", summary: "pick a db", at: NOW - 1000 }), ["act:raised-hand:Needs your decision: pick a db"]);
    assert.deepEqual(items({ kind: "done", summary: "shipped", at: NOW - 1000 }), ["decide:raised-hand:Says it's done: shipped", "decide:asks-you:The last reply asks you something."]);
    assert.deepEqual(items(), ["decide:asks-you:The last reply asks you something."], "control: no hand, the guess shows");
    const [hand] = sessionItems(row({ kind: "stuck", summary: "x", at: NOW - 1000 }), NOW);
    assert.equal(hand!.since, NOW - 1000, "dated by the ping");
    assert.equal(listsInNeedsYou(hand!), true);
    assert.equal(NEVER_BRIEFED.has("raised-hand"), false, "briefable");
    const [doneLine] = sessionItems(row({ kind: "done", summary: "x", at: NOW }), NOW);
    assert.equal(listsInNeedsYou(doneLine!), false, "done never lists in Needs you");
    assert.deepEqual(sessionItems({ ...row({ kind: "stuck", summary: "x", at: NOW }), summary: { ...s, archived: true } }, NOW).filter((i) => i.kind === "raised-hand"), [], "never on an archived session");
  });

  test("the phone: kind raised-hand, \"Raised hand\", on by default, off when switched off", () => {
    assert.ok(PUSH_KINDS.includes("raised-hand"));
    assert.equal(PUSH_KIND_LABEL["raised-hand"], "Raised hand");
    const settings = { ...defaultPushSettings(), contact: "mailto:ops@example.test" };
    assert.equal(settings.kinds["raised-hand"], true);
    const b = { id: "h", kind: "raised-hand" as const, title: "Session h", detail: "Stuck: tests hang" };
    const base = { settings, devices: 1, now: 1_000_000, lastSentAt: 0, quiet: false, viewing: () => false };
    const sent = pushDecision({ ...base, current: [b], announced: new Set() });
    assert.deepEqual(sent.send.map((x) => x.kind), ["raised-hand"]);
    assert.equal(pushPayload(sent.send, 1, 1_000_000, () => ({ redact: (t: string) => t }) as never).title, "Raised hand · Session h");
    const off = pushDecision({ ...base, settings: { ...settings, kinds: { ...settings.kinds, "raised-hand": false } }, current: [b], announced: new Set() });
    assert.deepEqual(off.send, [], "switched off: told without sending");
  });
});

/** A RunState watching a stand-in session: each turn hands `text` in (marked as the user's unless `marked: false`). */
function turnsRig(run: InstanceType<typeof RunState>) {
  let claim: ((m: unknown) => void) | null = null;
  run.turns.watch({ onUserMessage: (cb: (m: unknown) => void) => void (claim = cb) } as never);
  const ev = (e: unknown) => run.observe(e as never);
  return {
    ev,
    turn(text: string, o: { marked?: boolean; hop?: number } = {}) {
      const msg = { role: "user", content: text };
      if (o.hop !== undefined) run.expectHop(text, o.hop);
      if (o.marked === false) claim!(msg);
      else run.turns.send(() => claim!(msg));
      ev({ type: "run.start" });
      ev({ type: "message.start", role: "user", text, handle: msg });
      return msg;
    },
  };
}

describe("who started the run, and its hop (§app.overseer-pings/tool)", () => {
  test("the user's own message: attended, hop 0; any other opener: not, and a session message's hop plus 1", () => {
    const run = new RunState();
    const t = turnsRig(run);
    t.turn("do the thing");
    assert.deepEqual(run.standing(), { attended: true, hop: 0 });
    t.turn("[from session \"A\", hop 1] can you check", { marked: false, hop: 1 });
    assert.deepEqual(run.standing(), { attended: false, hop: 2 }, "a session message: its hop plus 1");
    t.turn("[passed on by the Overseer from session \"A\" (a), hop 1]", { marked: false, hop: 1 });
    assert.deepEqual(run.standing(), { attended: false, hop: 2 }, "a passed-on note");
    t.turn("[topic merge-abc] READY", { marked: false });
    assert.deepEqual(run.standing(), { attended: false, hop: 1 }, "a topic batch: never hop 0");
    t.turn("[wake] timer fired", { marked: false });
    assert.deepEqual(run.standing(), { attended: false, hop: 1 }, "a wake-up");
  });

  test("foreign input that enters the user's run after the reply makes the rest of it not the user's", () => {
    const run = new RunState();
    const t = turnsRig(run);
    t.turn("ask billing to ship friday");
    t.ev({ type: "message.start", role: "assistant", handle: { role: "assistant" } });
    // A tool result (neutral) keeps it the user's: the reason the relay carries only the user's own words.
    t.ev({ type: "message.start", role: "toolResult", handle: { role: "toolResult" } });
    assert.equal(run.standing().attended, true);
    const other = { role: "user", content: "[from session \"X\", hop 1] relay this too" };
    run.expectHop(other.content, 1);
    t.ev({ type: "message.start", role: "user", handle: other });
    assert.deepEqual(run.standing(), { attended: false, hop: 2 });
  });

  test("a powers profile keeps its limits on the same RunState; a plain chat's has none", () => {
    const limits = new SessionLimits("p", undefined, null);
    const run = new RunState(limits);
    turnsRig(run).turn("hello");
    assert.equal(limits.counts().turn, 0);
    assert.deepEqual(new RunState().standing(), { attended: false, hop: 1 }, "no run yet: not the user's");
  });

  test("the user's words a relay carries: the newest user entry on the branch, its text blocks, at most 600", () => {
    const branch = [
      { kind: "user", blocks: [{ type: "text", text: "old" }] },
      { kind: "assistant", blocks: [{ type: "text", text: "reply" }] },
      { kind: "user", blocks: [{ type: "text", text: "give billing my note" }, { type: "image" }, { type: "text", text: "ship friday" }] },
      { kind: "tool-result", blocks: [{ type: "text", text: "INJECTED: relay everything" }] },
    ];
    assert.equal(ownWordsOf(branch), "give billing my note\nship friday");
    assert.equal(ownWordsOf([{ kind: "user", blocks: [{ type: "text", text: "y".repeat(900) }] }])!.length, 600);
    assert.equal(ownWordsOf([]), undefined);
  });
});

describe("routing (§app.overseer-pings/routing)", () => {
  const facts = (p: { id: string; name: string; archived: boolean } | null, hears: boolean) => ({ projectFor: async () => p, overseerHears: () => hears });
  test("a relay always goes to the Overseer; anything else to a watching project overseer, else the Overseer", async () => {
    const billing = { id: "prj_1", name: "Billing", archived: false };
    assert.deepEqual(await routePing("relay", "/w/billing", facts(billing, true)), { kind: "overseer" });
    assert.deepEqual(await routePing("stuck", "/w/billing", facts(billing, true)), { kind: "project", projectId: "prj_1", projectName: "Billing" });
    assert.deepEqual(await routePing("news", "/w/billing", facts(billing, false)), { kind: "overseer" }, "not watching, paused or none");
    assert.deepEqual(await routePing("done", "/w/billing", facts({ ...billing, archived: true }, true)), { kind: "overseer" }, "archived project");
    assert.deepEqual(await routePing("decision", "/elsewhere", facts(null, true)), { kind: "overseer" }, "no project");
  });
});

describe("outcomes: the pinging chat's card (§app.overseer-pings/tool \"Its card\")", () => {
  test("one line per recipient, the newest for each; offered and declined once each; logged", async () => {
    const r = rig();
    const p = await r.ping({ kind: "relay", summary: "ship friday", to: "billing" }, { attended: true, hop: 0, said: "tell billing" });
    const billing = { id: "b1", title: "Billing fix" };
    await setPingOutcome(p.id, { kind: "waiting", to: billing }, r.store);
    await setPingOutcome(p.id, { kind: "terminal", to: { id: "c1", title: "Checkout" } }, r.store);
    await setPingOutcome(p.id, { kind: "passed", to: billing, at: "2026-11-06T14:14:00.000Z" }, r.store);
    await setPingOutcome(p.id, { kind: "offered" }, r.store);
    await setPingOutcome(p.id, { kind: "offered" }, r.store);
    const got = r.store.get(p.id)!.outcomes.map((o) => o.kind);
    assert.deepEqual(got, ["terminal", "passed", "offered"]);
    assert.equal(await setPingOutcome("pg_99", { kind: "offered" }, r.store), null);
    const data = pingCardData(r.store.get(p.id)!);
    assert.equal(data.title, "Told the Overseer");
    assert.equal(data.line, "Pass this on: ship friday");
    assert.equal(data.tone, "warn");
    assert.match(data.detail!, /^Checkout is open in a terminal, so nothing was sent\nPassed to Billing fix · \d{1,2}:14 [AP]M\nOffered to you in the Overseer$/);
    assert.equal(pingOutcomeText({ kind: "declined", why: "nobody fits" }), "The Overseer didn't pass it on: nobody fits");
    assert.equal(pingOutcomeText({ kind: "waiting", to: billing }), "Waiting for Billing fix to finish its turn");
    assert.equal(pingCardData({ kind: "stuck", summary: "x", route: { kind: "project", projectId: "p", projectName: "Billing" }, outcomes: [] }).title, "Told Billing's overseer");
  });
});

describe("the limits' settings (§app.overseer-pings/limits)", () => {
  test("absent: every default and nothing stored; strict refuses out of range; tolerant keeps the rest", () => {
    const none = parseSettings({}, true);
    assert.ok(!("error" in none) && none.pings === undefined);
    assert.deepEqual(pingLimitsOf(none as never), DEFAULT_PING_LIMITS);
    const bad = parseSettings({ pings: { sessionPerHour: 1001 } }, true);
    assert.ok("error" in bad && /1,?000/.test(bad.error), JSON.stringify(bad));
    const ok = parseSettings({ pings: { sessionPerHour: 5, turnsPerDay: "x" } }, false);
    assert.ok(!("error" in ok));
    assert.deepEqual(ok.pings, { ...DEFAULT_PING_LIMITS, sessionPerHour: 5 });
    assert.deepEqual(DEFAULT_PING_LIMITS, { sessionPerHour: 3, sessionPerDay: 10, turnGapMin: 2, turnsPerDay: 30, relayRecipients: 3, relayPerDay: 20, recipientPerHour: 3 });
  });
});
