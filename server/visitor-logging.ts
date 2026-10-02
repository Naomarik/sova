import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VisitorLogging } from "../shared/public-links";
import { stateRoot } from "./state-root";

/**
 * The host's two visitor switches (§mesh.public/visitor-log): `<stateRoot>/visitor-logging.json`
 * `{version: 1, logVisitors, forwardIp}`, 0600, written atomically. Read tolerantly: a missing
 * file or anything not exactly that shape is both off. Re-read when the file's stamp changes, so
 * a hand edit applies without a restart.
 */

export const VISITOR_LOGGING_FILE = "visitor-logging.json";
const OFF: VisitorLogging = { logVisitors: false, forwardIp: false };
const fileOf = (): string => join(stateRoot(), VISITOR_LOGGING_FILE);

let cached: { path: string; stamp: string; value: VisitorLogging } | null = null;

export function readVisitorLogging(): VisitorLogging {
  const path = fileOf();
  let stamp = "";
  try {
    const s = statSync(path);
    stamp = `${s.size}:${s.mtimeMs}`;
  } catch {
    return OFF;
  }
  if (cached?.path === path && cached.stamp === stamp) return cached.value;
  let value = OFF;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (v?.version === 1 && typeof v.logVisitors === "boolean" && typeof v.forwardIp === "boolean" && Object.keys(v).length === 3)
      value = { logVisitors: v.logVisitors, forwardIp: v.forwardIp };
  } catch {
    // unreadable: both off
  }
  cached = { path, stamp, value };
  return value;
}

/** A PUT body: both booleans, nothing else; null otherwise. */
export function parseVisitorLogging(body: unknown): VisitorLogging | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.logVisitors !== "boolean" || typeof b.forwardIp !== "boolean" || Object.keys(b).length !== 2) return null;
  return { logVisitors: b.logVisitors, forwardIp: b.forwardIp };
}

export function writeVisitorLogging(next: VisitorLogging): VisitorLogging {
  const path = fileOf();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, logVisitors: next.logVisitors, forwardIp: next.forwardIp }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  cached = null;
  return readVisitorLogging();
}
