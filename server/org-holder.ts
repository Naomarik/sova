/**
 * Which host holds an organization (§app.organizations/holder): `holder.json` in its workspace repo
 * names the host, or says it was released. A host's identity is its own, made once and kept
 * host-local (`<stateRoot>/host.json`). Attach reads the record in the clone and on its remote, so
 * attaching an org another host still holds warns first.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";
import { remoteFileText } from "./workspace-git";

export interface HostIdentity {
  id: string;
  name: string;
}

export type HolderRecord =
  | { version: 1; host: HostIdentity; since: string }
  | { version: 1; host: null; releasedBy: HostIdentity; at: string };

export const HOLDER_FILE = "holder.json";
/** The longest attach waits on the remote before it trusts the clone's record alone. */
export const REMOTE_CHECK_MS = 15_000;

const hostFile = () => join(stateRoot(), "host.json");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

/** This host: its id (made once, `h_` + 8 characters) and its machine name. */
export function hostIdentity(): HostIdentity {
  let id = "";
  try {
    const raw = JSON.parse(readFileSync(hostFile(), "utf8")) as unknown;
    if (isObj(raw) && typeof raw.id === "string" && /^h_[a-z0-9]{8}$/.test(raw.id)) id = raw.id;
  } catch {
    // none yet
  }
  if (!id) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    id = `h_${[...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join("")}`;
    writeJson(hostFile(), { version: 1, id });
  }
  return { id, name: hostname() || id };
}

function parseIdentity(v: unknown): HostIdentity | null {
  return isObj(v) && typeof v.id === "string" && v.id ? { id: v.id, name: typeof v.name === "string" && v.name ? v.name : v.id } : null;
}

export function parseHolder(text: string | null): HolderRecord | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  const host = parseIdentity(raw.host);
  if (host) return { version: 1, host, since: typeof raw.since === "string" ? raw.since : "" };
  const by = parseIdentity(raw.releasedBy);
  return raw.host === null && by ? { version: 1, host: null, releasedBy: by, at: typeof raw.at === "string" ? raw.at : "" } : null;
}

export function readHolder(dir: string): HolderRecord | null {
  try {
    return parseHolder(readFileSync(join(dir, HOLDER_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** This host holds it now. */
export const writeHeld = (dir: string, now = new Date()): void => writeJson(join(dir, HOLDER_FILE), { version: 1, host: hostIdentity(), since: now.toISOString() });
/** This host let it go (detach). */
export const writeReleased = (dir: string, now = new Date()): void => writeJson(join(dir, HOLDER_FILE), { version: 1, host: null, releasedBy: hostIdentity(), at: now.toISOString() });

/** Another host, and not released: who holds it and since when. */
function elsewhere(r: HolderRecord | null, me: HostIdentity): { host: HostIdentity; since: string } | null {
  return r?.host && r.host.id !== me.id ? { host: r.host, since: r.since } : null;
}

/**
 * Whether another host holds the org in `dir`: by the clone's record, or by its origin's (fetched,
 * at most REMOTE_CHECK_MS). An unreachable remote leaves the clone's record to decide.
 */
export async function heldElsewhere(dir: string): Promise<{ host: HostIdentity; since: string } | null> {
  const me = hostIdentity();
  const remote = await remoteFileText(dir, HOLDER_FILE, REMOTE_CHECK_MS);
  return elsewhere(parseHolder(remote), me) ?? elsewhere(readHolder(dir), me);
}

/** The attach form's warning. */
export function heldSentence(h: { host: HostIdentity; since: string }): string {
  const name = h.host.name;
  const since = h.since ? ` (since ${h.since.replace("T", " ").slice(0, 16)} UTC)` : "";
  return `${name} holds this organization${since}. If it still runs there, attaching it here too makes two copies that drift apart, and one host's work can't be pushed. Detach it on ${name} first, or attach anyway if ${name} is gone.`;
}
