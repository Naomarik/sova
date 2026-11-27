// The claude-code extension's registry and its note wording (node built-ins only). See agents/extensions/claude-code/overview.md.
import { ClaudeLogins, loginNoteText, UNKNOWN_LOGIN_NAME } from "../pi-config/extensions/claude-code/accounts.ts";
import { agentRoot } from "./state-root";

// A Claude Code chat's login note, worded on this device (§app.claude-logins/login-ids): a new chat's
// `claude-login` entries name logins by id only, so each device names them from its own logins (the
// registry, which lists the mesh pool's too, else the pool's own list), "a login not on this device"
// for one it doesn't know. An older entry's own text is shown as written.

/** A pool login's name when the registry doesn't list it (claude-login-state installs the pool's reader). */
let poolName: (id: string) => string | undefined = () => undefined;
export function setPoolLoginName(read: (id: string) => string | undefined): void {
  poolName = read;
}

let registry: ClaudeLogins | null = null;
/** Tests only: the registry names are read from (null: this host's). */
export function setNoteLogins(logins: ClaudeLogins | null): void {
  registry = logins;
  names = null;
}

// The names, read once per few seconds at most: a transcript with many switches reads the registry once.
const NAMES_TTL_MS = 5_000;
let names: { at: number; of: Map<string, string> } | null = null;

function nameOf(id: string, now: number): string {
  if (!names || now - names.at > NAMES_TTL_MS) names = { at: now, of: new Map() };
  const cached = names.of.get(id);
  if (cached !== undefined) return cached;
  let name: string | undefined;
  try {
    name = (registry ??= new ClaudeLogins({ agentDir: agentRoot() })).noticeName(id);
  } catch {
    name = undefined;
  }
  try { name ??= poolName(id); } catch { /* no pool */ }
  name ??= UNKNOWN_LOGIN_NAME;
  names.of.set(id, name);
  return name;
}

/** The note a `claude-login` entry's data shows here, or undefined when it is no switch. */
export function claudeLoginNote(data: unknown, now = Date.now()): string | undefined {
  return loginNoteText(data, (id) => nameOf(id, now), now);
}
