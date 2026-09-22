import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";
import type { WebSettings } from "../shared/protocol";

/**
 * Sova's own settings — the ones that belong to the webapp rather than to pi or to an
 * extension's shared file. Today that is one experimental switch (Claude Code as first-class
 * models). Unlike server/settings.ts, whose file shape is a contract with the subagents
 * extension, nothing outside Sova reads this one.
 *
 * It lives under the agent dir, so PI_CODING_AGENT_DIR (the hermetic .agent) isolates it the
 * same way it isolates sessions and web-sessions.json.
 */
const FILE = join(stateRoot(), "settings.json");

/** Everything off: what a missing, unreadable or foreign-shaped file reads as. */
const DEFAULTS: WebSettings = { experimental: { claudeCodeProvider: false } };

const settings = (claudeCodeProvider: boolean): WebSettings => ({ experimental: { claudeCodeProvider } });

/**
 * Read the stored settings, tolerantly: anything unexpected reads as the defaults rather than
 * throwing, because a broken settings file must not stop the server from serving.
 */
export function readWebSettings(): WebSettings {
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
    if (data.version !== 1) return DEFAULTS;
    const experimental = data.experimental;
    if (experimental === null || typeof experimental !== "object" || Array.isArray(experimental)) return DEFAULTS;
    const flag = (experimental as Record<string, unknown>).claudeCodeProvider;
    return settings(flag === true);
  } catch {
    return DEFAULTS; // missing or corrupt: everything off
  }
}

/**
 * Validate and persist. Writes are re-read + merge (like web-sessions.ts): the file on disk is
 * the source of truth, and only the keys this request carries are replaced, so a setting another
 * server instance added survives. Atomic via tmp + rename.
 */
export function writeWebSettings(raw: unknown): WebSettings | { error: string } {
  const bad = { error: "Expected { experimental: { claudeCodeProvider: boolean } }" };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad;
  const experimental = (raw as Record<string, unknown>).experimental;
  if (experimental === null || typeof experimental !== "object" || Array.isArray(experimental)) return bad;
  const flag = (experimental as Record<string, unknown>).claudeCodeProvider;
  if (typeof flag !== "boolean") return bad;

  // Re-read so keys we do not know about, or that another writer just added, are not dropped.
  let stored: Record<string, unknown> = {};
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
    if (data !== null && typeof data === "object" && !Array.isArray(data)) stored = data;
  } catch {
    stored = {}; // missing or corrupt: start from nothing rather than refusing the write
  }
  const storedExperimental =
    stored.experimental !== null && typeof stored.experimental === "object" && !Array.isArray(stored.experimental)
      ? (stored.experimental as Record<string, unknown>)
      : {};

  const next = { ...stored, version: 1, experimental: { ...storedExperimental, claudeCodeProvider: flag } };
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, "\t")}\n`);
  renameSync(tmp, FILE);
  return settings(flag);
}

/** Shorthand for the one consumer that only cares about the switch (chat-manager, startup). */
export const claudeCodeProviderEnabled = (): boolean => readWebSettings().experimental.claudeCodeProvider;
