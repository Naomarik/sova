import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";

// Pairing codes are credentials, not session data. Re-read on every call, and never log them.
// Synchronous read/consume/write keeps two requests in this listener from spending one twice.
const LIFETIME_MS = 5 * 60_000;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
export interface PairingCode {
  code: string;
  at: string;
  expiresAt: string;
}
const codesFile = (): string => join(stateRoot(), "auth-codes.json");
const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** A missing, unreadable or malformed store authorizes nothing, including a partly valid one. */
function readCodes(): PairingCode[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(codesFile(), "utf8"));
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    for (const row of raw) {
      if (!row || typeof row !== "object" || typeof row.code !== "string" || !CODE_RE.test(row.code) ||
          typeof row.at !== "string" || typeof row.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(row.at)) || !Number.isFinite(Date.parse(row.expiresAt)) ||
          Date.parse(row.expiresAt) - Date.parse(row.at) !== LIFETIME_MS || seen.has(row.code)) return [];
      seen.add(row.code);
    }
    return raw as PairingCode[];
  } catch {
    return [];
  }
}

function writeCodes(codes: PairingCode[], now: number): void {
  const file = codesFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(codes.filter((c) => Date.parse(c.expiresAt) > now))}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function mintCode(): PairingCode {
  const codes = readCodes();
  const now = Date.now();
  let code: string;
  do { code = randomBytes(32).toString("base64url"); } while (codes.some((c) => c.code === code));
  const minted = { code, at: new Date(now).toISOString(), expiresAt: new Date(now + LIFETIME_MS).toISOString() };
  writeCodes([...codes, minted], now);
  return minted;
}

/** Consume before setting a cookie: a failed write cannot report a successful exchange. */
export function consumeCode(code: string): boolean {
  const codes = readCodes();
  const now = Date.now();
  const candidate = digest(code);
  let matched = -1;
  for (const [i, row] of codes.entries()) {
    if (timingSafeEqual(candidate, digest(row.code)) && Date.parse(row.expiresAt) > now) matched = i;
  }
  if (matched < 0) return false;
  codes.splice(matched, 1);
  writeCodes(codes, now);
  return true;
}
