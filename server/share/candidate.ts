import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PublicLinksFile } from "../../shared/public-links";
import { stateRoot } from "../state-root";

/**
 * A new address waiting for its Verify (§mesh.public/where-links-open: links keep opening where they
 * open now until the new address is saved and verified). A PUT that moves a working route to Cloudflare
 * Account or to this host as the gateway (Funnel, Your own web server) saves that setup here instead of
 * in public-links.json; Verify checks its address and, only on a pass, makes it the route. Cancel
 * deletes it. Off, Free and Through switch at once and drop it.
 *
 * <stateRoot>/public-links-candidate.json: `{version: 1, patch, file, savedAt, failure?}`, 0600, atomic,
 * strict: anything else reads as none. `patch` is the PUT's body as given (applied again at promotion,
 * over the setting as it is then); `file` the setting it would make, for its address. Its own file, so
 * public-links.json still reads on an older Sova. Read on demand only.
 */

export interface StoredCandidate {
  version: 1;
  patch: Record<string, unknown>;
  file: PublicLinksFile;
  savedAt: number;
  failure?: { reason: string; at: number };
}

export const candidateFile = (): string => join(stateRoot(), "public-links-candidate.json");

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** The candidate's address: Account's publicUrl, or the gateway's. Null when it has none. */
export function candidateUrl(file: PublicLinksFile): string | null {
  if (file.route === "account") return file.account?.publicUrl ?? null;
  if (file.route === "self") return file.gateway?.publicUrl ?? null;
  return null;
}

/** The waiting candidate, or null (none, or a file that isn't one). */
export function readCandidate(): StoredCandidate | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(candidateFile(), "utf8"));
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.patch) || !isObj(raw.file) || !isTime(raw.savedAt)) return null;
  const file = raw.file as unknown as PublicLinksFile;
  if ((file.route !== "account" && file.route !== "self") || !candidateUrl(file)) return null;
  const f = raw.failure;
  const failure = isObj(f) && typeof f.reason === "string" && isTime(f.at) ? { reason: f.reason, at: f.at } : undefined;
  return { version: 1, patch: raw.patch, file, savedAt: raw.savedAt, ...(failure ? { failure } : {}) };
}

function write(c: StoredCandidate): void {
  const path = candidateFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function saveCandidate(patch: Record<string, unknown>, file: PublicLinksFile, now = Date.now()): StoredCandidate {
  const c: StoredCandidate = { version: 1, patch, file, savedAt: now };
  write(c);
  return c;
}

/** A Verify that didn't pass: kept with the candidate, which stays waiting. */
export function noteCandidateFailure(reason: string, now = Date.now()): void {
  const c = readCandidate();
  if (c) write({ ...c, failure: { reason, at: now } });
}

export function dropCandidate(): void {
  rmSync(candidateFile(), { force: true });
}
