import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context, Hono } from "hono";
import { OVERSEER_SENDER_HEADER } from "../overseer-sender";
import { serverCheckout, serverStart } from "../project-services/self-host";
import { stateHash } from "../project-services/store";
import { agentRoot, stateRoot } from "../state-root";
import { repoUrlOf } from "./check";
import { firstLine, gitIn, realExec } from "./git";
import { detectInstall, realProbe, type InstallInfo } from "./install-kind";
import { UpdatesManager, UpdatesRefusal } from "./manager";
import { installRunner, type UpgradePlan } from "./runner";
import { checksOffIn } from "./state";

/**
 * The Updates routes. Reading is any gated caller's; checking, saving the settings
 * and upgrading are the operator's alone: a request on the main listener
 * that a browser marks same-origin, never an in-process call, the peer listener or the Overseer.
 */

export const OPERATOR_ONLY = "Updates are the operator's: open Settings → General.";

/** Why this request may not act on updates, or null when it is the operator's. */
export function operatorRefusal(c: Context): string | null {
  const env = c.env as { incoming?: unknown; meshPeer?: unknown } | undefined;
  if (!env?.incoming || env.meshPeer) return OPERATOR_ONLY;
  // The Overseer's in-process calls carry this header; a browser never does, so any value refuses.
  if (c.req.header(OVERSEER_SENDER_HEADER) !== undefined) return OPERATOR_ONLY;
  if ((c.req.header("sec-fetch-site") ?? "").toLowerCase() !== "same-origin") return OPERATOR_ONLY;
  return null;
}

let listen = { port: Number(process.env.PORT) || 4800, host: process.env.HOST || "127.0.0.1" };
let manager: UpdatesManager | null = null;

/** The environment the job's programs get: what install.sh, git, pnpm and systemctl need. */
const JOB_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SHELL", "TMPDIR", "PI_CODING_AGENT_DIR", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "MISE_DATA_DIR", "SOVA_UPDATES_REPO_URL", "SOVA_RUNTIME", "SOVA_BUN", "SOVA_NODE"];

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

let installCache: { at: number; info: Promise<InstallInfo> } | null = null;

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
    jobEnv: () => Object.fromEntries(JOB_ENV.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))),
    serverLog: join(stateRoot(), "app-server.log"),
    log: (line) => console.log(line),
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
  updates().start();
}

const refused = (c: Context, err: unknown) => {
  if (err instanceof UpdatesRefusal) return c.json({ error: err.message }, err.status);
  throw err;
};

export function registerUpdatesRoutes(app: Hono): void {
  app.get("/api/updates", async (c) => c.json(await updates().state()));

  app.post("/api/updates/check", async (c) => {
    const no = operatorRefusal(c);
    if (no) return c.json({ error: no }, 403);
    try {
      await updates().check();
    } catch (err) {
      return refused(c, err);
    }
    return c.json(await updates().state());
  });

  app.put("/api/updates/settings", async (c) => {
    const no = operatorRefusal(c);
    if (no) return c.json({ error: no }, 403);
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

  app.post("/api/updates/apply", async (c) => {
    const no = operatorRefusal(c);
    if (no) return c.json({ error: no }, 403);
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
