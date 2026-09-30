import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";
import type { SessionSummary } from "../shared/protocol";

/**
 * How the Overseer names a session for the user (§app.overseer/session-names), and the aliases the
 * user gives sessions through it. A first-message title rarely names the work, so a name is
 * summary-first: the alias, else a title someone set (the user, the Overseer, Sova's auto-title),
 * else the one-line summary, else the title.
 *
 * Aliases are Sova's own data (`<stateRoot>/session-aliases.json`, keyed by session id), never
 * written into a session file.
 */

export const ALIAS_MAX = 40;
const NAME_MAX = 80;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The session's name, summary-first. Pure. */
export function sessionName(s: Pick<SessionSummary, "title"> & Partial<Pick<SessionSummary, "titleBy" | "outlineGist" | "outlineNow">>, alias?: string | null): string {
  if (alias?.trim()) return oneLine(alias);
  if (s.titleBy && s.title.trim()) return cut(oneLine(s.title), NAME_MAX);
  const summary = oneLine(s.outlineGist ?? s.outlineNow ?? "");
  if (summary) return cut(summary, NAME_MAX);
  return cut(oneLine(s.title), NAME_MAX) || "Untitled session";
}

// ---- the alias store ------------------------------------------------------------------------------

const file = () => join(stateRoot(), "session-aliases.json");

/** An alias the store keeps, or null: one line, 1–40 characters, no control characters. */
export function cleanAlias(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = oneLine(raw);
  if (!t || t.length > ALIAS_MAX || /[\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

/** id → alias. Missing or corrupt: none. Read fresh each call (a small file; the tools are rare). */
export function readAliases(path = file()): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { aliases?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [id, a] of Object.entries(raw?.aliases ?? {})) {
      const clean = cleanAlias(a);
      if (clean) out[id] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

/** The session id an alias names (case-insensitive, exact), or null. */
export function idOfAlias(alias: string, aliases = readAliases()): string | null {
  const want = oneLine(alias).toLowerCase();
  if (!want) return null;
  for (const [id, a] of Object.entries(aliases)) if (a.toLowerCase() === want) return id;
  return null;
}

/**
 * Set (or with "" clear) a session's alias. Returns the refusal sentence, or null when done. An
 * alias another session holds is refused.
 */
export function setAlias(id: string, raw: string, path = file()): string | null {
  const aliases = readAliases(path);
  if (raw.trim() === "") {
    delete aliases[id];
  } else {
    const clean = cleanAlias(raw);
    if (!clean) return `An alias is one line of 1 to ${ALIAS_MAX} characters.`;
    const holder = idOfAlias(clean, aliases);
    if (holder && holder !== id) return `The alias "${clean}" already names session ${holder}; pick another, or clear that one first.`;
    aliases[id] = clean;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, aliases })}\n`);
  renameSync(tmp, path);
  return null;
}
