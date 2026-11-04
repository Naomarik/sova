// What a reader of the host sees, now that warm sessions are converted once and shared: every kind of
// engine change shows on the very next read, an unchanged host converts nothing, and nobody can change
// what is shared.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { createStatecharts, type EngineOptions, type Statecharts } from "../statecharts";
import { ENGINE_CALLS, OrgHost, type OrgHostOptions } from "./index";
import { scanSnapshots } from "./store";
import { HOST_STATECHARTS } from "./test-statechart";

type Data = Record<string, unknown>;
const assign = (data: Data) => [{ op: "assign", data }];
const operator = { by: "operator" };

/** Reads the host from inside its own step (as a stamp does), and counts its resumes. */
let reader: ((d: Data) => void) | null = null;
const READER = [
  "statechart",
  {},
  [
    "state",
    { id: "top" },
    ["transition", { event: "bump" }, ["script", { expr: (d: Data) => assign({ n: ((d["n"] as number) ?? 0) + 1 }) }], ["send", { event: "look" }]],
    ["transition", { event: "look" }, ["script", { expr: (d: Data) => (reader?.(d), []) }]],
    ["transition", { event: "sova/resumed" }, ["script", { expr: (d: Data) => assign({ resumes: ((d["resumes"] as number) ?? 0) + 1 }) }], ["send", { event: "ping", targetexpr: (d: Data) => d["pings"] ?? d["_sessionid"] }]],
    ["transition", { event: "ping" }, ["script", { expr: (d: Data) => assign({ pinged: true }) }]],
  ],
];

const dirs: string[] = [];
afterEach(() => {
  reader = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function place() {
  const root = mkdtempSync(join(tmpdir(), "org-host-reads-"));
  dirs.push(root);
  return { workspaceDir: join(root, "ws"), stateDir: join(root, "state") };
}

function open(where: ReturnType<typeof place>, more: Partial<OrgHostOptions> = {}) {
  const statecharts = { ...HOST_STATECHARTS, reader: { version: 1, storage: "portable", statechart: READER } };
  return OrgHost.open({ orgId: "o1", ...where, durable: false, statecharts: statecharts as unknown as EngineOptions["statecharts"], ...more });
}

/** Counts the host's conversions of a session's data out of the engine. */
function conversions(host: OrgHost): { count: number } {
  const engine = (host as unknown as { engine: Statecharts }).engine;
  const data = engine.data;
  const seen = { count: 0 };
  engine.data = (sid) => {
    seen.count++;
    return data(sid);
  };
  return seen;
}

/** What each way of reading says of one session. */
const seen = (host: OrgHost, sid: string) => ({
  data: host.data(sid),
  configuration: host.configuration(sid),
  listed: host.sessions().find((s) => s.id === sid),
  ofItsKind: host.sessions(host.statechartOf(sid) ?? undefined).find((s) => s.id === sid),
});

function assertAllSay(host: OrgHost, sid: string, key: string, value: unknown, configuration?: string[]): void {
  const s = seen(host, sid);
  assert.equal(s.data?.[key], value, "data");
  assert.equal(s.listed?.data[key], value, "sessions()");
  assert.equal(s.ofItsKind?.data[key], value, "sessions(statechart)");
  if (configuration) {
    assert.deepEqual(s.configuration, configuration, "configuration");
    assert.deepEqual(s.listed?.configuration, configuration, "sessions() configuration");
  }
}

describe("org host reads", () => {
  test("an unchanged host converts nothing, however often and however it is read, trials included", async () => {
    const host = await open(place());
    await host.start("p/1", "host-probe", {}, operator);
    await host.start("p/2", "host-probe", {}, operator);
    seen(host, "p/1");
    seen(host, "p/2");
    const count = conversions(host);
    for (let i = 0; i < 20; i++) {
      seen(host, "p/1");
      seen(host, "p/2");
      host.sessions("host-probe", { warmOnly: true });
      host.trial("p/1", "count", {}, operator);
      host.explain("p/1", "count", {}, operator);
      host.enabledEvents("p/1", operator);
    }
    assert.equal(count.count, 0);
    await host.act("p/1", "count", {}, operator);
    assert.equal(host.data("p/1")?.["n"], 1);
    assert.ok(count.count > 0, "the count sees a real conversion: a step made one");
    await host.close();
  });

  test("an act shows on the next read, every way of reading", async () => {
    const host = await open(place());
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "count", {}, operator);
    assertAllSay(host, "p/1", "n", 1, ["top", "idle"]);
    await host.act("p/1", "count", {}, operator);
    await host.act("p/1", "gather/start", {}, operator);
    assertAllSay(host, "p/1", "n", 2, ["top", "gathering"]);
    await host.close();
  });

  test("a step of one session shows while the other session's reading is still good, and a new session is listed", async () => {
    const host = await open(place());
    await host.start("p/2", "host-probe", {}, operator);
    seen(host, "p/2");
    await host.start("p/1", "host-probe", {}, operator);
    assert.deepEqual(host.sessions("host-probe").map((s) => s.id), ["p/1", "p/2"], "sorted by id, the newest included");
    assert.deepEqual(host.sessions().map((s) => s.id), ["p/1", "p/2"]);
    await host.start("l/1", "host-local-probe", {}, operator);
    assert.deepEqual(host.sessions().map((s) => s.id), ["l/1", "p/1", "p/2"]);
    assert.deepEqual(host.sessions("host-probe").map((s) => s.id), ["p/1", "p/2"], "of its statechart only");
    await host.act("p/2", "count", {}, operator);
    assertAllSay(host, "p/2", "n", 1);
    await host.close();
  });

  test("rows sort as they always did: by locale, not by code unit", async () => {
    const host = await open(place());
    await host.start("p/B", "host-probe", {}, operator);
    await host.start("p/a", "host-probe", {}, operator);
    assert.deepEqual(host.sessions("host-probe").map((s) => s.id), ["p/a", "p/B"]);
    await host.close();
  });

  test("an effect's answer, a step no reader asked for, shows", async () => {
    let answered = false;
    const host = await open(place());
    host.effects.register("write", async () => {
      answered = true;
      return { ok: true };
    });
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "go", {}, operator, { settle: true });
    assert.equal(answered, true);
    assertAllSay(host, "p/1", "done", 1, ["top", "idle"]);
    await host.close();
  });

  test("a timer's step shows", async () => {
    let now = 1_000_000;
    const host = await open(place(), { clock: () => now });
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "wait", {}, operator);
    assert.deepEqual(seen(host, "p/1").configuration, ["top", "timed"]);
    now += 60;
    host.fireDue();
    assert.deepEqual(seen(host, "p/1").configuration, ["top", "idle"]);
    await host.close();
  });

  test("a free set-state shows", async () => {
    const host = await open(place());
    await host.start("p/1", "host-probe", {}, operator);
    assert.deepEqual(seen(host, "p/1").configuration, ["top", "idle"]);
    const r = await host.setState("p/1", { states: ["gathering"], patch: { n: 7 }, reason: "test" }, { by: "overseer", attended: true });
    assert.equal(r.taken, true, r.refusal?.sentence);
    assertAllSay(host, "p/1", "n", 7, ["top", "gathering"]);
    await host.close();
  });

  test("a read inside a step sees that step's state, and nothing it read outlives the call", async () => {
    const host = await open(place());
    await host.start("r/1", "reader", {}, operator);
    await host.act("r/1", "bump", {}, operator);
    assert.equal(host.data("r/1")?.["n"], 1);
    assert.equal(host.sessions("reader")[0]?.data["n"], 1);
    assert.equal(host.sessions()[0]?.data["n"], 1);
    const inside: unknown[] = [];
    reader = () => {
      inside.push(host.data("r/1")?.["n"], host.sessions("reader")[0]?.data["n"], host.sessions()[0]?.data["n"]);
    };
    await host.act("r/1", "bump", {}, operator);
    assert.deepEqual(inside, [2, 2, 2], "the step's own state, not the reading from before it");
    assert.equal(host.data("r/1")?.["n"], 2);
    inside.length = 0;
    host.trial("r/1", "bump", {}, operator);
    assert.deepEqual(inside, [3, 3, 3], "a trial's own state");
    assertAllSay(host, "r/1", "n", 2);
    await host.close();
  });

  test("a step that can't be saved reads as if it never ran, even when something read it before the save failed", async () => {
    let fail = false;
    let during: unknown;
    let host: OrgHost | null = null;
    const opened: OrgHost = await open(place(), {
      commitHooks: {
        beforeJournal: () => {
          if (!fail) return;
          during = host?.data("p/1")?.["n"];
          host?.sessions("host-probe");
          throw new Error("no space left");
        },
      },
    });
    host = opened;
    await opened.start("p/1", "host-probe", {}, operator);
    await opened.act("p/1", "count", {}, operator);
    fail = true;
    assert.match((await opened.act("p/1", "count", {}, operator)).refusal?.sentence ?? "", /^History can't be saved/);
    assert.equal(during, 2, "the commit read the step");
    assertAllSay(opened, "p/1", "n", 1);
    await opened.close();
  });

  test("going cold keeps a session readable from its file, a change to that file shows, and an event brings it back warm", async () => {
    const at = place();
    let now = 1_000_000;
    const host = await open(at, { clock: () => now });
    await host.start("l/1", "host-local-probe", {}, operator);
    await host.start("l/2", "host-local-probe", {}, operator);
    await host.start("l/0", "host-local-probe", {}, operator);
    await host.act("l/1", "gather/start", {}, operator);
    await host.act("l/1", "count", {}, operator);
    seen(host, "l/1");
    now += 86_400_000;
    assert.deepEqual(host.sweepCold(), ["l/1"]);
    assert.deepEqual(host.sessions("host-local-probe", { warmOnly: true }).map((s) => s.id), ["l/0", "l/2"], "unloaded, gone from the warm rows");
    assert.deepEqual(host.sessions("host-local-probe").map((s) => s.id), ["l/0", "l/1", "l/2"], "a cold row takes its place in the order");
    assertAllSay(host, "l/1", "n", 1, ["top", "gathering"]);
    const file = scanSnapshots(host.paths.local).find((x) => x.sid === "l/1")!.file;
    const before = readFileSync(file, "utf8");
    writeFileSync(file, before.replace(":gathering", ":idle"));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.deepEqual(seen(host, "l/1").configuration, ["top", "idle"], "a cold session follows its file, with no wait");
    writeFileSync(file, before);
    utimesSync(file, new Date(), new Date(Date.now() + 10000));
    await host.act("l/1", "gather/close", {}, operator);
    assertAllSay(host, "l/1", "n", 1, ["top", "idle"]);
    assert.deepEqual(host.sessions("host-local-probe", { warmOnly: true }).map((s) => s.id), ["l/0", "l/1", "l/2"]);
    await host.close();
  });

  test("a reopened host reads what was saved after the host before it read", async () => {
    const at = place();
    const first = await open(at);
    await first.start("p/1", "host-probe", {}, operator);
    await first.act("p/1", "count", {}, operator);
    assertAllSay(first, "p/1", "n", 1);
    await first.close();
    const second = await open(at);
    assertAllSay(second, "p/1", "n", 1);
    await second.act("p/1", "count", {}, operator);
    await second.close();
    const third = await open(at);
    assertAllSay(third, "p/1", "n", 2);
    await third.close();
  });

  test("reload shows what it loaded and what it resumed", async () => {
    const at = place();
    const first = await open(at);
    await first.start("r/2", "reader", { pings: "r/2" }, operator);
    await first.start("r/1", "reader", { pings: "r/2" }, operator);
    await first.close();
    const file = scanSnapshots(join(at.workspaceDir, "statecharts")).find((s) => s.sid === "r/2")!.file;
    const good = readFileSync(file, "utf8");
    writeFileSync(file, "<<<<<<< HEAD\n{:broken");
    const host = await open(at);
    assert.deepEqual(host.problems().map((p) => [p.kind, p.sessionId]).sort(), [["resume", "r/1"], ["snapshot", "r/2"]]);
    assert.deepEqual(host.sessions().map((s) => s.id), ["r/1"], "a broken session isn't listed");
    assert.equal(host.data("r/1")?.["resumes"] ?? 0, 0, "its resume was rolled back");
    writeFileSync(file, good);
    assert.deepEqual(await host.reload(), []);
    assert.deepEqual(host.sessions().map((s) => s.id), ["r/1", "r/2"], "reload's load shows");
    assertAllSay(host, "r/1", "resumes", 1);
    await host.close();
  });

  test("reload resuming a session it didn't load shows that resume", async () => {
    const at = place();
    const first = await open(at);
    await first.start("r/1", "reader", { pings: "r/late" }, operator);
    await first.close();
    const host = await open(at);
    assert.deepEqual(host.problems().map((p) => [p.kind, p.sessionId]), [["resume", "r/1"]], "the session it reaches doesn't exist yet");
    await host.start("r/late", "reader", {}, operator);
    assertAllSay(host, "r/1", "resumes", undefined);
    assert.deepEqual(await host.reload(), []);
    assertAllSay(host, "r/1", "resumes", 1);
    await host.close();
  });

  test("every engine call that can change a session drops the readings, a call that throws included", async () => {
    const host = await open(place());
    await host.start("p/1", "host-probe", {}, operator);
    const engine = (host as unknown as { engine: Record<string, (...args: unknown[]) => unknown> }).engine;
    const data = engine["data"]!;
    let conversions = 0;
    engine["data"] = (...args) => {
      conversions++;
      return data(...args);
    };
    // the method is what's under test: each is called on nothing, so it changes nothing here
    for (const call of ["start", "send", "setState", "resume", "renotify", "fireDue", "load", "unload", "setAside"]) {
      host.data("p/1");
      conversions = 0;
      try {
        engine[call]!("no/such", "no/such", {}, {});
      } catch {
        // refused: it counts all the same
      }
      host.data("p/1");
      assert.equal(conversions, 1, call);
    }
    await host.close();
  });

  test("adopted sessions show", async () => {
    const at = place();
    const first = await open(at);
    await first.start("p/1", "host-probe", {}, operator);
    await first.close();
    const host = await open(at);
    assert.deepEqual(host.sessions().map((s) => s.id), ["p/1"]);
    const file = scanSnapshots(join(at.workspaceDir, "statecharts")).find((s) => s.sid === "p/1")!.file;
    writeFileSync(file.replace("p%2F1", "p%2F2"), readFileSync(file, "utf8"));
    await host.adopt(["p/2"]);
    assert.deepEqual(host.sessions().map((s) => s.id), ["p/1", "p/2"]);
    await host.close();
  });

  test("what a read hands out can't be changed by its reader, and stays as it was after a step; the list itself is the reader's", async () => {
    const at = place();
    let now = 1_000_000;
    const host = await open(at, { clock: () => now });
    await host.start("l/1", "host-local-probe", {}, operator);
    await host.start("p/1", "host-probe", { deep: { list: [{ a: 1 }] } }, operator);
    await host.act("p/1", "count", {}, operator);
    const held = host.sessions("host-probe")[0]!;
    assert.throws(() => (held.data["n"] = 99), TypeError);
    assert.throws(() => (host.data("p/1")!["n"] = 99), TypeError);
    assert.throws(() => ((host.data("p/1")!["deep"] as { list: { a: number }[] }).list[0]!.a = 99), TypeError);
    assert.throws(() => host.configuration("p/1")!.sort(), TypeError);
    assert.throws(() => (held.running = false), TypeError);
    const list = host.sessions("host-probe");
    list.reverse();
    list.length = 0;
    assert.deepEqual(host.sessions("host-probe").map((s) => s.id), ["p/1"], "a caller's sort or edit of the list stays its own");
    await host.act("p/1", "count", {}, operator);
    assert.equal(held.data["n"], 1, "a reading already handed out doesn't move");
    assert.equal(host.data("p/1")?.["n"], 2);
    await host.act("l/1", "gather/start", {}, operator);
    now += 86_400_000;
    assert.deepEqual(host.sweepCold(), ["l/1"]);
    assert.throws(() => (host.data("l/1")!["n"] = 99), TypeError, "a cold reading is shared too");
    await host.close();
  });

  test("every engine method is declared in ENGINE_CALLS, the bundle's own included (a rebuilt bundle can add one the types don't name)", () => {
    assert.deepEqual(Object.keys(ENGINE_CALLS).sort(), Object.keys(createStatecharts()).sort());
  });
});
