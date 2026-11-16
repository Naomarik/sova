import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TunnelMode } from "../../../shared/public-links";
import { keyOfRecordId, tunnelsFile } from "./units";

/**
 * `<stateRoot>/tunnels/tunnels.json` (§mesh.tunnel/lifetime): the tunnels Sova started and still
 * holds, so a restarted Sova reattaches them. Strict: a file that doesn't parse adopts nothing. Mode
 * 0600, written whole through a rename; removed when no tunnel is left (so an idle Sova finds none).
 */

export interface TunnelRecord {
  mode: TunnelMode;
  unit: string;
  driver: "systemd" | "detached";
  metricsPort: number;
  /** The loopback port it forwards to (Free), recorded so a restarted Sova binds exactly that one. */
  targetPort: number;
  /** https://<host> once known; an Account tunnel's saved public address. */
  origin: string | null;
  connectorId: string | null;
  /** When this address began (ms); null until it is known. */
  epoch: number | null;
  startedAt: number;
  startedBy: string;
  /** When the address was checked from outside and answered as Sova. */
  verifiedAt?: number;
  previous?: { origin: string; endedAt: number };
  /** Starts from an exit event, for the hourly budget. */
  autoRestarts: number[];
}

export interface TunnelsFile {
  version: 1;
  tunnels: Record<string, TunnelRecord>;
}

export type TunnelsReading = { kind: "missing" } | { kind: "broken"; reason: string } | { kind: "ok"; file: TunnelsFile };

const isInt = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const isPort = (v: unknown): v is number => isInt(v, 1, 65535);
const isStrOrNull = (v: unknown): v is string | null => v === null || (typeof v === "string" && v.length <= 2048);

function parseRecord(v: unknown): TunnelRecord | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.mode !== "quick" && r.mode !== "account") return null;
  if (typeof r.unit !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(r.unit)) return null;
  if (r.driver !== "systemd" && r.driver !== "detached") return null;
  if (!isPort(r.metricsPort) || !isPort(r.targetPort)) return null;
  if (!isStrOrNull(r.origin) || !isStrOrNull(r.connectorId)) return null;
  if (r.origin !== null && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(r.origin)) return null;
  if (r.epoch !== null && !isInt(r.epoch)) return null;
  if (!isInt(r.startedAt) || typeof r.startedBy !== "string" || r.startedBy.length > 200) return null;
  if (r.verifiedAt !== undefined && !isInt(r.verifiedAt)) return null;
  let previous: TunnelRecord["previous"];
  if (r.previous !== undefined) {
    const p = r.previous as Record<string, unknown> | null;
    if (!p || typeof p.origin !== "string" || !isInt(p.endedAt)) return null;
    previous = { origin: p.origin, endedAt: p.endedAt };
  }
  if (!Array.isArray(r.autoRestarts) || r.autoRestarts.length > 100 || !r.autoRestarts.every((t) => isInt(t))) return null;
  return {
    mode: r.mode,
    unit: r.unit,
    driver: r.driver,
    metricsPort: r.metricsPort,
    targetPort: r.targetPort,
    origin: r.origin,
    connectorId: r.connectorId,
    epoch: r.epoch as number | null,
    startedAt: r.startedAt,
    startedBy: r.startedBy,
    ...(r.verifiedAt !== undefined ? { verifiedAt: r.verifiedAt as number } : {}),
    ...(previous ? { previous } : {}),
    autoRestarts: r.autoRestarts as number[],
  };
}

/** The file's text → its tunnels, or why it can't be read (pure, for tests). Any bad record fails the whole file. */
export function parseTunnels(text: string): { ok: true; file: TunnelsFile } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  const o = raw as { version?: unknown; tunnels?: unknown } | null;
  if (!o || typeof o !== "object" || o.version !== 1) return { ok: false, reason: "not version 1" };
  if (!o.tunnels || typeof o.tunnels !== "object" || Array.isArray(o.tunnels)) return { ok: false, reason: "no tunnels" };
  const tunnels: Record<string, TunnelRecord> = {};
  for (const [id, v] of Object.entries(o.tunnels as Record<string, unknown>)) {
    if (!keyOfRecordId(id)) return { ok: false, reason: `bad tunnel id ${id.slice(0, 40)}` };
    const rec = parseRecord(v);
    if (!rec) return { ok: false, reason: `bad record ${id}` };
    tunnels[id] = rec;
  }
  return { ok: true, file: { version: 1, tunnels } };
}

export function readTunnels(file = tunnelsFile()): TunnelsReading {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "broken", reason: (err as Error).message };
  }
  const p = parseTunnels(text);
  return p.ok ? { kind: "ok", file: p.file } : { kind: "broken", reason: p.reason };
}

/** Write the file whole (0600, its folder 0700), or remove it when no tunnel is left. */
export function writeTunnels(tunnels: Record<string, TunnelRecord>, file = tunnelsFile()): void {
  if (!Object.keys(tunnels).length) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ version: 1, tunnels } satisfies TunnelsFile, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
