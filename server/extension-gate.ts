// What you approved of each extension (§app.extensions/loader): `<state root>/extension-trust.json`,
// outside every repository, and what the background pass last read of its code folders. A request
// reads these and never walks a folder; only server/extension-fingerprint.ts walks, off a request's path.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";

export const extensionTrustFile = (): string => join(stateRoot(), "extension-trust.json");

export interface ExtensionApproval {
  version: string;
  /** The entry's hash and its code folders' hash, the two parts of `version`. */
  entry: string;
  code: string;
  /** The code folders' sizes and times when hashed: the same at a start means no hashing. */
  sig: string;
  at: string;
}

interface TrustFile {
  version: 1;
  approved: Record<string, ExtensionApproval>;
}

/** Read per call: the file is small, and a stat answers most reads. */
let cached: { file: string; sig: string; doc: TrustFile } | null = null;

function read(): TrustFile {
  const file = extensionTrustFile();
  let sig: string;
  try {
    const st = statSync(file);
    sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    cached = null;
    return { version: 1, approved: {} };
  }
  if (cached?.file === file && cached.sig === sig) return cached.doc;
  let doc: TrustFile = { version: 1, approved: {} };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<TrustFile>;
    if (raw?.version === 1 && raw.approved && typeof raw.approved === "object") doc = { version: 1, approved: raw.approved };
  } catch {
    // unreadable: nothing is approved
  }
  cached = { file, sig, doc };
  return doc;
}

function write(doc: TrustFile): void {
  const file = extensionTrustFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  cached = null;
}

export const approvalOf = (id: string): ExtensionApproval | undefined => read().approved[id];
export const approvedIds = (): string[] => Object.keys(read().approved);

export function recordApproval(id: string, a: Omit<ExtensionApproval, "at">): void {
  const doc = read();
  write({ version: 1, approved: { ...doc.approved, [id]: { ...a, at: new Date().toISOString() } } });
}

export function forgetApproval(id: string): void {
  const doc = read();
  if (!(id in doc.approved)) return;
  const approved = { ...doc.approved };
  delete approved[id];
  write({ version: 1, approved });
}

let migrated = false;

/**
 * The first start of this version (§app.extensions/loader): with no trust file, every valid entry is
 * approved once by `seed`, and the file is written even with none, so anything later waits. Before
 * this has run, no file means nothing has been decided, so entries count as approved.
 */
export function migrateTrust(seed: () => Record<string, ExtensionApproval>): void {
  migrated = true;
  try {
    statSync(extensionTrustFile());
    return;
  } catch {
    // the first start
  }
  write({ version: 1, approved: seed() });
}

/** A trust file exists, or this process hasn't yet run the first start's approval. */
export const trustDecided = (): boolean => {
  if (migrated) return true;
  try {
    statSync(extensionTrustFile());
    return true;
  } catch {
    return false;
  }
};

/** Tests: as a fresh process. */
export function resetGateForTest(): void {
  migrated = false;
  cached = null;
  code.clear();
}

// ---- the background pass's last reading ---------------------------------------------------------

/** What the pass last read of an entry's code. `code` absent: read for presence only. */
export interface CodeReading {
  sig: string;
  code?: string;
  /** Its folder is gone. */
  missing?: boolean;
}
const code = new Map<string, CodeReading>();
export const codeReadingOf = (id: string): CodeReading | undefined => code.get(id);
export const setCodeReading = (id: string, r: CodeReading): void => void code.set(id, r);
export const forgetCodeReading = (id: string): void => void code.delete(id);

// ---- the version -------------------------------------------------------------------------------

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]));
  return v;
}

/** The entry as approved: all of it but `off`, and the port Sova assigned to a program it runs. */
export function entryHash(raw: Record<string, unknown>): string {
  const { off: _off, ...rest } = raw;
  if (rest.run !== undefined) delete rest.api;
  return sha(JSON.stringify(stable(rest))).slice(0, 32);
}

export const versionOf = (entry: string, codeHash: string): string => sha(`${entry}\n${codeHash}`).slice(0, 32);
