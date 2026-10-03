import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { activityOf, readLiveRecords, WORKING_FRESH_MS, workerCountsOf } from "../live";
import { LIVE_DIR } from "../paths";
import { realExec, type Exec } from "./drivers";
import { servicesRoot, stateHash } from "./store";

/**
 * Sova hosting itself (§app.project-services/self-host): the checkout this server's code was loaded
 * from, and whether any session it hosts is busy (CLAUDE.md "Live server restart": a fresh live
 * record of this server's pid with a working subagent or a turn in flight).
 */

let checkout: string | null | undefined;

/** The git checkout the running server was loaded from, or null outside one. */
export function serverCheckout(): string | null {
  if (checkout !== undefined) return checkout;
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    checkout = top ? realpathSync(top) : null;
  } catch {
    checkout = null;
  }
  return checkout;
}

/** Why this server's hosted sessions are busy ("2 sessions busy: 1 with working subagents, 1 turn in flight"), or null when none is. */
export function hostedBusy(now = Date.now()): string | null {
  let workers = 0;
  let turns = 0;
  for (const r of readLiveRecords({ includeOwn: true })) {
    if (r.pid !== process.pid) continue;
    const beat = typeof r.rec?.heartbeat === "number" ? r.rec.heartbeat : 0;
    if (now - beat > WORKING_FRESH_MS) continue;
    if ((workerCountsOf(r.rec)?.working ?? 0) > 0) workers++;
    else if (activityOf(r.rec)?.state === "working") turns++;
  }
  if (!workers && !turns) return null;
  const parts = [...(workers ? [`${workers} with working subagents`] : []), ...(turns ? [`${turns} with a turn in flight`] : [])];
  return `${workers + turns} hosted session${workers + turns === 1 ? "" : "s"} busy: ${parts.join(", ")}`;
}

/** When this server started and the commit its checkout had then (as `GET /api/health` answers them), read once. */
let started: { startedAt: string; head: string | null } | undefined;
export function serverStart(): { startedAt: string; head: string | null } {
  if (started) return started;
  let head: string | null = null;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    // not a checkout
  }
  started = { startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), head };
  return started;
}

/** The restart gate (§app.project-services/adopt), from this server's own code, never a project's. */
export const RESTART_GATE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "sova-restart-gate.mjs");
export const RESTART_DELAY_SEC = 30;
export const restartGateLog = () => join(servicesRoot(), "logs", "restart-gate.log");

/** The transient unit that runs an adopted unit's gate: one per unit and state root, so a second schedule meanwhile is refused by name. */
export const restartGateUnitOf = (unit: string) => `sova-restart-${stateHash()}-${unit.replace(/\.service$/, "").replace(/[^A-Za-z0-9_.-]/g, "_")}`;

/** The `systemd-run` argv that runs the gate for `unit` once, `RESTART_DELAY_SEC` from now (pure, for tests). */
export function restartGateArgv(o: { unit: string; serverPid: number; liveDir: string; mainPid: number | null; log: string; node?: string; script?: string }): string[] {
  return [
    "--user",
    `--unit=${restartGateUnitOf(o.unit)}`,
    `--on-active=${RESTART_DELAY_SEC}s`,
    "--collect",
    "--quiet",
    "--",
    o.node ?? process.execPath,
    o.script ?? RESTART_GATE,
    "--unit",
    o.unit,
    "--server-pid",
    String(o.serverPid),
    "--live-dir",
    o.liveDir,
    ...(o.mainPid ? ["--main-pid", String(o.mainPid)] : []),
    "--log",
    o.log,
  ];
}

/** Schedule `unit`'s gated restart: null when scheduled, else `systemd-run`'s own message (nothing was scheduled). */
export async function scheduleRestart(unit: string, mainPid: number | null, exec: Exec = realExec): Promise<string | null> {
  const r = await exec("systemd-run", restartGateArgv({ unit, serverPid: process.pid, liveDir: LIVE_DIR, mainPid, log: restartGateLog() }), { timeoutMs: 15_000 });
  return r.code === 0 ? null : (r.stderr || r.stdout).trim() || `systemd-run exited with ${r.code}`;
}
