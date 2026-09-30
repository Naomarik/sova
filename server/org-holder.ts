/**
 * Which host holds an organization (§app.organizations/holder). The record lives in the org statechart's
 * portable snapshot (`<workspace>/charts/org/…`, r1): the org statechart writes it when this host's
 * residence claims or releases the org. A host's identity is its own, made once and kept host-local
 * (`<stateRoot>/host.json`). Attach reads the record in the clone and on its remote (the residence
 * statechart's `read-holder` effect, server/org-effects.ts), so attaching an org another host still holds
 * warns first.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { createStatecharts } from "./org-charts";
import { snapshotFile } from "./org-host/store";
import { stateRoot } from "./state-root";
import { remoteFileText } from "./workspace-git";

export interface HostIdentity {
  id: string;
  name: string;
}

/** The org statechart's holder record: this host holds it since `since` (ms), or it was released. */
export interface HolderRecord {
  hostId: string;
  hostName: string;
  since?: number;
  releasedBy?: string;
  releasedAt?: number;
}

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

/** A holder record from statechart data (camelCase), or null. */
export function parseHolder(v: unknown): HolderRecord | null {
  if (!isObj(v) || typeof v.hostId !== "string" || !v.hostId) return null;
  return {
    hostId: v.hostId,
    hostName: typeof v.hostName === "string" && v.hostName ? v.hostName : v.hostId,
    ...(typeof v.since === "number" ? { since: v.since } : {}),
    ...(typeof v.releasedBy === "string" ? { releasedBy: v.releasedBy } : {}),
    ...(typeof v.releasedAt === "number" ? { releasedAt: v.releasedAt } : {}),
  };
}

/** The holder record an org snapshot's text carries (read without an engine of the org's own), or null. */
export function holderOfSnapshot(sid: string, text: string | null): HolderRecord | null {
  if (!text) return null;
  try {
    const engine = createStatecharts();
    engine.load(sid, text);
    return parseHolder(engine.data(sid)?.holder);
  } catch {
    return null;
  }
}

/** Two installs on one machine share its name: another host of the same name is named with its id. */
export function named(h: HolderRecord | null, me: HostIdentity = hostIdentity()): HolderRecord | null {
  return h && h.hostId !== me.id && h.hostName === me.name ? { ...h, hostName: `${h.hostName} (${h.hostId})` } : h;
}

/** The org snapshot's path inside the workspace repo (as origin has it too). */
export const orgSnapshotPath = (orgId: string): string => snapshotFile("charts", "org", `org/${orgId}`);

/**
 * The holder record on the clone's origin (fetched, at most REMOTE_CHECK_MS), or null: no remote,
 * an unreachable one, or no org snapshot there.
 */
export async function remoteHolder(dir: string, orgId: string, timeoutMs = REMOTE_CHECK_MS): Promise<HolderRecord | null> {
  return named(holderOfSnapshot(`org/${orgId}`, await remoteFileText(dir, orgSnapshotPath(orgId), timeoutMs)));
}
