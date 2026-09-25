import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statfsSync } from "node:fs";
import { availableParallelism, freemem, loadavg, totalmem, uptime } from "node:os";
import { dirname, join } from "node:path";
import type { HostDetails } from "../../shared/mesh-details";

// What a host can say about its machine, per OS (Linux, macOS, Android/Termux). Everything here is
// read on demand (GET /api/peer/details, while the mesh is on) and bounded: a file read, a statfs,
// or a helper command with a short timeout. What can't change while the process runs (model,
// commit, device type) is read once; the battery is cached, because Termux's reader takes a second.

/** The OS as this module sees it; tests replace it. */
export interface Machine {
  platform: string;
  read(path: string): string | null;
  list(dir: string): string[];
  /** stdout of a command, or null on failure or after `timeoutMs`. Never through a shell. */
  run(cmd: string, args: string[], timeoutMs: number): Promise<string | null>;
  now(): number;
}

export const realMachine: Machine = {
  platform: process.platform,
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  run(cmd, args, timeoutMs) {
    return new Promise((resolve) => {
      try {
        execFile(cmd, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
      } catch {
        resolve(null);
      }
    });
  },
  now: () => Date.now(),
};

// ---- battery ----------------------------------------------------------------------------------

export type Battery = { battery?: HostDetails["resources"]["battery"]; batteryHint?: "termux-api" };

/** termux-battery-status hangs without the Termux:API app, so it gets this long. */
export const TERMUX_BATTERY_TIMEOUT_MS = 3000;
const BATTERY_CACHE_MS = 60_000;
/** After Termux:API failed to answer, it is asked again this much later (the user may install it). */
const BATTERY_RETRY_MS = 5 * 60_000;

/** `termux-battery-status` JSON → a reading; null when it isn't one. */
export function parseTermuxBattery(out: string): HostDetails["resources"]["battery"] | null {
  try {
    const j = JSON.parse(out) as { percentage?: unknown; status?: unknown; plugged?: unknown };
    if (typeof j.percentage !== "number" || !Number.isFinite(j.percentage)) return null;
    const status = typeof j.status === "string" ? j.status.toUpperCase() : "";
    const plugged = typeof j.plugged === "string" && j.plugged.toUpperCase() !== "UNPLUGGED";
    return { percent: Math.round(j.percentage), charging: status === "CHARGING" || status === "FULL" || (status !== "DISCHARGING" && plugged) };
  } catch {
    return null;
  }
}

/** `pmset -g batt` → a reading; null without an internal battery (a desktop Mac). */
export function parsePmset(out: string): HostDetails["resources"]["battery"] | null {
  const m = /(\d+)%;\s*([a-z ]+?)\s*[;)]/i.exec(out);
  if (!m) return null;
  const state = m[2]!.toLowerCase();
  return { percent: Number(m[1]), charging: state === "charging" || state === "charged" || state === "finishing charge" || state === "ac attached" };
}

/** A laptop battery under /sys/class/power_supply (peripherals such as a pen or a mouse are skipped). */
export function linuxBattery(m: Machine): HostDetails["resources"]["battery"] | null {
  const root = "/sys/class/power_supply";
  for (const name of m.list(root).sort()) {
    const dir = join(root, name);
    if (m.read(join(dir, "type"))?.trim() !== "Battery") continue;
    if (m.read(join(dir, "scope"))?.trim() === "Device") continue;
    const capRaw = m.read(join(dir, "capacity"));
    const cap = Number(capRaw?.trim());
    if (capRaw === null || !capRaw.trim() || !Number.isFinite(cap)) continue;
    const status = m.read(join(dir, "status"))?.trim() ?? "";
    return { percent: Math.round(cap), charging: status === "Charging" || status === "Full" };
  }
  return null;
}

export class BatteryReader {
  private cached: { at: number; value: Battery; failed: boolean } | null = null;
  private pending: Promise<Battery> | null = null;

  constructor(private readonly m: Machine) {}

  /**
   * The latest reading, served from cache and refreshed behind it. Only `wait` makes the first
   * read wait for one (the device type, once); otherwise a request never waits on Termux:API:
   * before the first reading lands it has none, and the next poll shows it.
   */
  async read(wait = false): Promise<Battery> {
    const c = this.cached;
    const age = c ? this.m.now() - c.at : Infinity;
    if (c && age < (c.failed ? BATTERY_RETRY_MS : BATTERY_CACHE_MS)) return c.value;
    if (!this.pending) {
      this.pending = this.fresh().then((r) => {
        this.cached = { at: this.m.now(), value: r.value, failed: r.failed };
        this.pending = null;
        return r.value;
      });
    }
    return c ? c.value : wait ? this.pending : {};
  }

  private async fresh(): Promise<{ value: Battery; failed: boolean }> {
    if (this.m.platform === "android") {
      const out = await this.m.run("termux-battery-status", [], TERMUX_BATTERY_TIMEOUT_MS);
      const battery = out === null ? null : parseTermuxBattery(out);
      return battery ? { value: { battery }, failed: false } : { value: { batteryHint: "termux-api" }, failed: true };
    }
    if (this.m.platform === "darwin") {
      const out = await this.m.run("pmset", ["-g", "batt"], 2000);
      const battery = out === null ? null : parsePmset(out);
      return { value: battery ? { battery } : {}, failed: false };
    }
    if (this.m.platform === "linux") {
      const battery = linuxBattery(this.m);
      return { value: battery ? { battery } : {}, failed: false };
    }
    return { value: {}, failed: false };
  }
}

// ---- machine identity (read once) ---------------------------------------------------------------

// SMBIOS chassis types (DMTF DSP0134, "System Enclosure or Chassis Types").
const LAPTOP_CHASSIS = new Set([8, 9, 10, 11, 14, 30, 31, 32]);
const DESKTOP_CHASSIS = new Set([3, 4, 5, 6, 7, 13, 15, 16, 35, 36]);
const SERVER_CHASSIS = new Set([17, 23, 25, 28, 29]);

export function deviceType(m: Machine, hasBattery: boolean): HostDetails["identity"]["device"] {
  if (m.platform === "android") return "phone";
  if (m.platform === "darwin") return hasBattery ? "laptop" : "desktop";
  if (m.platform !== "linux") return "unknown";
  const chassis = Number(m.read("/sys/class/dmi/id/chassis_type")?.trim());
  if (LAPTOP_CHASSIS.has(chassis)) return "laptop";
  if (DESKTOP_CHASSIS.has(chassis)) return "desktop";
  if (SERVER_CHASSIS.has(chassis)) return "server";
  // A virtual machine reports "Other" (1): a cloud VM is a server.
  if (/^flags\s*:.*\bhypervisor\b/m.test(m.read("/proc/cpuinfo") ?? "")) return "server";
  return hasBattery ? "laptop" : "unknown";
}

/** The model name, when the OS says; placeholder strings firmware leaves in are dropped. */
export async function modelName(m: Machine): Promise<string | undefined> {
  let raw: string | null = null;
  if (m.platform === "android") {
    const [maker, model] = await Promise.all([m.run("getprop", ["ro.product.manufacturer"], 1000), m.run("getprop", ["ro.product.model"], 1000)]);
    const mk = maker?.trim() ?? "";
    const md = model?.trim() ?? "";
    raw = md && mk && !md.toLowerCase().startsWith(mk.toLowerCase()) ? `${mk[0]!.toUpperCase()}${mk.slice(1)} ${md}` : md || null;
  } else if (m.platform === "darwin") raw = await m.run("sysctl", ["-n", "hw.model"], 1000);
  else if (m.platform === "linux") {
    const vendor = m.read("/sys/class/dmi/id/sys_vendor")?.trim() ?? "";
    const product = m.read("/sys/class/dmi/id/product_name")?.trim() ?? "";
    raw = product && vendor && !product.toLowerCase().startsWith(vendor.split(" ")[0]!.toLowerCase()) ? `${vendor} ${product}` : product || null;
  }
  const v = raw?.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!v || /^(to be filled|default string|system product name|not specified|none|unknown)/i.test(v)) return undefined;
  return v;
}

/**
 * The commit this tree was built from: `<root>/BUILD_COMMIT` (a git-archive deploy writes JSON
 * `{commit}` there), else the checkout's HEAD, resolved through a worktree's `.git` file and
 * packed refs. Undefined when neither says.
 */
export function buildCommit(m: Machine, root: string): string | undefined {
  const sha = (s: string | null | undefined) => (s && /^[0-9a-f]{40}$/.test(s.trim()) ? s.trim() : undefined);
  const stamp = m.read(join(root, "BUILD_COMMIT"));
  if (stamp !== null) {
    try {
      const hit = sha((JSON.parse(stamp) as { commit?: string }).commit);
      if (hit) return hit;
    } catch {
      const hit = sha(stamp);
      if (hit) return hit;
    }
  }
  let gitDir = join(root, ".git");
  const file = m.read(gitDir);
  if (file !== null) {
    const m1 = /^gitdir:\s*(.+)$/m.exec(file);
    if (!m1) return undefined;
    gitDir = m1[1]!.trim().startsWith("/") ? m1[1]!.trim() : join(root, m1[1]!.trim());
  }
  const head = m.read(join(gitDir, "HEAD"))?.trim();
  if (!head) return undefined;
  if (!head.startsWith("ref:")) return sha(head);
  const ref = head.slice(4).trim();
  // A linked worktree keeps its refs in the common dir.
  const common = m.read(join(gitDir, "commondir"))?.trim();
  const commonDir = common ? (common.startsWith("/") ? common : join(gitDir, common)) : gitDir;
  for (const dir of [gitDir, commonDir]) {
    const hit = sha(m.read(join(dir, ref)));
    if (hit) return hit;
  }
  const packed = m.read(join(commonDir, "packed-refs")) ?? "";
  for (const line of packed.split("\n")) {
    const [s, name] = line.trim().split(" ");
    if (name === ref) return sha(s);
  }
  return undefined;
}

// ---- live figures ------------------------------------------------------------------------------

/** 1/5/15 load where the OS shows it: Android (10+) hides /proc/loadavg, and os.loadavg() then says 0. */
export function loadAverages(m: Machine): [number, number, number] | undefined {
  if (m.platform === "linux" || m.platform === "android") {
    const raw = m.read("/proc/loadavg");
    if (raw === null) return undefined;
    const [a, b, c] = raw.trim().split(/\s+/).map(Number);
    return [a, b, c].every((n) => Number.isFinite(n)) ? [a!, b!, c!] : undefined;
  }
  if (m.platform === "win32") return undefined;
  const l = loadavg();
  return [l[0]!, l[1]!, l[2]!];
}

export function machineUptime(): number | null {
  try {
    const s = uptime();
    return Number.isFinite(s) && s > 0 ? Math.round(s) : null;
  } catch {
    return null;
  }
}

/** Free and total bytes on the disk holding `dir` (its nearest existing ancestor). */
export function diskOf(dir: string): { free: number; total: number } | undefined {
  for (let d = dir; ; d = dirname(d)) {
    try {
      const s = statfsSync(d);
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {
      if (dirname(d) === d) return undefined;
    }
  }
}

export const cores = (): number => availableParallelism();
export const memory = (): { total: number; available: number } => ({ total: totalmem(), available: freemem() });
