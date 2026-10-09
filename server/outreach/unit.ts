import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SenderUnit } from "../../shared/outreach";

/**
 * A sender's systemd user unit (§app.outreach/sender-controls): Sova keeps the sender a separate
 * program, and only offers **Start Sender** while its unit is installed, serves that sender's socket,
 * and is inactive or failed. This host's own sender is `sova-whatsapp.service`; a number added as
 * `<name>` is the template instance `sova-whatsapp@<name>.service` (or the plain unit, if that serves its socket). Start runs `systemctl --user start` once per press: never a restart,
 * a stop, or a loop. Anything else (no systemd, another unit, an EnvironmentFile Sova can't read)
 * offers nothing.
 */

export const SENDER_UNIT = "sova-whatsapp.service";
/** The units that may serve a sender: an added number's template instance first. */
export const unitNames = (name?: string): string[] => (name ? [`sova-whatsapp@${name}.service`, SENDER_UNIT] : [SENDER_UNIT]);

export type Systemctl = (args: string[]) => Promise<{ code: number; stdout: string }>;

const realSystemctl: Systemctl = (args) =>
  new Promise((done) => {
    execFile("systemctl", ["--user", ...args], { timeout: 20_000, env: process.env }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      done({ code, stdout: String(stdout ?? "") });
    });
  });

let systemctl: Systemctl = realSystemctl;
let platform: NodeJS.Platform = process.platform;

/** Tests: a stand-in for `systemctl --user` (null: the real one), and the platform it answers on. */
export function setSystemctlForTest(fn: Systemctl | null, os: NodeJS.Platform = "linux"): void {
  systemctl = fn ?? realSystemctl;
  platform = fn ? os : process.platform;
  cache.clear();
}

/** `Environment=A=1 B="two words"` as a map (systemd quotes a value with spaces). */
export function parseEnvironment(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|\S*)/g)) {
    const raw = m[2]!;
    out[m[1]!] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
  }
  return out;
}

/** The socket a sender started with `env` listens on, as the sender itself resolves it (services/whatsapp/src/config.mjs). */
export function unitSocket(env: Record<string, string>, home = homedir()): string {
  const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
  if (env.SOVA_WA_SOCKET) return resolve(expand(env.SOVA_WA_SOCKET));
  const agent = env.PI_CODING_AGENT_DIR ? expand(env.PI_CODING_AGENT_DIR) : join(home, ".pi", "agent");
  const waHome = resolve(env.SOVA_WA_HOME ? expand(env.SOVA_WA_HOME) : join(agent, "sova", "whatsapp"));
  try {
    const file = JSON.parse(readFileSync(join(waHome, "config.json"), "utf8")) as Record<string, unknown>;
    if (typeof file.SOVA_WA_SOCKET === "string" && file.SOVA_WA_SOCKET) return resolve(expand(file.SOVA_WA_SOCKET));
  } catch {
    // no config.json, or not one the sender would start with: its default
  }
  return join(waHome, "sender.sock");
}

const cache = new Map<string, { at: number; unit: SenderUnit | null }>();
const CACHE_MS = 10_000;

/** The unit when one is installed and serves `socket` (`name`: an added number's); null otherwise. Read at most every 10 s. */
export async function senderUnit(socket: string, name?: string, now = Date.now()): Promise<SenderUnit | null> {
  const key = `${name ?? ""}\0${socket}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.unit;
  let unit: SenderUnit | null = null;
  for (const n of unitNames(name)) if ((unit = await readUnit(n, socket))) break;
  cache.set(key, { at: now, unit });
  return unit;
}

async function readUnit(name: string, socket: string): Promise<SenderUnit | null> {
  if (platform !== "linux") return null;
  let out: { code: number; stdout: string };
  try {
    out = await systemctl(["show", name, "--property=LoadState,ActiveState,Environment"]);
  } catch {
    return null;
  }
  if (out.code !== 0) return null;
  const props: Record<string, string> = {};
  for (const line of out.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
  }
  if (props.LoadState !== "loaded" || !props.ActiveState) return null;
  if (unitSocket(parseEnvironment(props.Environment ?? "")) !== resolve(socket)) return null;
  return { name, active: props.ActiveState };
}

/** Whether Start may run now: installed, serving this socket, and not running. */
export const startable = (u: SenderUnit | null | undefined): boolean => !!u && (u.active === "inactive" || u.active === "failed");

/** One `systemctl --user start` of the unit serving `socket`, only while startable. */
export async function startSenderUnit(socket: string, name?: string): Promise<{ ok: true } | { ok: false; why: string }> {
  cache.clear();
  const unit = await senderUnit(socket, name);
  if (!unit) return { ok: false, why: `No ${unitNames(name).join(" or ")} user unit serves this sender's socket, so Sova has nothing to start.` };
  if (!startable(unit)) return { ok: false, why: `${unit.name} is ${unit.active}: Sova starts it only while it is stopped.` };
  const r = await systemctl(["start", unit.name]).catch(() => ({ code: 1, stdout: "" }));
  cache.clear();
  if (r.code !== 0) return { ok: false, why: `systemctl --user start ${unit.name} failed (exit ${r.code}). See journalctl --user -u ${unit.name}.` };
  return { ok: true };
}
