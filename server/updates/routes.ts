import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context, Hono } from "hono";
import { buildId, currentGenerationOf } from "../chat-runtime/generations";
import { yourClickBody, yourClickRefusal } from "../page-only";
import { RESTART_DELAY_SEC, scheduleRestart, serverCheckout, serverStart } from "../project-services/self-host";
import { stateHash } from "../project-services/store";
import { agentRoot, stateRoot } from "../state-root";
import { repoUrlOf } from "./check";
import { firstLine, gitIn, realExec } from "./git";
import { detectInstall, realProbe, type InstallInfo } from "./install-kind";
import { diskAheadOf, type DiskAhead } from "./disk-ahead";
import { UpdatesManager, UpdatesRefusal } from "./manager";
import { installRunner, type UpgradePlan } from "./runner";
import { checksOffIn } from "./state";

/**
 * The Updates routes. Reading is any gated caller's; checking, saving the settings, upgrading and
 * restarting are the user's alone (§app.access/your-click): their own page on this machine, on a
 * request a browser marks same-origin; never a script, a chat, the peer listener, an in-process
 * call or the Overseer.
 */

/** The 403 of an act on updates, or null when it is the user's own page. */
export function notOperator(c: Context, door: "restart" | "update"): Response | null {
  const notYou = yourClickRefusal(c, door);
  if (notYou) return notYou;
  const env = c.env as { incoming?: unknown } | undefined;
  if (!env?.incoming || (c.req.header("sec-fetch-site") ?? "").toLowerCase() !== "same-origin") return c.json(yourClickBody(door, "script"), 403);
  return null;
}

let listen = { port: Number(process.env.PORT) || 4800, host: process.env.HOST || "127.0.0.1" };
let manager: UpdatesManager | null = null;

/**
 * The environment the job's programs get: what install.sh, git, pnpm and systemctl need, and what
 * the launcher reads (PORT is the plan's; HOST too, so a copy with no service that the job starts
 * again listens where it listened before).
 */
const JOB_ENV = ["HOST", "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SHELL", "TMPDIR", "PI_CODING_AGENT_DIR", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "MISE_DATA_DIR", "SOVA_UPDATES_REPO_URL", "SOVA_RUNTIME", "SOVA_BUN", "SOVA_NODE"];

/** Start the job outside this server's service: a transient user unit, else a detached process. */
async function launchJob(plan: UpgradePlan): Promise<string | null> {
  const runner = installRunner(plan.jobDir);
  const argv = [process.execPath, runner, plan.jobDir];
  if (process.platform === "linux" && (await realExec("systemctl", ["--user", "show-environment"], { timeoutMs: 5_000 })).code === 0) {
    const r = await realExec(
      "systemd-run",
      [
        "--user",
        `--unit=sova-update-${stateHash()}-${plan.id}`,
        "--collect",
        "--quiet",
        // A server the job starts (an installed copy with no service) outlives the job's unit.
        "--property=KillMode=process",
        `--working-directory=${plan.jobDir}`,
        ...Object.entries(plan.env).map(([k, v]) => `--setenv=${k}=${v}`),
        "--",
        ...argv,
      ],
      { timeoutMs: 15_000 },
    );
    return r.code === 0 ? null : `systemd-run: ${firstLine(r)}`;
  }
  return new Promise((done) => {
    const logFile = join(plan.jobDir, "runner.out");
    mkdirSync(dirname(logFile), { recursive: true });
    const fd = openSync(logFile, "a");
    try {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: plan.jobDir, env: plan.env, detached: true, stdio: ["ignore", fd, fd] });
      child.once("error", (err) => done(err.message));
      child.once("spawn", () => {
        child.unref();
        done(null);
      });
    } catch (err) {
      done(err instanceof Error ? err.message : String(err));
    } finally {
      closeSync(fd);
    }
  });
}

/** The part of the server's environment the job gets (JOB_ENV). */
export function jobEnvOf(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(JOB_ENV.flatMap((k) => (env[k] ? [[k, env[k]!]] : [])));
}

let installCache: { at: number; info: Promise<InstallInfo> } | null = null;
/** The build this server started with when no chat host recorded one (startUpdates). */
let startBuild: Promise<string> | null = null;
let aheadCache: { at: number; ahead: Promise<DiskAhead | null> } | null = null;

/** Code on disk newer than what runs, read at most every 5 s (each read runs git status and diff). */
function diskAhead(): Promise<DiskAhead | null> {
  const checkout = serverCheckout();
  if (!checkout) return Promise.resolve(null);
  if (aheadCache && Date.now() - aheadCache.at < 5_000) return aheadCache.ahead;
  const ahead = (async () => {
    const gen = currentGenerationOf()?.id;
    const start = gen && gen !== "unknown" ? gen : await (startBuild ?? Promise.resolve("unknown"));
    return diskAheadOf({ git: gitIn(checkout), startedHead: serverStart().head, startBuild: start === "unknown" ? null : start, buildNow: () => buildId(checkout) });
  })().catch(() => null);
  aheadCache = { at: Date.now(), ahead };
  return ahead;
}

/** This server's updates, built once with the real git, clock and launcher. */
export function updates(): UpdatesManager {
  if (manager) return manager;
  manager = new UpdatesManager({
    file: join(stateRoot(), "updates.json"),
    jobsDir: join(stateRoot(), "updates", "jobs"),
    repo: repoUrlOf(process.env),
    checksOff: checksOffIn(process.env),
    startedHead: serverStart().head,
    install: () => {
      if (!installCache || Date.now() - installCache.at > 60_000) installCache = { at: Date.now(), info: detectInstall(realProbe(serverCheckout(), agentRoot())) };
      return installCache.info;
    },
    git: (checkout) => gitIn(checkout),
    now: () => Date.now(),
    timers: { set: (fn, ms) => setTimeout(fn, ms).unref(), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    startDelayMs: 60_000,
    launch: launchJob,
    port: () => listen.port,
    healthUrl: () => {
      const h = listen.host;
      const host = h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h.includes(":") ? `[${h}]` : h;
      return `http://${host}:${listen.port}/api/health`;
    },
    pid: process.pid,
    uid: process.getuid?.() ?? 0,
    jobEnv: () => jobEnvOf(process.env),
    serverLog: join(stateRoot(), "app-server.log"),
    log: (line) => console.log(line),
    startedAt: serverStart().startedAt,
    restart: (unit) => scheduleRestart(unit.name),
    restartDelaySec: RESTART_DELAY_SEC,
    diskAhead,
  });
  return manager;
}

/** Tests: the manager the routes use. */
export function setUpdatesForTest(m: UpdatesManager | null): void {
  manager = m;
}

/** After listen: the real port, then the daily check's schedule. */
export function startUpdates(port: number, host: string): void {
  listen = { port, host };
  const checkout = serverCheckout();
  if (checkout && !startBuild) startBuild = buildId(checkout).catch(() => "unknown");
  updates().start();
}

const refused = (c: Context, err: unknown) => {
  if (err instanceof UpdatesRefusal) return c.json({ error: err.message }, err.status);
  throw err;
};

export function registerUpdatesRoutes(app: Hono): void {
  app.get("/api/updates", async (c) => c.json(await updates().state()));

  app.post("/api/updates/check", async (c) => {
    const no = notOperator(c, "update");
    if (no) return no;
    try {
      await updates().check();
    } catch (err) {
      return refused(c, err);
    }
    return c.json(await updates().state());
  });

  app.put("/api/updates/settings", async (c) => {
    const no = notOperator(c, "update");
    if (no) return no;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Updates: the request wasn't JSON." }, 400);
    }
    try {
      await updates().saveSettings(body);
    } catch (err) {
      return refused(c, err);
    }
    return c.json(await updates().state());
  });

  // Restart Sova (Settings → General): 202 first, the service restarts a few seconds later.
  app.post("/api/updates/restart", async (c) => {
    const no = notOperator(c, "restart");
    if (no) {
      console.log(`[updates] restart refused: not the user's page`);
      return no;
    }
    try {
      const r = await updates().restart("browser");
      // The startedAt GET /api/health answers (one source, serverStart()): the restart is done once health answers another.
      return c.json({ scheduled: true, startedAt: serverStart().startedAt, inSeconds: r.inSeconds }, 202);
    } catch (err) {
      return refused(c, err);
    }
  });

  app.post("/api/updates/apply", async (c) => {
    const no = notOperator(c, "update");
    if (no) return no;
    let body: { target?: unknown; confirm?: unknown } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // not confirmed
    }
    if (body.confirm !== true) return c.json({ error: "Confirm the upgrade: { target, confirm: true }." }, 400);
    if (typeof body.target !== "string" || !/^[0-9a-f]{40,64}$/.test(body.target)) return c.json({ error: "Name the commit to upgrade to: { target: <sha> }." }, 400);
    try {
      await updates().apply({ target: body.target });
    } catch (err) {
      return refused(c, err);
    }
    return c.json(await updates().state());
  });
}
