import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "./state-root";

// The Jev key: `<stateRoot>/secrets/jev-key` (dir 0700, file 0600), plain text, the whole file is
// the key. SOVA_JEV_KEY overrides it (hermetic runs, tests). The key is read per call, never
// logged, never sent to the browser (the wire carries DecisionKeyInfo: present/last4/status), and
// the Overseer's Redactor reads the same file (overseer-redact.ts secretSources).

export const JEV_KEY_ENV = "SOVA_JEV_KEY";
export const KEY_MIN = 20;
export const KEY_MAX = 512;

export const jevKeyFile = () => join(stateRoot(), "secrets", "jev-key");

/** A usable key: trimmed, KEY_MIN..KEY_MAX characters, no whitespace inside. Else null. */
export function cleanKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  if (key.length < KEY_MIN || key.length > KEY_MAX || /\s/.test(key)) return null;
  return key;
}

export interface StoredKey {
  key: string;
  source: "file" | "env";
}

export function readJevKey(env: NodeJS.ProcessEnv = process.env): StoredKey | null {
  const fromEnv = cleanKey(env[JEV_KEY_ENV]);
  if (fromEnv) return { key: fromEnv, source: "env" };
  try {
    const fromFile = cleanKey(readFileSync(jevKeyFile(), "utf8"));
    return fromFile ? { key: fromFile, source: "file" } : null;
  } catch {
    return null;
  }
}

/** Store the key atomically with owner-only permissions. Throws on a key cleanKey refuses. */
export function writeJevKey(raw: string): void {
  const key = cleanKey(raw);
  if (!key) throw new Error(`a Jev key is ${KEY_MIN}..${KEY_MAX} characters with no spaces`);
  const file = jevKeyFile();
  const dir = join(stateRoot(), "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function deleteJevKey(): void {
  rmSync(jevKeyFile(), { force: true });
}

export const last4 = (key: string) => key.slice(-4);
