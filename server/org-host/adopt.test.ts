// Run: pnpm exec tsx --test server/org-host/adopt.test.ts. OrgHost.adopt (§app.projects/import): sessions whose
// files were copied into a running engine's places are taken in as boot would take them (loaded, resumed,
// pending effects run, timers armed), survive a restart and a cold lookup, and an id the engine already
// holds refuses the whole set. The runtime JS test statechart (test-statechart.ts), in temp dirs.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, test } from "node:test";
import type { EngineOptions } from "../statecharts";
import { OrgHost, type OrgHostOptions } from "./index";
import { scanSnapshots } from "./store";
import { HOST_STATECHARTS } from "./test-statechart";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const operator = { by: "operator" };

function places() {
  const root = mkdtempSync(join(tmpdir(), "org-host-adopt-"));
  dirs.push(root);
  return { root, stateDir: join(root, "state"), projectWs: join(root, "project"), orgWs: join(root, "org") };
}

function open(orgId: string, workspaceDir: string, stateDir: string, more: Partial<OrgHostOptions> = {}) {
  return OrgHost.open({ orgId, workspaceDir, stateDir, durable: false, statecharts: HOST_STATECHARTS as unknown as EngineOptions["statecharts"], ...more });
}

/** Every file under `from` copied to the same relative path under `to`, a log segment renamed as an import names it. */
function copyTree(from: string, to: string, pid: string): void {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
  for (const file of walk(from)) {
    let rel = relative(from, file);
    if (rel.startsWith("log/") && rel.endsWith(".jsonl")) rel = rel.replace(/\.jsonl$/, `.imported-${pid}.jsonl`);
    mkdirSync(dirname(join(to, rel)), { recursive: true });
    copyFileSync(file, join(to, rel));
  }
}

/** A worked source engine ("p1"): a portable session with a pending effect and a counter, a host-local one
    with a timer armed and one settled cold-eligible; closed. */
async function workedSource(at: ReturnType<typeof places>, clock: () => number) {
  const src = await open("p1", at.projectWs, at.stateDir, { clock });
  await src.start("p/1", "host-probe", {}, operator);
  await src.act("p/1", "count", {}, operator);
  await src.act("p/1", "go", {}, operator); // no "write" handler here: the effect stays pending
  await src.start("l/1", "host-local-probe", {}, operator);
  await src.act("l/1", "wait", {}, operator); // a tick due in 50 ms
  await src.start("l/2", "host-local-probe", {}, operator);
  await src.act("l/2", "gather/start", {}, operator);
  const rows = src.log.rows();
  await src.close();
  return { rows };
}

/** The closed source's files copied into the running org's places (as the import copies them). */
function copyIn(at: ReturnType<typeof places>): void {
  copyTree(join(at.projectWs, "statecharts"), join(at.orgWs, "statecharts"), "p1");
  copyTree(join(at.stateDir, "statecharts", "p1"), join(at.stateDir, "statecharts", "o1"), "p1");
}

test("adopted sessions run as booted ones: loaded, resumed, the pending effect answered once, the timer fires", async () => {
  const at = places();
  const clock = () => 1_000_000;
  const { rows } = await workedSource(at, clock);
  const org = await open("o1", at.orgWs, at.stateDir, { clock: () => Date.now() });
  const ran: string[] = [];
  org.effects.register("write", async (e) => (ran.push(e.key), { wrote: e.key }));
  await org.start("p/9", "host-probe", {}, operator);
  const heard: string[][] = [];
  org.onChange((c) => heard.push(c.sessions));
  copyIn(at);
  await org.adopt(["p/1", "l/1", "l/2"]);
  assert.ok(heard.some((s) => ["p/1", "l/1", "l/2"].every((sid) => s.includes(sid))), "the change listeners hear every adopted session");
  assert.equal(org.data("p/1")?.["n"], 1, "the counter came with it");
  for (let i = 0; i < 20 && org.data("p/1")?.["done"] !== 1; i++) await tick(5);
  assert.equal(ran.length, 1, "the pending effect ran once");
  assert.equal(org.data("p/1")?.["done"], 1);
  assert.deepEqual(org.data("p/1")?.["sova/pending"], {});
  // the source's tick was due at its own clock + 50 ms, long past: the adopted timer fires
  for (let i = 0; i < 40 && !org.configuration("l/1")?.includes("idle"); i++) await tick(5);
  assert.deepEqual(org.configuration("l/1"), ["top", "idle"]);
  // the imported rows read as the org's, and a new row's `at` is past every one of them
  const all = org.log.rows();
  for (const r of rows) assert.ok(all.some((x) => x.at === r.at && x.session === r.session && x.event === r.event), `${r.session} ${r.event} kept`);
  await org.act("p/9", "count", {}, operator);
  const newest = org.log.rows({ session: "p/9" }).at(-1)!;
  assert.ok(newest.at > Math.max(...rows.map((r) => r.at)), "at stays unique past the imported rows");
  assert.equal(new Set(org.log.rows().map((r) => r.at)).size, org.log.rows().length);
  await org.close();
});

test("a cold lookup after adopt: an unloaded adopted session loads again from its copied file", async () => {
  const at = places();
  await workedSource(at, () => 1_000_000);
  const org = await open("o1", at.orgWs, at.stateDir);
  copyIn(at);
  await org.adopt(["p/1", "l/1", "l/2"]);
  const cold = org.sweepCold(Date.now() + 1, 0);
  assert.ok(cold.includes("l/2"), `the settled gathering session went cold (${cold.join(", ")})`);
  assert.deepEqual(org.configuration("l/2"), ["top", "gathering"], "read from its snapshot while cold");
  const r = await org.act("l/2", "gather/close", {}, operator);
  assert.equal(r.taken, true, "an act on it loads it again");
  assert.deepEqual(org.configuration("l/2"), ["top", "idle"]);
  await org.close();
});

test("a restart after adopt opens everything adopted, with nothing lost", async () => {
  const at = places();
  await workedSource(at, () => 1_000_000);
  const org = await open("o1", at.orgWs, at.stateDir);
  org.effects.register("write", async (e) => ({ wrote: e.key }));
  copyIn(at);
  await org.adopt(["p/1", "l/1", "l/2"]);
  for (let i = 0; i < 20 && org.data("p/1")?.["done"] !== 1; i++) await tick(5);
  await org.act("p/1", "count", {}, operator);
  const before = org.log.rows().length;
  await org.close();
  const again = await open("o1", at.orgWs, at.stateDir);
  assert.deepEqual(again.problems(), []);
  assert.equal(again.data("p/1")?.["n"], 2);
  assert.equal(again.data("p/1")?.["done"], 1);
  assert.ok(again.configuration("l/2")?.includes("gathering"));
  assert.ok(again.log.rows().length >= before);
  await again.act("p/1", "count", {}, operator);
  assert.equal(new Set(again.log.rows().map((r) => r.at)).size, again.log.rows().length, "at stays unique across the restart");
  await again.close();
});

test("adopt refuses a set holding an id the engine already has, taking none of it", async () => {
  const at = places();
  await workedSource(at, () => 1_000_000);
  const org = await open("o1", at.orgWs, at.stateDir);
  await org.start("p/9", "host-probe", {}, operator);
  copyIn(at);
  await assert.rejects(org.adopt(["p/1", "p/9"]), /Already in this engine: p\/9/);
  assert.equal(org.data("p/1"), null, "p/1 was not taken in");
  await org.adopt(["p/1"]);
  await assert.rejects(org.adopt(["p/1"]), /Already in this engine: p\/1/, "an adopted id is held too");
  await org.close();
});

test("adopt refuses a sid with no file here, and a snapshot that does not load leaves nothing loaded", async () => {
  const at = places();
  await workedSource(at, () => 1_000_000);
  const org = await open("o1", at.orgWs, at.stateDir);
  copyIn(at);
  await assert.rejects(org.adopt(["p/1", "p/404"]), /No snapshot file here for p\/404/);
  const bad = scanSnapshots(join(at.orgWs, "statecharts")).find((s) => s.sid === "p/1")!;
  writeFileSync(join(dirname(bad.file), `${encodeURIComponent("p/2")}.edn`), "{:not an edn");
  await assert.rejects(org.adopt(["l/1", "p/2"]), /Not taken in/);
  assert.equal(org.configuration("l/1"), null, "l/1 was unloaded again");
  await org.adopt(["l/1"]);
  assert.ok(org.configuration("l/1"));
  await org.close();
});
