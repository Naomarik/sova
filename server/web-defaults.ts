import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * New-session defaults for model + thinking level: what a session with NO messages yet starts
 * from (server/chat-manager createRuntime), saved when the user changes either in a session that
 * is still "new" (chat-manager isPristine — no user message on the branch). Modes are NOT stored
 * here: their default is the mode extension's own mode.json (server/mode-state.ts), shared with
 * the TUI. Same file rules as web-sessions.ts: pi-web's own dir, atomic tmp+rename, re-read
 * before every write so two servers merge instead of clobbering.
 */
const defaultsFile = () => join(getAgentDir(), "pi-web", "defaults.json");

/** On disk: `{ version: 1, model?: "provider/id", thinking?: level }`. Corrupt or unknown fields
 *  are dropped on read — a broken default must degrade to pi's own default, never fail an open. */
export interface WebDefaults {
  model?: string;
  thinking?: string;
}

/** A fresh file + our two fields. Never throws: a missing or corrupt file is simply empty. */
export function loadDefaults(file = defaultsFile()): WebDefaults {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const v = raw as Record<string, unknown>;
  const out: WebDefaults = {};
  if (typeof v.model === "string" && v.model.includes("/")) out.model = v.model;
  if (typeof v.thinking === "string" && v.thinking.trim()) out.thinking = v.thinking;
  return out;
}

/**
 * Merge-patch the stored defaults (each field only when the patch carries it) and write them
 * back atomically. Re-reads first, so a default another server wrote survives this write.
 */
export function saveDefaults(patch: Partial<WebDefaults>, file = defaultsFile()): WebDefaults {
  const next = { ...loadDefaults(file) };
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === "string" && value.trim()) (next as Record<string, string | undefined>)[key] = value;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`);
  renameSync(tmp, file);
  return next;
}
