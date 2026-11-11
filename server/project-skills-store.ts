import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";

/**
 * Each project's skill defaults for new chats, kept on this computer only:
 * `<state root>/project-skills.json`, never in the project folder or an organization's repository.
 * Plain data, no layer of its own: a skill name with no decision is Waiting (on in chats until
 * disallowed). The project layer (server/projects/skills.ts) reads and writes it.
 */

export const PROJECT_SKILLS_FILE = "project-skills.json";

export type SkillDecision = "approved" | "disallowed";

export interface ProjectSkillsStore {
  version: 1;
  projects: Record<string, { skills: Record<string, SkillDecision> }>;
}

const KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** A skill name the store keeps: pi's names are short; anything odd is never written. */
export const isSkillName = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\0\n\r]/.test(v);
const isDecision = (v: unknown): v is SkillDecision => v === "approved" || v === "disallowed";

export const projectSkillsPath = (): string => join(stateRoot(), PROJECT_SKILLS_FILE);

export function readProjectSkillsStore(): ProjectSkillsStore {
  const out: ProjectSkillsStore = { version: 1, projects: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(projectSkillsPath(), "utf8"));
  } catch {
    return out;
  }
  const projects = (raw as { projects?: unknown } | null)?.projects;
  if (!projects || typeof projects !== "object") return out;
  for (const [pid, p] of Object.entries(projects as Record<string, unknown>)) {
    if (!KEY_RE.test(pid)) continue;
    const skills = (p as { skills?: unknown } | null)?.skills;
    if (!skills || typeof skills !== "object") continue;
    const kept: Record<string, SkillDecision> = {};
    for (const [name, d] of Object.entries(skills as Record<string, unknown>)) if (isSkillName(name) && isDecision(d)) kept[name] = d;
    if (Object.keys(kept).length) out.projects[pid] = { skills: kept };
  }
  return out;
}

/** One project's decisions (empty: none yet). */
export function projectSkillDecisions(pid: string, store: ProjectSkillsStore = readProjectSkillsStore()): Record<string, SkillDecision> {
  return { ...(store.projects[pid]?.skills ?? {}) };
}

/** The names a project disallows, sorted. */
export function disallowedSkills(pid: string, store: ProjectSkillsStore = readProjectSkillsStore()): string[] {
  return Object.entries(store.projects[pid]?.skills ?? {})
    .flatMap(([n, d]) => (d === "disallowed" ? [n] : []))
    .sort();
}

/** Change the file under `fn` and write it atomically (temporary file, then rename). A project left
    with no decisions is dropped from the file. */
export function updateProjectSkillsStore(fn: (s: ProjectSkillsStore) => void): ProjectSkillsStore {
  const s = readProjectSkillsStore();
  fn(s);
  for (const [pid, p] of Object.entries(s.projects)) if (!Object.keys(p.skills).length) delete s.projects[pid];
  const file = projectSkillsPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return s;
}

/** Set (or, with "waiting", clear) decisions for one project. */
export function setSkillDecisions(pid: string, changes: Record<string, SkillDecision | "waiting">): void {
  updateProjectSkillsStore((s) => {
    const skills = (s.projects[pid] ??= { skills: {} }).skills;
    for (const [name, d] of Object.entries(changes)) {
      if (d === "waiting") delete skills[name];
      else skills[name] = d;
    }
  });
}

/** Drop the decisions on names no longer found (`found`). Writes only when something drops; returns the dropped names. */
export function pruneSkillDecisions(pid: string, found: ReadonlySet<string>): string[] {
  const gone = Object.keys(projectSkillDecisions(pid)).filter((n) => !found.has(n));
  if (!gone.length) return [];
  updateProjectSkillsStore((s) => {
    const skills = s.projects[pid]?.skills;
    if (skills) for (const n of gone) delete skills[n];
  });
  return gone;
}

/** A removed project's decisions go with it. */
export function forgetProjectSkills(pid: string): void {
  if (!readProjectSkillsStore().projects[pid]) return;
  updateProjectSkillsStore((s) => void delete s.projects[pid]);
}
