// Run: pnpm exec tsx --test server/org-host/host.test.ts. The org host over the vendored engine, on
// a runtime JS test chart (test-chart.ts), in temp dirs: snapshots, the redo journal and its replay,
// the log and its privacy, effects (answered once, re-run at open), holds, invocations, timers,
// workspace problems.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { EngineOptions } from "../org-charts";
import { OrgHost, type OrgHostOptions } from "./index";
import { scanSnapshots } from "./store";
import { HOST_CHARTS } from "./test-chart";

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
  return OrgHost.open({ orgId: "o1", ...where, durable: false, charts: HOST_CHARTS as unknown as EngineOptions["charts"], ...more });
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const operator = { by: "operator" };

describe("org host", () => {
  test("a step's snapshot lands in its storage place, its row in the log, and no journal is left", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", {}, operator);
    await host.start("l/1", "host-local-probe", {}, operator);
    const r = await host.act("p/1", "count", {}, operator);
    assert.equal(r.taken, true);
    assert.deepEqual(scanSnapshots(join(at.workspaceDir, "charts")).map((s) => s.sid), ["p/1"]);
    assert.deepEqual(scanSnapshots(host.paths.local).map((s) => s.sid), ["l/1"]);
    assert.deepEqual(readdirSync(host.paths.journal), []);
    const rows = host.log.rows({ session: "p/1" });
    assert.deepEqual(rows.map((x) => x.event), ["sova/started", "count"]);
    assert.deepEqual(host.log.rows({ session: "l/1" }).map((x) => x.event), ["sova/started"]);
    assert.ok(!existsSync(join(at.workspaceDir, "charts", "log")) || !readdirSync(join(at.workspaceDir, "charts", "log")).some((f) => readFileSync(join(at.workspaceDir, "charts", "log", f), "utf8").includes('"l/1"')), "a host-local session never logs into the repo");
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
    await tick(20);
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
    const host = await open(at, {
      stamp: (sid, event, _payload, who) => {
        stamps.push([sid, event, who]);
        return { by: "overseer", attended: false };
      },
    });
    await host.start("p/1", "host-probe", {}, operator);
    const r = await host.act("p/1", "gather/start", {}, { by: "overseer", attended: false, holdMs: 40, projectId: "prj1", overseerId: "po1" });
    assert.equal(r.taken, true);
    assert.equal(r.held?.what, "Gathering");
    assert.deepEqual(host.holds().map((h) => h.id), ["gather/start#0"]);
    assert.deepEqual(host.configuration("p/1"), ["top", "idle"]);
    await tick(120);
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

  test("an invocation runs with its run id and its report moves the chart", async () => {
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
    await tick(30);
    assert.deepEqual(host.configuration("p/1"), ["top", "idle"]);
    await host.close();
  });

  test("timers fire on their own from nextDueAt", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "wait", {}, operator);
    assert.deepEqual(host.configuration("p/1"), ["top", "timed"]);
    await tick(120);
    assert.deepEqual(host.configuration("p/1"), ["top", "idle"]);
    await host.close();
  });

  test("a crash after the journal was written: open applies it (snapshot and row, once)", async () => {
    const at = place();
    let crash = false;
    const host = await open(at, { commitHooks: { afterJournal: () => { if (crash) throw new Error("killed"); } } });
    await host.start("p/1", "host-probe", {}, operator);
    crash = true;
    assert.throws(() => host.actNow("p/1", "count", {}, operator), /killed/);
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
    const host = await open(at, { commitHooks: { afterApply: () => { if (crash) throw new Error("killed"); } } });
    await host.start("p/1", "host-probe", {}, operator);
    crash = true;
    assert.throws(() => host.actNow("p/1", "count", {}, operator), /killed/);
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
    const file = scanSnapshots(join(at.workspaceDir, "charts")).find((s) => s.sid === "p/2")!.file;
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
});
