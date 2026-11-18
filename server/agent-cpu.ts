import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import { agentCoresRule, type AgentCpuState } from "../shared/agent-cpu";
import { check } from "../shared/form-rules";
import { yourClickRefusal } from "./page-only";
import { realExec, type Exec } from "./project-services/drivers";
import { stateRoot } from "./state-root";

/**
 * The agents' share of the CPU, on Linux with a systemd user manager (al_1 a5, a6).
 *
 * Every agent process Sova starts lives in systemd's `sova.slice`: chats in `sova-chats.slice`, their
 * background jobs in `sova-jobs.slice`, project services in `sova-services.slice` (a dash nests a slice
 * under its prefix). The server itself runs elsewhere (`app.slice`, a sibling at the default weight 100),
 * so a CPUWeight on the server's own unit never competed with the agents. At every start the server
 * gives `sova.slice` a lower CPUWeight (AGENTS_CPU_WEIGHT), so when the CPU is short the server's side
 * wins; and it holds the user's optional ceiling, "Agents may use at most N of M cores", as
 * `CPUQuota=N×100%` on the same slice.
 *
 * Both are set with `systemctl --user set-property --runtime`: Sova's own file
 * (`<state root>/agent-cpu.json`) is the one record of the ceiling and the server applies it at every
 * start, so a runtime drop-in (gone at logout or reboot) never outlives what Sova remembers, and nothing
 * is left in `~/.config/systemd` once Sova is gone. Turning the ceiling off sets `CPUQuota=` (none).
 *
 * Opt-in by identity: only a server that runs as Sova's installed service (SOVA_SERVICE_UNITS, read from
 * `/proc/self/cgroup`) ever touches the slice. A dev, hermetic, test, merge-copy or load-experiment server
 * shares the machine's one `sova.slice` with the real server, so it leaves it alone whatever its
 * environment says. Also a no-op on macOS, on a Linux without a user manager, when this server's chats
 * run in another slice (a test run's `SOVA_CHAT_SLICE`, detached chats), when this server itself runs
 * inside `sova.slice`, and with `SOVA_AGENT_CPU=off` (dev:hermetic and the test runner set it too).
 * The command runner and the cgroup reader are injected: tests never reach systemd.
 */

export const AGENTS_SLICE = "sova.slice";
/** `sova.slice`'s CPU weight: a fifth of the default 100 its siblings (`app.slice`, where the server runs) keep. */
export const AGENTS_CPU_WEIGHT = 20;
export const AGENT_CPU_FILE = "agent-cpu.json";
export const agentCpuPath = (): string => join(stateRoot(), AGENT_CPU_FILE);
/** The default chats' and jobs' slices (server/chat-runtime/supervisor.ts CHAT_SLICE, server/background-jobs-capture.ts JOBS_SLICE). */
const DEFAULT_SLICES: Record<string, string> = { SOVA_CHAT_SLICE: "sova-chats.slice", SOVA_JOBS_SLICE: "sova-jobs.slice" };
const SYSTEMCTL_MS = 5_000;
/** The units an installed Sova server runs as: install.sh's `sova.service`, and `sova-runtime.service`. */
export const SOVA_SERVICE_UNITS: readonly string[] = ["sova.service", "sova-runtime.service"];

/** The unit this process runs in, from `/proc/self/cgroup`'s unified (`0::`) line: its last path part, or null. */
export function ownUnit(cgroup: string | null): string | null {
  const line = cgroup?.split("\n").find((l) => l.startsWith("0::"));
  return line?.slice(3).trim().split("/").pop() || null;
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const log = (line: string) => console.log(`[agent-cpu] ${line}`);

/** A refusal or failure of a change, with the status the route answers. */
export class AgentCpuError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 502,
  ) {
    super(message);
  }
}

export interface AgentCpuDeps {
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cores?: () => number;
  /** This process's own cgroup (`/proc/self/cgroup`'s text), or null when unreadable. */
  ownCgroup?: () => string | null;
  /** The saved ceiling's file. */
  file?: () => string;
}

/**
 * Why this server leaves the agents' slice alone, from what it knows without asking systemd, or null.
 * One sentence, shown under the setting.
 */
export function staticObstacle(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, ownCgroup: string | null): string | null {
  if (platform !== "linux") return `This needs Linux with systemd. On ${platform === "darwin" ? "macOS" : platform}, agents don't run in a systemd slice Sova can limit.`;
  if ((env.SOVA_AGENT_CPU ?? "").trim().toLowerCase() === "off") return "This copy of Sova leaves the agents' CPU alone (SOVA_AGENT_CPU=off).";
  if ((env.SOVA_CHAT_DRIVER ?? "").trim() === "detached") return "Chats run as detached processes here, not in systemd's sova.slice.";
  for (const [name, dflt] of Object.entries(DEFAULT_SLICES)) {
    const v = env[name]?.trim();
    if (v && v !== dflt) return `This copy's agents run in their own slice (${v}), not in sova.slice.`;
  }
  if (ownCgroup && ownCgroup.includes(`/${AGENTS_SLICE}/`)) return "This server runs inside sova.slice itself, so a limit there would slow it too.";
  const unit = ownUnit(ownCgroup);
  if (!unit || !SOVA_SERVICE_UNITS.includes(unit)) return `Only Sova's installed service sets this; this copy runs ${unit ? `as ${unit}` : "outside a systemd service"}.`;
  return null;
}

/** systemd's timespan (`4s`, `1.500000s`, `500ms`, `1min 4s`) in seconds, or null for `infinity` or anything else. */
export function timespanSeconds(text: string): number | null {
  const t = text.trim();
  if (!t || t === "infinity") return null;
  const unit: Record<string, number> = { us: 1e-6, ms: 1e-3, s: 1, min: 60, h: 3600 };
  let total = 0;
  for (const part of t.split(/\s+/)) {
    const m = /^(\d+(?:\.\d+)?)(us|ms|s|min|h)$/.exec(part);
    if (!m) return null;
    total += Number(m[1]) * unit[m[2]!]!;
  }
  return total;
}

/** `systemctl show`'s `KEY=value` lines as a record. */
const props = (stdout: string): Record<string, string> =>
  Object.fromEntries(
    stdout
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const)
      .filter(([k]) => k),
  );

/** What systemd holds on the slice: its weight (null: not set) and its quota in cores (null: none). */
interface SliceNow {
  weight: number | null;
  quotaCores: number | null;
}

export class AgentCpu {
  private readonly exec: Exec;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly cores: () => number;
  private readonly ownCgroup: () => string | null;
  private readonly file: () => string;
  private probe: Promise<string | null> | null = null;
  /** Changes run one at a time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(d: AgentCpuDeps = {}) {
    this.exec = d.exec ?? realExec;
    this.env = d.env ?? process.env;
    this.platform = d.platform ?? process.platform;
    this.cores = d.cores ?? availableParallelism;
    this.ownCgroup =
      d.ownCgroup ??
      (() => {
        try {
          return readFileSync("/proc/self/cgroup", "utf8");
        } catch {
          return null;
        }
      });
    this.file = d.file ?? agentCpuPath;
  }

  /** Why the slice is left alone, or null: the static reasons, then whether a user manager answers (asked once). */
  obstacle(): Promise<string | null> {
    this.probe ??= (async () => {
      const why = staticObstacle(this.env, this.platform, this.ownCgroup());
      if (why) return why;
      const r = await this.systemctl(["show", "--property=Version"]);
      return r.code === 0 ? null : "No systemd user manager answers on this computer, so agents don't run in a slice Sova can limit.";
    })();
    return this.probe;
  }

  /** The saved ceiling in cores, or null (no file: off, the default). A file that isn't a whole number ≥ 1 counts as off, with a warning. */
  saved(): number | null {
    let text: string;
    try {
      text = readFileSync(this.file(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") log(`${this.file()} unreadable (${msg(err)}); no ceiling`);
      return null;
    }
    try {
      const v = (JSON.parse(text) as { maxCores?: unknown } | null)?.maxCores;
      if (v === null || v === undefined) return null;
      if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
    } catch {
      /* below */
    }
    log(`${this.file()} holds no whole maxCores; no ceiling`);
    return null;
  }

  async state(): Promise<AgentCpuState> {
    const why = await this.obstacle();
    const now = why ? null : await this.now().catch(() => null);
    return { available: why === null, why, cores: this.cores(), maxCores: this.saved(), inForce: now?.quotaCores ?? null };
  }

  /**
   * At a server's start: the lower weight, and the saved ceiling (or none), each set only where
   * systemd holds something else. Never throws; says what it did.
   */
  applyAtStart(): Promise<void> {
    return this.serial(async () => {
      const why = await this.obstacle();
      if (why) {
        log(`left alone: ${why}`);
        return;
      }
      try {
        const now = await this.now();
        const max = this.saved();
        const set: string[] = [];
        if (now.weight !== AGENTS_CPU_WEIGHT) set.push(`CPUWeight=${AGENTS_CPU_WEIGHT}`);
        if (now.quotaCores !== max) set.push(quotaProperty(max));
        if (set.length) await this.setProperty(set);
        log(`${AGENTS_SLICE}: CPUWeight=${AGENTS_CPU_WEIGHT}, ${max === null ? "no CPU ceiling" : `at most ${max} of ${this.cores()} cores`}${set.length ? "" : " (already so)"}`);
      } catch (err) {
        log(`couldn't set ${AGENTS_SLICE}'s CPU: ${msg(err)}`);
      }
    });
  }

  /**
   * After the file was put back by someone else (a refused settings card restores it byte for byte): systemd
   * follows the file. Throws when systemd refuses, so the caller can say the change stayed.
   */
  matchFile(): Promise<void> {
    return this.serial(async () => {
      if (await this.obstacle()) return;
      const max = this.saved();
      if ((await this.now()).quotaCores !== max) await this.setProperty([quotaProperty(max)]);
    });
  }

  /** Set the ceiling (cores) or remove it (null): systemd first, then the file; a refusal changes neither. */
  set(raw: unknown): Promise<AgentCpuState> {
    return this.serial(async () => {
      const why = await this.obstacle();
      if (why) throw new AgentCpuError(`${why} Nothing changed.`, 409);
      let max: number | null = null;
      if (raw !== null) {
        const r = check(agentCoresRule(this.cores()), raw);
        if (!r.ok || r.value === null) throw new AgentCpuError(r.ok ? "Expected { maxCores: <whole number> | null }." : r.message, 400);
        max = r.value;
      }
      const before = this.saved();
      try {
        await this.setProperty([quotaProperty(max)]);
      } catch (err) {
        throw new AgentCpuError(`systemd didn't take the change: ${msg(err)} Nothing changed.`, 502);
      }
      try {
        this.write(max);
      } catch (err) {
        // The file is the record: put systemd back as it was, so the two never disagree.
        await this.setProperty([quotaProperty(before)]).catch(() => {});
        throw new AgentCpuError(`Couldn't save the setting (${msg(err)}). Nothing changed.`, 502);
      }
      log(max === null ? `${AGENTS_SLICE}: CPU ceiling removed` : `${AGENTS_SLICE}: at most ${max} of ${this.cores()} cores`);
      return this.state();
    });
  }

  private write(max: number | null): void {
    const file = this.file();
    if (max === null) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ maxCores: max }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }

  private async now(): Promise<SliceNow> {
    const r = await this.systemctl(["show", AGENTS_SLICE, "--property=CPUWeight", "--property=CPUQuotaPerSecUSec"]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `systemctl show exited ${r.code}`);
    const p = props(r.stdout);
    const w = Number(p.CPUWeight);
    // [not set] or the "unset" sentinel (2^64−1) are no weight.
    const weight = /^\d+$/.test(p.CPUWeight ?? "") && w >= 1 && w <= 10_000 ? w : null;
    const secs = timespanSeconds(p.CPUQuotaPerSecUSec ?? "");
    return { weight, quotaCores: secs === null ? null : Math.round(secs * 100) / 100 };
  }

  private async setProperty(assignments: string[]): Promise<void> {
    const r = await this.systemctl(["set-property", "--runtime", AGENTS_SLICE, ...assignments]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `systemctl set-property exited ${r.code}`);
  }

  private systemctl(args: string[]) {
    return this.exec("systemctl", ["--user", ...args], { timeoutMs: SYSTEMCTL_MS });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }
}

/** The quota assignment for a ceiling of `max` cores, or none. */
export const quotaProperty = (max: number | null): string => `CPUQuota=${max === null ? "" : `${max * 100}%`}`;

let shared: AgentCpu | null = null;
export const agentCpu = (): AgentCpu => (shared ??= new AgentCpu());
/** Tests: the one the server uses, with a stand-in systemctl (null: the real one again). */
export const setAgentCpuForTest = (cpu: AgentCpu | null): void => void (shared = cpu);

const NO_STORE = { "Cache-Control": "no-store" };

/** GET and PUT `/api/settings/agent-cpu` (Settings → General's Agents' CPU). Reading is any gated caller's;
    a change is the user's own click on their page alone (§app.access/your-click): never a chat, a script,
    an extension, the Overseer or another computer. */
export function registerAgentCpuRoutes(app: Hono, cpu: () => AgentCpu = agentCpu): void {
  app.get("/api/settings/agent-cpu", async (c) => c.json(await cpu().state(), 200, NO_STORE));
  app.put("/api/settings/agent-cpu", async (c) => {
    const notYou = yourClickRefusal(c, "agentCpu");
    if (notYou) return notYou;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    const max = body && typeof body === "object" && "maxCores" in body ? (body as { maxCores: unknown }).maxCores : undefined;
    if (max === undefined) return c.json({ error: "Expected { maxCores: <whole number> | null }." }, 400);
    try {
      return c.json(await cpu().set(max), 200, NO_STORE);
    } catch (err) {
      if (err instanceof AgentCpuError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });
}
