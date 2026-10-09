// Run: pnpm exec tsx --test server/org-host/host.test.ts. The org host over the vendored engine, on
// a runtime JS test statechart (test-statechart.ts), in temp dirs: snapshots, the redo journal and its replay,
// the log and its privacy, effects (answered once, re-run at open), holds, invocations, timers,
// workspace problems.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { EngineOptions } from "../statecharts";
import { OrgHost, OrgPayloadError, type OrgHostOptions } from "./index";
import { verifyOrg } from "./rebuild";
import { scanSnapshots } from "./store";
import { HOST_STATECHARTS } from "./test-statechart";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function place() {
  const root = mkdtempSync(join(tmpdir(), "org-host-"));
  dirs.push(root);
  return { workspaceDir: join(root, "ws"), stateDir: join(root, "state") };
}

function open(where: { workspaceDir: string; stateDir: string }, more: Partial<OrgHostOptions> = {}) {
  return OrgHost.open({ orgId: "o1", ...where, durable: false, statecharts: HOST_STATECHARTS as unknown as EngineOptions["statecharts"], ...more });
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Poll until `ok` holds, for what runs on the host's own real timers; the guard only stops a hang. */
async function until(ok: () => boolean, what: string, guardMs = 30_000): Promise<void> {
  const end = Date.now() + guardMs;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`still waiting after ${guardMs} ms: ${what}`);
    await tick(5);
  }
}
const operator = { by: "operator" };

describe("org host", () => {
  test("a step's snapshot lands in its storage place, its row in the log, and no journal is left", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", {}, operator);
    await host.start("l/1", "host-local-probe", {}, operator);
    const r = await host.act("p/1", "count", {}, operator);
    assert.equal(r.taken, true);
    assert.deepEqual(scanSnapshots(join(at.workspaceDir, "statecharts")).map((s) => s.sid), ["p/1"]);
    assert.deepEqual(scanSnapshots(host.paths.local).map((s) => s.sid), ["l/1"]);
    assert.deepEqual(readdirSync(host.paths.journal), []);
    const rows = host.log.rows({ session: "p/1" });
    assert.deepEqual(rows.map((x) => x.event), ["sova/started", "count"]);
    assert.deepEqual(host.log.rows({ session: "l/1" }).map((x) => x.event), ["sova/started"]);
    assert.ok(!existsSync(join(at.workspaceDir, "statecharts", "log")) || !readdirSync(join(at.workspaceDir, "statecharts", "log")).some((f) => readFileSync(join(at.workspaceDir, "statecharts", "log", f), "utf8").includes('"l/1"')), "a host-local session never logs into the repo");
    await host.close();
    const again = await open(at);
    assert.deepEqual(again.configuration("p/1"), ["top", "idle"]);
    assert.equal(again.data("p/1")?.["n"], 1);
    await again.close();
  });

  test("log rows: `at` unique, contact and text scrubbed, tokens dropped, refusals without their tail", async () => {
    const at = place();
    const host = await open(at, { clock: () => 5_000 });
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "count", { contact: { email: "ana@example.org" }, text: "the person's own words", token: "tkn-123" }, operator);
    await host.act("p/1", "count", {}, operator);
    const rows = host.log.rows();
    assert.equal(new Set(rows.map((r) => r.at)).size, rows.length, "every row's at is unique");
    const raw = readdirSync(host.paths.portableLog).map((f) => readFileSync(join(host.paths.portableLog, f), "utf8")).join("");
    assert.ok(!raw.includes("ana@example.org") && !raw.includes("own words") && !raw.includes("tkn-123"));
    const env = rows[1]!.envelope as Record<string, unknown>;
    assert.equal(env["contact"], "[contact]");
    assert.deepEqual(Object.keys(env["text"] as object).sort(), ["len", "sha"]);
    assert.ok(!("token" in env));
    await host.logAct({ event: "note/add", by: "overseer", session: null, text: "a note's words" });
    assert.equal(host.log.rows({ newestFirst: true, limit: 1 })[0]?.event, "note/add");
    assert.equal(host.log.row(rows[0]!.at)?.event, "sova/started");
    await host.close();
  });

  test("an effect runs after the commit, its answer comes back once, and settle waits for it", async () => {
    const at = place();
    const host = await open(at);
    const seen: string[] = [];
    host.effects.register("write", async (e) => {
      seen.push(e.key);
      return { wrote: e["n"] };
    });
    await host.start("p/1", "host-probe", {}, operator);
    const r = await host.act("p/1", "go", {}, operator, { settle: true });
    assert.equal(seen.length, 1);
    assert.deepEqual(r.effects, [{ kind: "write", key: seen[0], result: { wrote: 0 } }]);
    assert.deepEqual(host.configuration("p/1"), ["top", "idle"]);
    assert.equal(host.data("p/1")?.["done"], 1);
    assert.deepEqual(host.data("p/1")?.["sova/pending"], {});
    await host.close();
  });

  test("a big org opens in chunks: loading and resume each give the event loop a turn every `chunk` sessions (C09; timed in bench.integration)", async () => {
    const at = place();
    const host = await open(at);
    for (let i = 0; i < 60; i++) await host.start(`p/${i}`, "host-probe", {}, operator);
    await host.close();
    // Counts the event loop's turns while open runs: one per setImmediate the boot yields with.
    let turns = 0;
    let counting = true;
    const count = () => {
      if (!counting) return;
      turns++;
      setImmediate(count);
    };
    setImmediate(count);
    const again = await open(at, { chunk: 10 });
    counting = false;
    assert.equal(again.sessions().length, 60);
    assert.ok(turns >= 12, `${turns} turns: 6 loading chunks and 6 resume chunks each yield`);
    await again.close();
  });

  test("idle waits for the effects and invocation reports in flight, not for a run still going", async () => {
    const at = place();
    const host = await open(at);
    let answer: () => void = () => {};
    host.effects.register("write", () => new Promise((r) => (answer = () => r(null))));
    let report: () => void = () => {};
    host.invocations.register("sova/look", { start: (_inv, rep) => void (report = () => rep("finished")), stop: () => {} });
    await host.start("p/1", "host-probe", {}, operator);
    await host.start("p/2", "host-probe", {}, operator);
    await host.act("p/1", "go", {}, operator);
    await host.act("p/2", "look", {}, operator);
    let idle = false;
    const waited = host.idle().then(() => (idle = true));
    await tick();
    assert.equal(idle, false, "the effect's handler is still out");
    answer();
    await waited;
    assert.deepEqual(host.configuration("p/1"), ["top", "idle"], "its answer stepped before idle resolved");
    assert.deepEqual(host.configuration("p/2"), ["top", "looking"], "a look still running is not waited for");
    report();
    await host.idle();
    assert.deepEqual(host.configuration("p/2"), ["top", "idle"], "the report's step happened before idle resolved");
    await host.close();
  });

  test("an effect left pending at a crash runs again at open, with the same key", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "go", {}, operator); // no handler on this host: it stays pending
    const key = Object.keys(host.data("p/1")?.["sova/pending"] as object)[0];
    assert.ok(key);
    await host.close();
    const again = await open(at);
    const seen: string[] = [];
    again.effects.register("write", async (e) => {
      seen.push(e.key);
      return null;
    });
    await again.idle();
    assert.deepEqual(seen, [key]);
    assert.deepEqual(again.configuration("p/1"), ["top", "idle"]);
    await again.close();
  });

  test("a failed effect answers effect/failed", async () => {
    const at = place();
    const host = await open(at);
    host.effects.register("write", async () => {
      throw new Error("the disk is full");
    });
    await host.start("p/1", "host-probe", {}, operator);
    const r = await host.act("p/1", "go", {}, operator, { settle: true });
    assert.deepEqual(r.effects?.map((e) => e.error), ["the disk is full"]);
    assert.equal(host.data("p/1")?.["failed"], 1);
    await host.close();
  });

  test("an unattended overseer act waits in a hold; at its end it is stamped afresh and goes ahead", async () => {
    const at = place();
    const stamps: unknown[] = [];
    let now = 1_000_000;
    const host = await open(at, {
      clock: () => now,
      stamp: (sid, event, _payload, who) => {
        stamps.push([sid, event, who]);
        return { by: "overseer", attended: false };
      },
    });
    await host.start("p/1", "host-probe", {}, operator);
    const r = await host.act("p/1", "gather/start", {}, { by: "overseer", attended: false, holdMs: 40, projectId: "prj1", overseerId: "po1" });
    assert.equal(r.taken, true);
    assert.equal(r.held?.what, "Gathering");
    assert.equal(r.held?.sessionId, "p/1", "a Hold, as host.holds() lists it");
    assert.deepEqual(r.held, host.holds()[0]);
    assert.deepEqual(host.holds().map((h) => h.id), ["gather/start#0"]);
    assert.deepEqual(host.configuration("p/1"), ["top", "idle"]);
    now += 40;
    host.fireDue();
    assert.deepEqual(stamps, [["p/1", "gather/start", { by: "overseer", overseerId: "po1", projectId: "prj1" }]]);
    assert.deepEqual(host.configuration("p/1"), ["top", "gathering"]);
    assert.deepEqual(host.holds(), []);
    assert.equal(host.log.rows({ session: "p/1" }).find((x) => x.held)?.held?.id, "gather/start#0");
    await host.close();
  });

  test("the operator's own click and an attended turn are never held", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", {}, operator);
    const r = await host.act("p/1", "gather/start", {}, { by: "overseer", attended: true, holdMs: 40 });
    assert.equal(r.held, undefined);
    assert.deepEqual(host.configuration("p/1"), ["top", "gathering"]);
    await host.close();
  });

  test("an invocation report carries its data into the result event", async () => {
    const at = place();
    const host = await open(at);
    host.invocations.register("sova/look", {
      start: (_inv, report) => setTimeout(() => report("finished", undefined, { applied: 2, refused: [{ field: "role" }] }), 5),
      stop: () => {},
    });
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "look", {}, operator);
    await until(() => host.log.rows({ session: "p/1" }).some((r) => r.event === "look/finished"), "the report's step");
    const row = host.log.rows({ session: "p/1" }).find((r) => r.event === "look/finished");
    assert.deepEqual({ applied: (row?.envelope as Record<string, unknown>)["applied"], refused: (row?.envelope as Record<string, unknown>)["refused"] }, { applied: 2, refused: [{ field: "role" }] });
    await host.close();
  });

  test("an invocation runs with its run id and its report moves the statechart", async () => {
    const at = place();
    const host = await open(at);
    const runs: string[] = [];
    host.invocations.register("sova/look", {
      start: (inv, report) => {
        runs.push(inv.invokeId);
        setTimeout(() => report("finished"), 5);
      },
      stop: () => {},
    });
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "look", {}, operator);
    assert.equal(runs.length, 1);
    assert.match(runs[0]!, /^p\/1#look#\d+$/);
    await until(() => host.configuration("p/1")?.[1] === "idle", "the report's step");
    assert.deepEqual(host.configuration("p/1"), ["top", "idle"]);
    await host.close();
  });

  test("nextDueAt and fireDue drive timers on a virtual clock", async () => {
    const at = place();
    let now = 1_000_000;
    const host = await open(at, { clock: () => now });
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "wait", {}, operator);
    assert.equal(host.nextDueAt(), now + 50);
    assert.deepEqual(host.fireDue().steps, [], "not due yet");
    now += 50;
    assert.deepEqual(host.fireDue().steps.map((s) => s.event), ["tick"]);
    assert.deepEqual(host.configuration("p/1"), ["top", "idle"]);
    assert.equal(host.nextDueAt(), null);
    await host.close();
  });

  test("timers fire on their own from nextDueAt", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "wait", {}, operator);
    assert.deepEqual(host.configuration("p/1"), ["top", "timed"]);
    await until(() => host.configuration("p/1")?.[1] === "idle", "the host's own timer");
    assert.deepEqual(host.configuration("p/1"), ["top", "idle"]);
    await host.close();
  });

  test("a crash after the journal was written: open applies it (snapshot and row, once)", async () => {
    const at = place();
    let crash = false;
    // the in-process retry fails too (as when the process dies here): the journal is left for the next open
    const host = await open(at, { commitHooks: { afterJournal: () => { if (crash) throw new Error("killed"); }, retryApply: () => { if (crash) throw new Error("killed"); } } });
    await host.start("p/1", "host-probe", {}, operator);
    crash = true;
    // the journal holds the step: never refused, it takes effect when the journal is applied
    assert.equal(host.actNow("p/1", "count", {}, operator).refusal?.stage, "pending-apply");
    await host.close();
    assert.equal(readdirSync(host.paths.journal).length, 1, "the journal is left behind");
    const again = await open(at);
    assert.equal(again.data("p/1")?.["n"], 1, "the redo journal was applied at open");
    assert.equal(again.log.rows({ session: "p/1" }).filter((r) => r.event === "count").length, 1, "its row was appended once");
    assert.deepEqual(readdirSync(again.paths.journal), []);
    await again.close();
  });

  test("a crash after applying but before deleting the journal appends its rows only once", async () => {
    const at = place();
    let crash = false;
    // the in-process retry fails too (as when the process dies here): the journal is left for the next open
    const host = await open(at, { commitHooks: { afterApply: () => { if (crash) throw new Error("killed"); }, retryApply: () => { if (crash) throw new Error("killed"); } } });
    await host.start("p/1", "host-probe", {}, operator);
    crash = true;
    // the journal holds the step: never refused, it takes effect when the journal is applied
    assert.equal(host.actNow("p/1", "count", {}, operator).refusal?.stage, "pending-apply");
    await host.close();
    const again = await open(at);
    assert.equal(again.log.rows({ session: "p/1" }).filter((r) => r.event === "count").length, 1);
    await again.close();
  });

  test("a snapshot that doesn't load is a workspace problem: the rest loads, events to it are refused", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", {}, operator);
    await host.start("p/2", "host-probe", {}, operator);
    await host.close();
    const file = scanSnapshots(join(at.workspaceDir, "statecharts")).find((s) => s.sid === "p/2")!.file;
    writeFileSync(file, "<<<<<<< HEAD\n{:broken");
    const again = await open(at);
    assert.deepEqual(again.problems().map((p) => [p.kind, p.sessionId]), [["snapshot", "p/2"]]);
    assert.deepEqual(again.configuration("p/1"), ["top", "idle"]);
    const r = await again.act("p/2", "count", {}, operator);
    assert.equal(r.taken, false);
    assert.match(r.refusal!.sentence, /^The workspace repo has a problem: .*p%2F2\.edn can't be read\. Fix or restore it, then reload\.$/);
    assert.equal(readFileSync(file, "utf8"), "<<<<<<< HEAD\n{:broken", "nothing overwrites the broken file");
    await again.close();
  });

  test("a journal that doesn't parse stops the org: every event is refused until it is fixed", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", {}, operator);
    await host.close();
    writeFileSync(join(host.paths.journal, "000000000000001-1-000001.json"), "{not json");
    const again = await open(at);
    assert.equal(again.problems()[0]?.kind, "journal");
    const r = await again.act("p/1", "count", {}, operator);
    assert.equal(r.taken, false);
    assert.equal(r.refusal?.code, "workspace");
    rmSync(join(host.paths.journal, "000000000000001-1-000001.json"));
    assert.deepEqual(await again.reload(), []);
    assert.equal((await again.act("p/1", "count", {}, operator)).taken, true);
    await again.close();
  });

  test("markers in every private key (a statechart's own included) reach no row: taken, refused and held acts", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", {}, operator);
    const M = { about: "MARK-about", message: "MARK-message", text: "MARK-text", email: "MARK-email", phone: "MARK-phone", token: "MARK-token", secretish: "MARK-secretish", quote: "MARK-quote" };
    const payload = { ...M, patch: { contact: { email: "MARK-nested" } } };
    assert.equal((await host.act("p/1", "count", payload, operator)).taken, true);
    assert.equal((await host.act("p/1", "gather/start", payload, { by: "overseer", attended: false, holdMs: 60_000 })).held?.id, "gather/start#0");
    await host.act("p/1", "gather/start", {}, operator);
    const refused = await host.act("p/1", "gather/start", payload, operator);
    assert.equal(refused.taken, false);
    const raw = readdirSync(host.paths.portableLog).map((f) => readFileSync(join(host.paths.portableLog, f), "utf8")).join("");
    const reads = JSON.stringify(host.log.rows());
    for (const m of [...Object.values(M), "MARK-nested"]) {
      assert.ok(!raw.includes(m), `${m} is in no log segment`);
      assert.ok(!reads.includes(m), `${m} is in no log read`);
    }
    const row = host.log.rows({ session: "p/1" }).find((r) => r.event === "count")!;
    const env = row.envelope as Record<string, unknown>;
    for (const k of ["about", "message", "text", "quote"]) assert.deepEqual(Object.keys(env[k] as object).sort(), ["len", "sha"], `${k} is a digest`);
    assert.equal(env["email"], "[contact]");
    assert.equal(env["phone"], "[contact]");
    assert.ok(!("token" in env) && !("secretish" in env), "dropped keys, the statechart's own included");
    await host.close();
  });

  test("a refused act appends exactly one row, with its sentence and no tail", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "gather/start", {}, operator);
    const before = host.log.rows().length;
    const r = await host.act("p/1", "gather/start", {}, operator);
    assert.equal(r.taken, false);
    const rows = host.log.rows();
    assert.equal(rows.length, before + 1);
    assert.equal(rows.at(-1)?.refused, r.refusal?.sentence);
    assert.equal(rows.at(-1)?.refusedStage, "state");
    await host.close();
  });

  test("onChange hears every committed batch with the sessions it touched", async () => {
    const at = place();
    const host = await open(at);
    const heard: { sessions: string[]; events: string[] }[] = [];
    host.onChange((c) => heard.push({ sessions: c.sessions, events: c.steps.map((s) => s.event) }));
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "count", {}, operator);
    assert.deepEqual(heard, [
      { sessions: ["p/1"], events: ["sova/started"] },
      { sessions: ["p/1"], events: ["count"] },
    ]);
    await host.close();
  });

  test("a timer that came due while the host was closed fires during open, before any timer tick", async () => {
    const at = place();
    let now = 1_000_000;
    const host = await open(at, { clock: () => now });
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "wait", {}, operator);
    await host.close();
    now += 80;
    const again = await open(at, { clock: () => now });
    assert.deepEqual(again.configuration("p/1"), ["top", "idle"], "fired inside open");
    assert.equal(again.log.rows({ session: "p/1" }).at(-1)?.event, "tick");
    await again.close();
  });

  test("a project's feed: its sessions' feed rows (quiet ones on request), redacted like the log", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", { projectId: "prj1" }, operator);
    await host.start("p/2", "host-probe", { projectId: "prj2" }, operator);
    await host.act("p/1", "count", { contact: { email: "MARK-feed@example.org" } }, operator);
    await host.act("p/1", "gather/start", {}, operator);
    await host.act("p/2", "gather/start", {}, operator);
    const feed = host.feed("prj1");
    assert.deepEqual(feed.map((e) => e.event), ["sova/started", "count", "gather/start"]);
    assert.ok(feed.every((e) => e.session === "p/1"));
    assert.ok(!JSON.stringify(host.feed("prj1", { includeQuiet: true })).includes("MARK-feed"));
    assert.deepEqual(host.feed("prj1", { limit: 1, newestFirst: true }).map((e) => e.event), ["gather/start"]);
    await host.act("p/1", "renew", {}, operator);
    assert.ok(!host.feed("prj1").some((e) => e.event === "renew"), "H28: a quiet step is not in the default feed…");
    assert.equal(host.feed("prj1", { includeQuiet: true }).filter((e) => e.event === "renew").length, 1, "…and is there on request");
    await host.close();
  });

  test("a settled session goes cold after a day and an event loads it again", async () => {
    const at = place();
    let now = 1_000_000;
    const host = await open(at, { clock: () => now });
    await host.start("l/1", "host-local-probe", {}, operator);
    await host.act("l/1", "gather/start", {}, operator);
    assert.deepEqual(host.sweepCold(now + 1000), [], "not a day yet");
    now += 86_400_000;
    assert.deepEqual(host.sweepCold(), ["l/1"]);
    assert.deepEqual(host.sessions("host-local-probe", { warmOnly: true }), [], "unloaded");
    assert.deepEqual(host.configuration("l/1"), ["top", "gathering"], "a cold session still reads, from its snapshot");
    assert.deepEqual(host.sessions("host-local-probe").map((x) => [x.id, x.configuration]), [["l/1", ["top", "gathering"]]], "and is listed");
    assert.equal(host.data("l/1")?.["now"], 1_000_000, "H32: data() answers a cold session from its snapshot");
    // H31: a newer snapshot on disk is read again (the peek cache follows the file's mtime)
    const file = scanSnapshots(host.paths.local).find((x) => x.sid === "l/1")!.file;
    writeFileSync(file, readFileSync(file, "utf8").replace(":gathering", ":idle"));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.deepEqual(host.configuration("l/1"), ["top", "idle"], "the rewritten snapshot is read, not the cached one");
    writeFileSync(file, readFileSync(file, "utf8").replace(":idle", ":gathering"));
    utimesSync(file, new Date(), new Date(Date.now() + 10000));
    assert.equal((await host.act("l/1", "gather/close", {}, operator)).taken, true, "loaded on demand");
    assert.deepEqual(host.configuration("l/1"), ["top", "idle"]);
    await host.close();
  });

  test("one session's resume that throws never aborts the org's boot: it is a problem, the rest resume", async () => {
    const at = place();
    let now = 1_000_000;
    const host = await open(at, { clock: () => now });
    await host.start("p/1", "host-probe", { pingOnResume: "nobody/x" }, operator);
    await host.start("p/2", "host-probe", {}, operator);
    await host.act("p/2", "wait", {}, operator);
    await host.close();
    now += 80;
    const again = await open(at, { clock: () => now });
    assert.deepEqual(again.problems().map((p) => [p.kind, p.sessionId]), [["resume", "p/1"]]);
    assert.match(again.problems()[0]!.why, /Unknown session: nobody\/x/);
    assert.deepEqual(again.configuration("p/2"), ["top", "idle"], "the others resumed and their timers fired");
    assert.equal((await again.act("p/2", "count", {}, operator)).taken, true, "the org works");
    await again.close();
  });

  test("a payload key the envelope carries with another value is a caller's bug: act, trial and explain throw, nothing is stepped or logged", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", {}, operator);
    const rowsBefore = host.log.rows().length;
    await assert.rejects(host.act("p/1", "count", { by: 5 }, operator), (e: unknown) => e instanceof OrgPayloadError && e.keys.join() === "by" && /count: payload key `by` shadows the envelope's/.test(e.message));
    assert.throws(() => host.trial("p/1", "count", { by: 5, reason: "x" }, { ...operator, reason: "y" }), (e: unknown) => e instanceof OrgPayloadError && e.keys.join() === "by,reason");
    assert.throws(() => host.explain("p/1", "count", { attended: false }, { by: "overseer", attended: true }), OrgPayloadError);
    assert.equal(host.data("p/1")?.["n"], undefined, "not stepped");
    assert.equal(host.log.rows().length, rowsBefore, "nothing logged");
    // equal values, and a key only one side has, pass
    assert.equal((await host.act("p/1", "count", { by: "operator", reason: "r" }, { ...operator, reason: "r" })).taken, true);
    assert.equal((await host.act("p/1", "count", { more: 5 }, operator)).taken, true);
    assert.equal(host.data("p/1")?.["n"], 2);
    await host.close();
  });

  test("a past-due timer that throws at open is a timer problem: the org opens, the others fire, it isn't retried until its session steps (H52)", async () => {
    const at = place();
    // On a virtual clock: both 50 ms timers are armed, and past due when the org opens again.
    let now = 1_000_000;
    const host = await open(at, { clock: () => now });
    await host.start("p/1", "host-probe", {}, operator);
    await host.start("p/2", "host-probe", {}, operator);
    await host.act("p/1", "arm-bomb", {}, operator);
    await host.act("p/2", "wait", {}, operator);
    assert.equal(host.nextDueAt(), now + 50);
    await host.close();
    now += 120;
    const again = await open(at, { clock: () => now });
    assert.deepEqual(again.problems().map((p) => [p.kind, p.sessionId]), [["timer", "p/1"]]);
    assert.match(again.problems()[0]!.why, /Step limit/);
    assert.deepEqual(again.configuration("p/2"), ["top", "idle"], "the other past-due timer fired");
    assert.deepEqual(again.configuration("p/1"), ["top", "bombing"]);
    assert.equal(again.nextDueAt(), null, "the throwing timer is not armed again (no retry loop)");
    assert.equal((await again.act("p/1", "defuse", {}, operator)).taken, true);
    assert.deepEqual(again.problems(), [], "a step of its session clears it");
    await again.close();
  });

  test("a timer that throws while open stalls its session only: the rest fire, no retry loop", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", {}, operator);
    await host.start("p/2", "host-probe", {}, operator);
    await host.act("p/1", "arm-bomb", {}, operator);
    await host.act("p/2", "wait", {}, operator);
    const rows = () => host.log.rows().length;
    // (the step limit's spin takes a while: wait for the outcome, not a fixed time)
    await until(() => host.problems().length > 0 && host.configuration("p/2")?.[1] === "idle", "the timers fired");
    assert.deepEqual(host.problems().map((p) => [p.kind, p.sessionId]), [["timer", "p/1"]]);
    assert.deepEqual(host.configuration("p/2"), ["top", "idle"]);
    assert.equal(host.nextDueAt(), null, "no timer is armed for it again");
    const n = rows();
    await tick(60);
    assert.equal(rows(), n, "nothing retried meanwhile");
    await host.close();
  });

  test("reload resumes every problem session: one that failed only because another's snapshot was broken, and a stalled timer", async () => {
    const at = place();
    let now = 1_000_000;
    const host = await open(at, { clock: () => now });
    // p/1 reaches p/2 when it resumes (as a person's link/moved reaches the org)
    await host.start("p/1", "host-probe", { pingOnResume: "p/2" }, operator);
    await host.start("p/2", "host-probe", {}, operator);
    await host.start("p/3", "host-probe", {}, operator);
    await host.act("p/3", "arm-bomb", {}, operator);
    await host.close();
    const file = scanSnapshots(join(at.workspaceDir, "statecharts")).find((s) => s.sid === "p/2")!.file;
    const good = readFileSync(file, "utf8");
    writeFileSync(file, "<<<<<<< HEAD\n{:broken");
    now += 120;
    const again = await open(at, { clock: () => now });
    assert.deepEqual(again.problems().map((p) => [p.kind, p.sessionId]).sort(), [["resume", "p/1"], ["snapshot", "p/2"], ["timer", "p/3"]]);
    assert.match(again.problems().find((p) => p.sessionId === "p/1")!.why, /p%2F2\.edn can't be read/, "p/1's own file is fine: it failed on p/2's");
    // reload with p/2 still broken: p/1 stays a problem (retried, fails the same way), nothing else changes
    assert.deepEqual((await again.reload()).map((p) => [p.kind, p.sessionId]).sort(), [["resume", "p/1"], ["snapshot", "p/2"], ["timer", "p/3"]]);
    writeFileSync(file, good);
    await again.act("p/3", "defuse", {}, operator);
    assert.deepEqual(await again.reload(), [], "p/2 loads, p/1 resumes, p/3's timer goes on: no restart needed");
    assert.equal((await again.act("p/1", "count", {}, operator)).taken, true);
    assert.equal((await again.act("p/2", "count", {}, operator)).taken, true);
    await again.close();
  });

  test("reload gives a stalled timer another go: still throwing, it is stalled again (once, no loop)", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/3", "host-probe", {}, operator);
    await host.act("p/3", "arm-bomb", {}, operator);
    await until(() => host.problems().length > 0, "the timer's problem");
    assert.deepEqual(host.problems().map((p) => [p.kind, p.sessionId]), [["timer", "p/3"]]);
    assert.deepEqual((await host.reload()).map((p) => [p.kind, p.sessionId]), [["timer", "p/3"]]);
    assert.equal(host.nextDueAt(), null, "set aside again");
    await host.close();
  });

  test("r13: rewindowHours moves only hours waits (a timed hold beside it keeps its end) after an hours edit; one in hours now goes at once under the fresh stamp; the log replays", async () => {
    const at = place();
    let now = 1_000_000;
    let fresh: number | null = null; // the people's current next window, as the host's stamp would give it
    const unattended = { by: "overseer", attended: false };
    const host = await open(at, { clock: () => now, stamp: () => ({ ...unattended, window: fresh }) });
    await host.start("p/1", "host-probe", {}, operator);
    const r = await host.act("p/1", "say", { window: now + 3_600_000 }, unattended);
    assert.equal(r.held?.wait, "hours");
    assert.equal(r.held?.until, now + 3_600_000);
    // a plain timed hold (q10) of another session: an hours edit never touches it (verifier-3 H10n00)
    await host.start("p/2", "host-probe", {}, operator);
    await host.act("p/2", "gather/start", {}, { ...unattended, holdMs: 600_000 });
    const timed = host.holds().find((h) => h.sessionId === "p/2")!;
    assert.equal(timed.wait, undefined);
    assert.equal(await host.rewindowHours(() => now + 7_200_000), 1, "a later window: the hours wait only");
    assert.equal(host.holds().find((h) => h.sessionId === "p/2")?.until, timed.until, "the timed hold keeps its end");
    assert.equal(host.holds().find((h) => h.sessionId === "p/1")?.until, now + 7_200_000);
    assert.equal(await host.rewindowHours(() => now + 7_200_000), 0, "unchanged: nothing sent");
    now += 60_000;
    fresh = null; // in hours now
    assert.equal(await host.rewindowHours(() => null), 1, "in hours now: the hours wait only");
    assert.deepEqual(host.holds().map((h) => [h.sessionId, h.until]), [["p/2", timed.until]], "the timed hold is still there, same end");
    assert.equal(host.data("p/1")?.["said"], 1, "it went at once");
    const rows = host.log.rows({ session: "p/1" });
    assert.deepEqual(rows.filter((x) => x.event === "sova/rewindow").map((x) => x.feed), ["quiet", "quiet"]);
    await host.close();
    const v = verifyOrg({ orgId: "o1", ...at, statecharts: HOST_STATECHARTS as unknown as EngineOptions["statecharts"] });
    assert.deepEqual(v.differing, [], "rebuild --verify replays the moved wait");
  });

  test("a watcher whose snapshot can't be read misses notifications without failing its source; reload catches it up (server-7: one broken person flagged its org)", async () => {
    const at = place();
    const host = await open(at);
    await host.start("org/o1", "org", { id: "o1", name: "Acme", slug: "acme", createdAt: 1 }, operator);
    await host.start("person/o1/p1", "person", { orgId: "o1", id: "p1", person: { name: "Ana", status: "active", role: "R", decides: [], skills: [] }, changed: [], by: { kind: "operator" } }, operator);
    await host.close();
    const file = scanSnapshots(join(at.workspaceDir, "statecharts")).find((s) => s.sid === "person/o1/p1")!.file;
    const good = readFileSync(file, "utf8");
    writeFileSync(file, "<<<<<<< HEAD\n{:broken");
    const again = await open(at);
    assert.deepEqual(again.problems().map((p) => [p.kind, p.sessionId]), [["snapshot", "person/o1/p1"]], "the org resumes: only the person's file is a problem");
    const r = await again.act("org/o1", "org/hours", { tz: "UTC", hours: { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" } }, operator);
    assert.equal(r.taken, true, "the org's own act goes through");
    assert.equal(r.result?.unreadable[0]?.watcher, "person/o1/p1", "the person missed it (reported)");
    writeFileSync(file, good);
    assert.deepEqual(await again.reload(), []);
    assert.equal(again.data("person/o1/p1")?.["hoursInherited"], true, "reloaded, it sees the company hours set meanwhile");
    await again.close();
  });
});
