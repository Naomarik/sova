import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";

/**
 * Which Claude login a project, or an organization for its projects, has here
 * (§app.claude-logins/project-login): `<state root>/claude-login-assignments.json`, kept on the host
 * that runs the project and never in an organization's workspace repo. Plain data with no layer of
 * its own: the project layer reads `projects`, the org layer `orgs`, Settings → Accounts asks both
 * through the users registered below.
 */

export const ASSIGNMENTS_FILE = "claude-login-assignments.json";

/** A project's setting: a login id ("default" included), "none" (this computer's order), or absent (its org's, if placed). */
export type ProjectLoginSetting = string;

export interface ClaudeLoginAssignments {
  version: 1;
  projects: Record<string, ProjectLoginSetting>;
  orgs: Record<string, string>;
}

const LOGIN_RE = /^(default|l-[0-9a-f]{8})$/;
/** A login id an assignment may name. */
export const isAssignableLogin = (v: unknown): v is string => typeof v === "string" && LOGIN_RE.test(v);
const KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;

export const assignmentsPath = (): string => join(stateRoot(), ASSIGNMENTS_FILE);

export function readAssignments(): ClaudeLoginAssignments {
  const out: ClaudeLoginAssignments = { version: 1, projects: {}, orgs: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(assignmentsPath(), "utf8"));
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  const r = raw as { projects?: unknown; orgs?: unknown };
  if (r.projects && typeof r.projects === "object")
    for (const [k, v] of Object.entries(r.projects as Record<string, unknown>)) if (KEY_RE.test(k) && (v === "none" || isAssignableLogin(v))) out.projects[k] = v as string;
  if (r.orgs && typeof r.orgs === "object")
    for (const [k, v] of Object.entries(r.orgs as Record<string, unknown>)) if (KEY_RE.test(k) && isAssignableLogin(v)) out.orgs[k] = v;
  return out;
}

/** Change the file under `fn` and write it atomically (temporary file, then rename). */
export function updateAssignments(fn: (a: ClaudeLoginAssignments) => void): ClaudeLoginAssignments {
  const a = readAssignments();
  fn(a);
  const file = assignmentsPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(a, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  for (const l of changeListeners) {
    try {
      l();
    } catch {
      /* a listener's failure is its own */
    }
  }
  return a;
}

/**
 * A removed login (§app.claude-logins/project-login, **Removing a login**): every assignment naming it
 * goes back to "No preference" (a project's entry becomes "none", an org's is dropped). Returns how many changed.
 */
export function clearLoginAssignments(login: string): number {
  let n = 0;
  const before = readAssignments();
  if (!Object.values(before.projects).includes(login) && !Object.values(before.orgs).includes(login)) return 0;
  updateAssignments((a) => {
    for (const [k, v] of Object.entries(a.projects))
      if (v === login) {
        a.projects[k] = "none";
        n++;
      }
    for (const [k, v] of Object.entries(a.orgs))
      if (v === login) {
        delete a.orgs[k];
        n++;
      }
  });
  return n;
}

const changeListeners: Array<() => void> = [];
/** Called after every write (tests; a cache that wants to drop). */
export function onAssignmentsChange(fn: () => void): void {
  changeListeners.push(fn);
}

/** Who uses a login, as Settings → Accounts names them: "Project Acme", "Organization Fold". */
export interface LoginUser {
  login: string;
  name: string;
}

const userSources: Array<() => LoginUser[]> = [];
/** A layer that assigns logins says who uses which (the project layer: projects; the org layer: orgs). */
export function registerLoginUsers(fn: () => LoginUser[]): void {
  userSources.push(fn);
}

/** Every login's users, names in order, each once. */
export function loginUsedBy(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const src of userSources) {
    let users: LoginUser[] = [];
    try {
      users = src();
    } catch {
      users = [];
    }
    for (const u of users) {
      const list = (out[u.login] ??= []);
      if (!list.includes(u.name)) list.push(u.name);
    }
  }
  return out;
}
