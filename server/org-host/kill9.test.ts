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
import { scanSnapshots } from "./store";
import { HOST_CHARTS } from "./test-chart";

const ROUNDS = Number(process.env["KILL9_ROUNDS"] ?? 40);
const CHILD = fileURLToPath(new URL("./kill9-child.ts", import.meta.url));
const OFFER_CHILD = fileURLToPath(new URL("./kill9-offer-child.ts", import.meta.url));

function round(root: string, seed: number, killAfterMs: number, child_ = CHILD): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", child_, root, String(seed)], { stdio: ["ignore", "pipe", "pipe"] });
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

test(`r12: offers reaching each invitee in their hours, killed at random ${Math.ceil(ROUNDS / 2)} times: nobody reached twice or outside their hours, every waiter has a timer`, { timeout: 30 * 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "org-host-kill9-offer-"));
  try {
    let seed = 11;
    for (let i = 0; i < Math.ceil(ROUNDS / 2); i++) {
      seed = (seed * 48271) % 2147483647;
      const line = await round(root, seed, seed % 40, OFFER_CHILD);
      assert.equal(line, "ready []", `round ${i}: the open after a kill found no problem`);
    }
    const now = Number(readFileSync(join(root, "clock"), "utf8"));
    const host = await OrgHost.open({ orgId: "o1", workspaceDir: join(root, "ws"), stateDir: join(root, "state"), durable: false, clock: () => now });
    assert.deepEqual(host.problems(), []);
    const batons = host.sessions("baton");
    assert.ok(batons.length >= 2, `offers were made (${batons.length})`);
    const hoursOf: Record<string, [number, number] | null> = { p1: [22 * 60, 23 * 60 + 30], p2: [3 * 60, 11 * 60], p3: null };
    let reached = 0;
    let waiters = 0;
    for (const b of batons) {
      const offer = ((b.data["offers"] as { reach?: Record<string, { state: string; at?: number }> }[] | undefined) ?? []).at(-1);
      for (const [pid, r] of Object.entries(offer?.reach ?? {})) {
        if (r.state !== "reached") continue;
        reached++;
        const w = hoursOf[pid];
        if (w && r.at != null) {
          const d = new Date(r.at);
          const m = d.getUTCHours() * 60 + d.getUTCMinutes();
          assert.ok(m >= w[0] && m < w[1], `${b.id}: ${pid} reached at ${d.toISOString()}, inside their hours`);
        }
      }
      const waiting = Object.values(offer?.reach ?? {}).some((r) => r.state === "waiting");
      if (waiting) {
        const snap = scanSnapshots(join(root, "ws", "charts")).find((x) => x.sid === b.id)!;
        const text = readFileSync(snap.file, "utf8");
        assert.ok(text.slice(text.indexOf(":queue")).includes(":offer/reach"), `${b.id}: a waiter has its reach timer`);
        waiters++;
      }
    }
    assert.ok(reached > 0, "someone was reached");
    // each invitee's link is ONE effect per offer (a crash may re-run it, under the same engine key)
    const mints = readFileSync(join(root, "mints.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { key: string; chartKey: string });
    const keysPer = new Map<string, Set<string>>();
    for (const m of mints) keysPer.set(`${m.chartKey}`, (keysPer.get(m.chartKey) ?? new Set()).add(m.key));
    for (const [ck, keys] of keysPer) assert.equal(keys.size, 1, `${ck}: minted by one effect only`);
    await host.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
