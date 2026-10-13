import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { realExec, type Exec } from "./drivers";
import { stateHash } from "./store";

/**
 * Sova hosting itself (§app.project-services/self-host): the checkout this server's code was loaded
 * from, when it started, and the delayed restart of an adopted unit (§app.project-services/adopt).
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

/** How long after a confirmed apply the adopted unit restarts: long enough for the verb's answer to get out (§app.project-services/adopt). */
export const RESTART_DELAY_SEC = 3;

/** The transient unit that runs one scheduled restart of an adopted unit: a name of its own per schedule (an elapsed timer may stay loaded). */
export const restartUnitOf = (unit: string, at = Date.now()) => `sova-restart-${stateHash()}-${unit.replace(/\.service$/, "").replace(/[^A-Za-z0-9_.-]/g, "_")}-${at.toString(36)}`;

/** The `systemd-run` argv that restarts `unit` once, `RESTART_DELAY_SEC` from now (pure, for tests). */
export function restartArgv(unit: string, at?: number): string[] {
  return ["--user", `--unit=${restartUnitOf(unit, at)}`, `--on-active=${RESTART_DELAY_SEC}s`, "--collect", "--quiet", "--", "systemctl", "--user", "restart", unit];
}

/** macOS: the launchd target of an adopted unit, `gui/<uid>/<label>`, the label being the unit's name without `.service`. */
export const launchdTargetOf = (unit: string, uid: number) => `gui/${uid}/${unit.replace(/\.service$/, "")}`;

/** macOS: `/bin/sh` argv that waits `RESTART_DELAY_SEC`, then kickstarts the agent (the target is `$0`, never part of the script) (pure, for tests). */
export function kickstartArgv(unit: string, uid: number): string[] {
  return ["-c", `sleep ${RESTART_DELAY_SEC}; exec launchctl kickstart -k "$0"`, launchdTargetOf(unit, uid)];
}

/** Start `file args` in a session of its own, not waited for: null once it runs, else why it couldn't start. */
export function spawnDetached(file: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { detached: true, stdio: "ignore" });
    } catch (err) {
      return done(`cannot start ${file}: ${(err as Error).message}`);
    }
    child.once("error", (err) => done(`cannot start ${file}: ${err.message}`));
    // A pid means it runs (a missing program has none, and reports through "error").
    if (child.pid !== undefined) {
      child.unref();
      done(null);
    }
  });
}

/**
 * Schedule `unit`'s restart `RESTART_DELAY_SEC` from now: null when scheduled, else `systemd-run`'s
 * own message (nothing was scheduled). No busy check: every chat runs in a process of its own and
 * outlives the restart. On macOS a process in a session of its own waits the delay and kickstarts
 * the agent; it survives the `launchctl kickstart -k` it issues.
 */
export async function scheduleRestart(unit: string, exec: Exec = realExec, platform: NodeJS.Platform = process.platform, detached: (file: string, args: string[]) => Promise<string | null> = spawnDetached, uid: number = process.getuid?.() ?? 0): Promise<string | null> {
  if (platform === "darwin") return detached("/bin/sh", kickstartArgv(unit, uid));
  const r = await exec("systemd-run", restartArgv(unit), { timeoutMs: 15_000 });
  return r.code === 0 ? null : (r.stderr || r.stdout).trim() || `systemd-run exited with ${r.code}`;
}
