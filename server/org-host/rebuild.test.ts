// Run: pnpm exec tsx --test server/org-host/rebuild.test.ts. `statecharts rebuild --verify` (r9): an
// org's log, written by the host, replays to every snapshot; a hand-edited snapshot is reported;
// nothing is written.
// The rebuild CLI run as a program: rebuild.integration.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { EngineOptions } from "../statecharts";
import { OrgHost } from "./index";
import { formatReport, verifyOrg } from "./rebuild";
import { scanSnapshots } from "./store";
import { HOST_STATECHARTS } from "./test-statechart";

const statecharts = HOST_STATECHARTS as unknown as EngineOptions["statecharts"];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function place() {
  const root = mkdtempSync(join(tmpdir(), "org-rebuild-"));
  dirs.push(root);
  return { workspaceDir: join(root, "ws"), stateDir: join(root, "state") };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const operator = { by: "operator" };

/** An org that lived: starts (portable and host-local), a scrubbed payload, an effect answered, a look
    reported, a timer, a held act released, a plain row, a restart that cuts a look off, a set-state with a patch. */
async function lived(at: { workspaceDir: string; stateDir: string }) {
  const open = () =>
    OrgHost.open({ orgId: "o1", ...at, durable: false, statecharts, stamp: () => ({ by: "overseer", attended: false }) });
  const host = await open();
  host.effects.register("write", async () => ({ result: { ok: true } }));
  let looks = 0; // the first look reports; the second is still running at the restart (cut off)
  host.invocations.register("sova/look", { start: (_inv, report) => void (looks++ === 0 && setTimeout(() => report("finished"), 5)), stop: () => {} });
  await host.start("p/1", "host-probe", { label: "first" }, operator);
  await host.start("l/1", "host-local-probe", {}, operator);
  await host.act("p/1", "count", { text: "the person's own words", contact: { email: "ana@example.org" } }, operator);
  await host.act("p/1", "go", {}, operator, { settle: true });
  await host.act("p/1", "look", {}, operator);
  await tick(30);
  await host.act("p/1", "wait", {}, operator);
  await tick(120);
  await host.act("p/1", "gather/start", {}, { by: "overseer", attended: false, holdMs: 30 });
  await tick(100);
  await host.act("p/1", "gather/close", {}, operator);
  await host.logAct({ session: "p/1", event: "note/add", by: "operator", envelope: { text: "a note" } });
  await host.act("l/1", "wait", {}, operator);
  await host.act("p/1", "look", {}, operator);
  await host.close();
  const again = await open();
  await again.setState("p/1", { states: ["gathering"], patch: { n: 9 }, reason: "stuck" }, { by: "overseer", attended: true });
  await tick(80);
  await again.close();
}

describe("statecharts rebuild --verify", () => {
  test("a log the host wrote replays to every snapshot, and the check writes nothing", async () => {
    const at = place();
    await lived(at);
    const files = [...scanSnapshots(join(at.workspaceDir, "statecharts")), ...scanSnapshots(join(at.stateDir, "statecharts", "o1"))];
    const before = files.map((f) => [f.file, statSync(f.file).mtimeMs, readFileSync(f.file, "utf8")]);
    const logDir = join(at.workspaceDir, "statecharts", "log");
    const logBefore = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8"));
    const r = verifyOrg({ orgId: "o1", ...at, statecharts });
    assert.deepEqual(r.differing, [], formatReport(r));
    assert.equal(r.sessions, 2);
    assert.deepEqual(r.problems, []);
    assert.equal(r.pendingJournal, false);
    assert.deepEqual(files.map((f) => [f.file, statSync(f.file).mtimeMs, readFileSync(f.file, "utf8")]), before, "no snapshot touched");
    assert.deepEqual(readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")), logBefore, "no row appended");
    assert.match(formatReport(r), /2 session\(s\) replayed from the log; 0 differ/);
  });

  test("the rows a replay needs are logged: a host start's data, the run a report answers, a set-state's patch; a plain row is marked", async () => {
    const at = place();
    await lived(at);
    const logDir = join(at.workspaceDir, "statecharts", "log");
    const rows = readdirSync(logDir).flatMap((f) => readFileSync(join(logDir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
    const p1 = rows.filter((x) => x.session === "p/1");
    assert.deepEqual(p1[0].start, { label: "first" });
    assert.deepEqual(p1[0].envelope, { by: "operator" });
    assert.equal(p1.find((x) => x.event === "look/finished")?.invokeId, "look");
    assert.deepEqual(p1.find((x) => x.event === "sova/set-state")?.envelope.patch, { n: 9 });
    assert.equal(p1.find((x) => x.event === "note/add")?.plain, true);
    assert.equal(p1.find((x) => x.event === "count")?.envelope.text.len, 22, "still scrubbed");
    assert.deepEqual(p1.map((x) => x.event).filter((e) => ["effect/done", "tick", "sova/resumed"].includes(e)), ["effect/done", "tick", "sova/resumed"]);
    const gathers = p1.filter((x) => x.event === "gather/start");
    assert.ok(gathers.length === 2 && gathers[0].held && !gathers[1].held, "the life held an act, then released it");
  });

  test("a hand-edited snapshot is reported with what differs; a session without its start rows too", async () => {
    const at = place();
    await lived(at);
    const p1 = scanSnapshots(join(at.workspaceDir, "statecharts")).find((s) => s.sid === "p/1")!;
    writeFileSync(p1.file, readFileSync(p1.file, "utf8").replaceAll(":gathering", ":busy"));
    const r = verifyOrg({ orgId: "o1", ...at, statecharts });
    assert.deepEqual(r.differing.map((v) => [v.session, v.differences.map((d) => d.what)]), [["p/1", ["configuration"]]]);
    assert.deepEqual(r.differing[0]!.differences[0]!.snapshot, ["busy", "top"]);
    assert.deepEqual(r.differing[0]!.differences[0]!.replayed, ["gathering", "top"]);
    assert.match(formatReport(r), /- p\/1 \(host-probe\).*\n {4}configuration: replayed \["gathering","top"\], snapshot \["busy","top"\]/);
    // a snapshot with no rows at all
    const l1 = scanSnapshots(join(at.stateDir, "statecharts", "o1")).find((s) => s.sid === "l/1")!;
    writeFileSync(join(l1.file, "..", `${encodeURIComponent("l/2")}.edn`), readFileSync(l1.file, "utf8"));
    assert.deepEqual(
      verifyOrg({ orgId: "o1", ...at, statecharts }).differing.map((v) => [v.session, v.differences.map((d) => d.what)]),
      [["l/2", ["log"]], ["p/1", ["configuration"]]],
    );
  });

});
