import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNTS_DIR_NAME, ensureLoginDir, loginDir } from "../../pi-config/extensions/claude-code/accounts.ts";
import { acquireLocks, writeFileAtomic, type LockSpec } from "../sync/logins-stores";

/**
 * A login's own files, as they travel between devices (§app.claude-logins/borrow-return): Claude
 * Code's `.credentials.json`, byte for byte, and the few `.claude.json` keys that say who it is
 * (the rest of that file is per device: projects, tips, caches). Read and written under Claude
 * Code's own locks (`.oauth_refresh.lock`, then `<dir>.lock`), always at 0600 by tmp + rename.
 * Nothing here parses or logs a token.
 */

export const CREDENTIALS_FILE = ".credentials.json";
export const CLAUDE_JSON_FILE = ".claude.json";
/** The `.claude.json` keys that belong to the login itself. */
const LOGIN_KEYS = ["oauthAccount", "userID", "hasCompletedOnboarding", "lastOnboardingVersion"] as const;
/** Where an offered login waits, unused, until the keeper confirms: never a login directory. */
export const INCOMING_DIR_NAME = ".incoming";

export interface LoginFiles {
  /** `.credentials.json` exactly as Claude Code wrote it. */
  credentials: string;
  /** Just LOGIN_KEYS of `.claude.json`. */
  claudeJson: Record<string, unknown>;
}

export const incomingDir = (agentDir: string, id: string): string => {
  loginDir(agentDir, id); // validates the id
  return join(agentDir, ACCOUNTS_DIR_NAME, INCOMING_DIR_NAME, id);
};

function lockSpecs(dir: string): LockSpec[] {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // missing: the literal path, as Claude Code does
  }
  return [
    { file: join(dir, ".oauth_refresh"), lockfilePath: join(dir, ".oauth_refresh.lock"), stale: 60_000, update: 5_000 },
    { file: real, lockfilePath: `${real}.lock`, stale: 60_000, update: 5_000 },
  ];
}

async function underLocks<T>(dir: string, fn: () => T, deadlineMs = 30_000): Promise<T> {
  const locks = await acquireLocks(lockSpecs(dir), deadlineMs);
  try {
    const out = fn();
    if (locks.compromised()) throw new Error(`the lock on ${dir} was compromised`);
    return out;
  } finally {
    await locks.release();
  }
}

function pickLoginKeys(json: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!json || typeof json !== "object" || Array.isArray(json)) return out;
  for (const key of LOGIN_KEYS) if ((json as Record<string, unknown>)[key] !== undefined) out[key] = (json as Record<string, unknown>)[key];
  return out;
}

/** A fingerprint of the credentials (never sent anywhere): tells whether a copy changed since. */
export const credentialsHash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Read a login directory's files under Claude Code's locks. Throws when it holds no credentials. */
export async function readLoginFiles(dir: string, deadlineMs?: number): Promise<LoginFiles> {
  return underLocks(dir, () => {
    const credentials = readFileSync(join(dir, CREDENTIALS_FILE), "utf8");
    let claudeJson: Record<string, unknown> = {};
    try {
      claudeJson = pickLoginKeys(JSON.parse(readFileSync(join(dir, CLAUDE_JSON_FILE), "utf8")));
    } catch {
      // no identity file: Claude Code writes one again at its next start
    }
    return { credentials, claudeJson };
  }, deadlineMs);
}

/** A credentials text Claude Code could read: a JSON object. Nothing more is checked (no token is read). */
export function plausibleFiles(files: unknown): files is LoginFiles {
  if (!files || typeof files !== "object") return false;
  const f = files as Record<string, unknown>;
  if (typeof f.credentials !== "string" || f.credentials.length > 64 * 1024) return false;
  try {
    const parsed = JSON.parse(f.credentials) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  } catch {
    return false;
  }
  return !!f.claudeJson && typeof f.claudeJson === "object" && !Array.isArray(f.claudeJson);
}

function mergeClaudeJson(file: string, keys: Record<string, unknown>): void {
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch {
    // none yet
  }
  writeFileAtomic(file, JSON.stringify({ ...current, ...pickLoginKeys(keys) }, null, 2));
}

/** Put an offered login aside (0700 dir, 0600 files): durable, never used. */
export function stageLoginFiles(agentDir: string, id: string, files: LoginFiles): void {
  const dir = incomingDir(agentDir, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dir, CLAUDE_JSON_FILE), JSON.stringify(pickLoginKeys(files.claudeJson), null, 2));
  writeFileAtomic(join(dir, CREDENTIALS_FILE), files.credentials);
}
export const hasStaged = (agentDir: string, id: string): boolean => existsSync(join(incomingDir(agentDir, id), CREDENTIALS_FILE));
export function dropStaged(agentDir: string, id: string): void {
  rmSync(incomingDir(agentDir, id), { recursive: true, force: true });
}

/**
 * Move a staged login into its directory (created and linked against this device's `default`).
 * The credentials go last, by rename, so a crash leaves either the staged copy or the active one.
 */
export async function activateStaged(agentDir: string, id: string, defaultDir: string): Promise<void> {
  const from = incomingDir(agentDir, id);
  const dir = ensureLoginDir(agentDir, id, defaultDir);
  if (!existsSync(join(from, CREDENTIALS_FILE))) {
    if (existsSync(join(dir, CREDENTIALS_FILE))) return; // moved already (a crash after the rename)
    throw new Error(`nothing staged for ${id}`);
  }
  await underLocks(dir, () => {
    try {
      mergeClaudeJson(join(dir, CLAUDE_JSON_FILE), JSON.parse(readFileSync(join(from, CLAUDE_JSON_FILE), "utf8")));
    } catch {
      // no identity keys staged
    }
    renameSync(join(from, CREDENTIALS_FILE), join(dir, CREDENTIALS_FILE));
  });
  dropStaged(agentDir, id);
}

/** Write a returned login into its directory here (the keeper), under Claude Code's locks. */
export async function storeLoginFiles(agentDir: string, id: string, defaultDir: string, files: LoginFiles): Promise<void> {
  const dir = ensureLoginDir(agentDir, id, defaultDir);
  await underLocks(dir, () => {
    mergeClaudeJson(join(dir, CLAUDE_JSON_FILE), files.claudeJson);
    writeFileAtomic(join(dir, CREDENTIALS_FILE), files.credentials);
  });
}

/** Delete a login's directory here as plain files: never `claude auth logout` (it would revoke the copy that moved). */
export function deleteLoginFiles(agentDir: string, id: string): void {
  const dir = loginDir(agentDir, id);
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}.lock`, { recursive: true, force: true });
}

export function hasCredentials(agentDir: string, id: string): boolean {
  try {
    return statSync(join(loginDir(agentDir, id), CREDENTIALS_FILE)).isFile();
  } catch {
    return false;
  }
}
export function credentialsText(agentDir: string, id: string): string | undefined {
  try {
    return readFileSync(join(loginDir(agentDir, id), CREDENTIALS_FILE), "utf8");
  } catch {
    return undefined;
  }
}
