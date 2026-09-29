// Run: pnpm exec tsx --test server/org-host/kill9.test.ts (KILL9_ROUNDS=1000 for the lab bar).
// A child host (kill9-child.ts, durable: journals and snapshots fsynced) is SIGKILLed at random
// moments, again and again. After every kill the next open must load every session with no workspace
// problem; at the end, once every pending effect ran, each effect key was answered exactly once (the
// session's done counter equals the distinct keys its log rows emitted) and no log row was appended
// twice.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EngineOptions } from "../org-charts";
import { OrgHost } from "./index";
import { HOST_CHARTS } from "./test-chart";

const ROUNDS = Number(process.env["KILL9_ROUNDS"] ?? 40);
const CHILD = fileURLToPath(new URL("./kill9-child.ts", import.meta.url));

function round(root: string, seed: number, killAfterMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, root, String(seed)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let killing = false;
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString();
      if (out.includes("acted\n") && !killing) {
        killing = true;
        setTimeout(() => child.kill("SIGKILL"), killAfterMs);
      }
    });
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    child.on("exit", (code, signal) => {
      if (signal === "SIGKILL") resolve(out.split("\n")[0] ?? "");
      else reject(new Error(`child exited ${code}: ${err}`));
    });
  });
}

test(`kill -9 at random moments, ${ROUNDS} times: every open loads everything, every effect is answered once`, { timeout: 30 * 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "org-host-kill9-"));
  try {
    let seed = 7;
    for (let i = 0; i < ROUNDS; i++) {
      seed = (seed * 48271) % 2147483647;
      const line = await round(root, seed, seed % 60);
      assert.equal(line, "ready []", `round ${i}: the open after a kill found no problem`);
    }
    const host = await OrgHost.open({ orgId: "o1", workspaceDir: join(root, "ws"), stateDir: join(root, "state"), durable: false, charts: HOST_CHARTS as unknown as EngineOptions["charts"] });
    host.effects.register("write", async (e) => ({ wrote: e.key }));
    assert.deepEqual(host.problems(), []);
    // quiesce: pending effects answered, holds and timers due
    for (let k = 0; k < 50; k++) await new Promise((r) => setTimeout(r, 10));
    const rows = host.log.rows();
    assert.ok(rows.filter((r) => r.event !== "sova/started" && r.event !== "sova/resumed").length >= ROUNDS * 5, `every child committed 5 acts before its kill (${rows.length} rows)`);
    assert.ok(rows.some((r) => r.event === "effect/done") && rows.some((r) => r.held), "effects were answered and acts held");
    const ids = rows.filter((r) => r.j).map((r) => `${r.j}|${r.session}|${r.event}|${r.at}`);
    assert.equal(new Set(ids).size, ids.length, "no row appended twice");
    for (const s of host.sessions("host-probe")) {
      const emitted = new Set(rows.filter((r) => r.session === s.id && r.event === "go").flatMap((r) => r.effects));
      const answered = rows.filter((r) => r.session === s.id && r.event === "effect/done").map((r) => (r.envelope as { key: string }).key);
      assert.equal(new Set(answered).size, answered.length, `${s.id}: no effect answered twice`);
      assert.deepEqual(new Set(answered), emitted, `${s.id}: every emitted effect answered`);
      assert.equal(s.data["done"] ?? 0, emitted.size, `${s.id}: the chart counted each answer once`);
      assert.deepEqual(s.data["sova/pending"], {});
    }
    assert.ok(existsSync(join(root, "effects.log")));
    const runs = readFileSync(join(root, "effects.log"), "utf8").trim().split("\n");
    assert.ok(runs.length >= 1);
    await host.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
