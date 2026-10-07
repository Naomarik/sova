// Run: pnpm exec tsx --test server/org-host/rebuild.integration.test.ts. `statecharts rebuild --verify` (r9): an
// org's log, written by the host, replays to every snapshot; a hand-edited snapshot is reported;
// nothing is written.
// The rebuild CLI run as a program; the rebuild itself in-process is rebuild.test.ts.
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
  test("the command: only --verify exists, a usage error is exit 2", () => {
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/statecharts.ts", ...args], { encoding: "utf8" });
    const plain = run("rebuild", "o1");
    assert.equal(plain.status, 2);
    assert.match(plain.stderr, /Only `rebuild --verify` exists/);
    assert.equal(run("nothing").status, 2);
  });
});
