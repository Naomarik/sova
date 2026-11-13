import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { stateRoot } from "./state-root";

/**
 * The approval list for context files and skills, one per computer: `<state root>/project-skills.json`,
 * never in a project folder or an organization's repository. Plain data, no layer of its own:
 * server/approvals.ts makes the keys, scans the folders and reads and writes it.
 *
 * Version 2: `folders[<folder key>]` (`p:<project id>`, or `d:<real path>` for a folder that isn't a project)
 * holds `context` and `skills`, each by item key (a checkout-relative POSIX path, or an absolute path outside
 * every checkout; shared/approvals.ts) with its decision and, when approved, the sha256 of what was approved.
 * Version 1 (`projects[<id>].skills[<name>]`) is read too: its Disallowed decisions wait under `legacySkills`, by
 * name, until a scan gives each name its first-found skill's key. Its Approved ones are dropped: they were open to
 * any caller and meant nothing while Waiting was on, so they never become an approval (a skill is Waiting again).
 */

export const PROJECT_SKILLS_FILE = "project-skills.json";

export type SkillDecision = "approved" | "disallowed";

export interface Decision {
  state: SkillDecision;
  /** Of the file's bytes when it was approved. An approval without one never matches: it reads as changed. */
  sha256?: string;
  /** A skill's name when decided: for display and the names a chat started before the keys still reads. */
  name?: string;
}

export interface FolderDecisions {
  context: Record<string, Decision>;
  skills: Record<string, Decision>;
  /** Version 1's name-keyed Disallowed skills not yet given a key. */
  legacySkills?: Record<string, "disallowed">;
}

export interface ApprovalStore {
  version: 2;
  folders: Record<string, FolderDecisions>;
}

const PID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const clean = (v: string) => v.length > 0 && v.length <= 4096 && !/[\0\n\r]/.test(v);

/** A skill name the store keeps: pi's names are short; anything odd is never written. */
export const isSkillName = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\0\n\r]/.test(v);
const isState = (v: unknown): v is SkillDecision => v === "approved" || v === "disallowed";

/** `p:<project id>` or `d:<absolute path>`. */
export const isFolderKey = (v: unknown): v is string =>
  typeof v === "string" && ((v.startsWith("p:") && PID_RE.test(v.slice(2))) || (v.startsWith("d:") && isAbsolute(v.slice(2)) && clean(v.slice(2))));

/** An item key: an absolute path, or a relative POSIX path that never climbs out (`..`). */
export const isItemKey = (v: unknown): v is string =>
  typeof v === "string" && clean(v) && (v.startsWith("/") || (!v.startsWith("./") && !v.split("/").some((s) => s === ".." || s === "")));

export const projectFolderKey = (pid: string): string => `p:${pid}`;
export const dirFolderKey = (realPath: string): string => `d:${realPath}`;

export const projectSkillsPath = (): string => join(stateRoot(), PROJECT_SKILLS_FILE);

function decisionOf(v: unknown): Decision | null {
  if (isState(v)) return { state: v };
  const d = v as Partial<Decision> | null;
  if (!d || typeof d !== "object" || !isState(d.state)) return null;
  return { state: d.state, ...(d.state === "approved" && typeof d.sha256 === "string" && SHA_RE.test(d.sha256) ? { sha256: d.sha256 } : {}), ...(isSkillName(d.name) ? { name: d.name } : {}) };
}

function itemsOf(v: unknown): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, d] of Object.entries(v as Record<string, unknown>)) {
    const dec = isItemKey(k) ? decisionOf(d) : null;
    if (dec) out[k] = dec;
  }
  return out;
}

const empty = (f: FolderDecisions) => !Object.keys(f.context).length && !Object.keys(f.skills).length && !Object.keys(f.legacySkills ?? {}).length;

/** The file, read strictly: anything that isn't a well-formed decision is left out. Unreadable or missing: empty. */
export function readApprovalStore(): ApprovalStore {
  const out: ApprovalStore = { version: 2, folders: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(projectSkillsPath(), "utf8"));
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  const folders = (raw as { folders?: unknown }).folders;
  if (folders && typeof folders === "object") {
    for (const [key, f] of Object.entries(folders as Record<string, unknown>)) {
      if (!isFolderKey(key) || !f || typeof f !== "object") continue;
      const legacy: Record<string, "disallowed"> = {};
      for (const [n, d] of Object.entries(((f as { legacySkills?: unknown }).legacySkills as Record<string, unknown>) ?? {})) if (isSkillName(n) && d === "disallowed") legacy[n] = d;
      const kept: FolderDecisions = { context: itemsOf((f as { context?: unknown }).context), skills: itemsOf((f as { skills?: unknown }).skills), ...(Object.keys(legacy).length ? { legacySkills: legacy } : {}) };
      if (!empty(kept)) out.folders[key] = kept;
    }
  }
  // Version 1: by project, by skill name.
  const projects = (raw as { projects?: unknown }).projects;
  if (projects && typeof projects === "object") {
    for (const [pid, p] of Object.entries(projects as Record<string, unknown>)) {
      if (!PID_RE.test(pid)) continue;
      const skills = (p as { skills?: unknown } | null)?.skills;
      if (!skills || typeof skills !== "object") continue;
      const legacy: Record<string, "disallowed"> = {};
      for (const [n, d] of Object.entries(skills as Record<string, unknown>)) if (isSkillName(n) && d === "disallowed") legacy[n] = d;
      if (!Object.keys(legacy).length) continue;
      const f = (out.folders[projectFolderKey(pid)] ??= { context: {}, skills: {} });
      f.legacySkills = { ...legacy, ...(f.legacySkills ?? {}) };
    }
  }
  return out;
}

/** One folder's decisions (empty: none yet), a copy. */
export function folderDecisions(folderKey: string, store: ApprovalStore = readApprovalStore()): FolderDecisions {
  const f = store.folders[folderKey];
  return { context: { ...(f?.context ?? {}) }, skills: { ...(f?.skills ?? {}) }, ...(f?.legacySkills ? { legacySkills: { ...f.legacySkills } } : {}) };
}

/** Change the file under `fn` and write it atomically (temporary file, then rename). A folder left with no
    decisions is dropped from the file. */
export function updateApprovalStore(fn: (s: ApprovalStore) => void): ApprovalStore {
  const s = readApprovalStore();
  fn(s);
  for (const [k, f] of Object.entries(s.folders)) {
    if (f.legacySkills && !Object.keys(f.legacySkills).length) delete f.legacySkills;
    if (empty(f)) delete s.folders[k];
  }
  const file = projectSkillsPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return s;
}

export type ItemKind = "context" | "skills";

/** Set (or, with "waiting", clear) decisions of one folder. */
export function setDecisions(folderKey: string, kind: ItemKind, changes: Record<string, Decision | "waiting">): void {
  updateApprovalStore((s) => {
    const items = (s.folders[folderKey] ??= { context: {}, skills: {} })[kind];
    for (const [key, d] of Object.entries(changes)) {
      if (d === "waiting") delete items[key];
      else items[key] = d;
    }
  });
}

/** A removed project's decisions go with it. */
export function forgetProjectSkills(pid: string): void {
  const key = projectFolderKey(pid);
  if (!readApprovalStore().folders[key]) return;
  updateApprovalStore((s) => void delete s.folders[key]);
}

/** A project's skill decisions by name (keyed ones by the name they were decided under, version 1's as they are):
    for readers that still go by name. */
export function projectSkillDecisions(pid: string, store: ApprovalStore = readApprovalStore()): Record<string, SkillDecision> {
  const f = store.folders[projectFolderKey(pid)];
  const out: Record<string, SkillDecision> = { ...(f?.legacySkills ?? {}) };
  for (const d of Object.values(f?.skills ?? {})) if (d.name && !(d.name in out)) out[d.name] = d.state;
  return out;
}
