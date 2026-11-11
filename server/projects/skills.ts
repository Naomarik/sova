import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { ProjectSkillRow, ProjectSkillState, ProjectSkillsView } from "../../shared/project-skills";
import { defaultClaudeDir } from "../../pi-config/extensions/claude-code/accounts.ts";
import { folderResources } from "../harness/pi/resources";
import { piSkillsIn } from "../harness/pi/skill-sources";
import { OrgError } from "../org-error";
import { readStoredCwd } from "../git-summary";
import { real } from "../mcp/folder";
import { folderMatcher } from "../project-folder";
import { disallowedSkills, isSkillName, projectSkillDecisions, pruneSkillDecisions, readProjectSkillsStore, setSkillDecisions, type SkillDecision } from "../project-skills-store";
import { agentRoot } from "../state-root";
import { listSubfolderSkills } from "../subfolder-skills";
import { listProjects, readProject } from "./spaces";

/**
 * A project's skill defaults for new chats, the project layer's part: every skill a chat in the
 * project could be offered (pi's own places for its root, with the Claude folders, and the skills of
 * folders inside it), each with the decision kept on this computer (server/project-skills-store.ts).
 * A chat's skills are fixed at its first message; these only reach chats not yet started.
 */

type Found = Omit<ProjectSkillRow, "state">;

const within = (root: string, p: string) => {
  const r = relative(root, p);
  return r === "" || (!!r && !r.startsWith("..") && !r.startsWith(sep) && !r.startsWith("/"));
};
const posix = (p: string) => p.split(sep).join("/");

/** Where one of pi's starting skills comes from, by its file. */
export function sourceOf(root: string, filePath: string, claudeDir: string = defaultClaudeDir()): ProjectSkillRow["source"] {
  const claudeHome = [resolve(claudeDir), resolve(homedir(), ".claude")];
  if (claudeHome.some((d) => within(d, filePath))) return { kind: "claude" };
  if (within(root, filePath)) {
    const rel = posix(relative(root, filePath));
    if (rel.startsWith(".claude/")) return { kind: "claude" };
    return { kind: "project" };
  }
  return { kind: "user" };
}

/**
 * Every skill a chat in the project could be offered, by name (the first of a name wins, as pi's list
 * has it): its root's, then each of its worktrees' (a chat in a worktree loads that checkout's skills),
 * each checkout's own places and the folders inside it. A worktree-only skill is listed, can be decided
 * on, and its decision is kept while a checkout still has it.
 */
export interface SkillsScanDeps {
  loader?: typeof folderResources;
  /** The project's checkouts (default: `git worktree list`); `complete: false` when they couldn't all be told. */
  checkouts?: (root: string) => Promise<{ dirs: string[]; complete: boolean }>;
}

/** The root and each git worktree of it, by real path; incomplete when git couldn't answer. */
export function checkoutsOf(root: string): Promise<{ dirs: string[]; complete: boolean }> {
  const main = real(root);
  return new Promise((done) => {
    execFile("git", ["-C", root, "worktree", "list", "--porcelain"], { timeout: 5_000 }, (err, stdout) => {
      // Not a repository at all is a full answer (the root is the only checkout); any other failure is not.
      if (err) return done({ dirs: [main], complete: !existsSync(join(root, ".git")) });
      const all = stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => real(l.slice("worktree ".length)));
      done({ dirs: [...new Set([main, ...all])].filter(existsSync), complete: true });
    });
  });
}

/**
 * What projectSkillsFound found, and whether the scan saw every checkout whole: a checkout git
 * couldn't list, a loader that failed or a walk that stopped at its cap makes it incomplete, and an
 * incomplete scan never drops a decision (a name drops off only once no checkout has it).
 */
export async function projectSkillsScan(root: string, deps: SkillsScanDeps = {}): Promise<{ found: Found[]; complete: boolean }> {
  const out = new Map<string, Found>();
  const main = real(root);
  const listed = await (deps.checkouts ?? checkoutsOf)(root).catch(() => ({ dirs: [main], complete: false }));
  let complete = listed.complete;
  const checkouts = listed.dirs;
  for (const checkout of checkouts.includes(main) ? checkouts : [main, ...checkouts]) {
    const top = checkout === main ? root : checkout;
    // A worktree's own folders are named from the project's root ("../.worktrees/x/sub").
    const from = (dir: string) => posix(relative(main, join(checkout, dir))) || undefined;
    let res;
    try {
      res = await (deps.loader ?? folderResources)(top, agentRoot());
    } catch {
      complete = false;
      continue;
    }
    for (const s of res.skills) {
      if (out.has(s.name)) continue;
      const description = s.description?.trim();
      const source = sourceOf(top, s.filePath);
      const folder = checkout !== main && source.kind !== "user" && within(top, s.filePath) ? from("") : undefined;
      out.set(s.name, { name: s.name, path: s.filePath, source: folder ? { ...source, folder } : source, ...(description ? { description } : {}) });
    }
    const sub = listSubfolderSkills(top, piSkillsIn);
    if (sub.incomplete) complete = false;
    for (const s of sub.skills) {
      if (out.has(s.name)) continue;
      const description = s.description?.trim();
      out.set(s.name, { name: s.name, path: s.filePath, source: { kind: "subfolder", folder: checkout === main ? s.dir : (from(s.dir) ?? s.dir) }, ...(description ? { description } : {}) });
    }
  }
  return { found: [...out.values()].sort((a, b) => a.name.localeCompare(b.name)), complete };
}

/** Every skill a chat in the project could be offered (projectSkillsScan's list alone). */
export async function projectSkillsFound(root: string, deps: SkillsScanDeps = {}): Promise<Found[]> {
  return (await projectSkillsScan(root, deps)).found;
}

/** Rows and counts from what was found and the project's decisions. Pure. */
export function skillsView(found: readonly Found[], decisions: Record<string, SkillDecision>): ProjectSkillsView {
  const counts = { approved: 0, disallowed: 0, waiting: 0 };
  const skills = found.map((f) => {
    const state: ProjectSkillState = decisions[f.name] ?? "waiting";
    counts[state]++;
    return { ...f, state };
  });
  return { skills, counts };
}

/** GET /api/projects/:pid/skills: the card's rows. A decision on a name no longer found drops off the store. */
export async function projectSkillsView(pid: string, deps: SkillsScanDeps = {}): Promise<ProjectSkillsView> {
  const p = readProject(pid);
  const { found, complete } = await projectSkillsScan(p.root, deps);
  if (complete) pruneSkillDecisions(p.id, new Set(found.map((f) => f.name)));
  return skillsView(found, projectSkillDecisions(p.id));
}

/** A PUT body's changes, strictly: `{skills: {<name>: "approved" | "disallowed" | "waiting"}}`, at least one. */
export function parseSkillChanges(body: unknown): Record<string, SkillDecision | "waiting"> {
  const skills = (body as { skills?: unknown } | null)?.skills;
  const bad = () => new OrgError('Expected { skills: { <skill name>: "approved" | "disallowed" | "waiting" } }');
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) throw bad();
  const entries = Object.entries(skills as Record<string, unknown>);
  if (!entries.length || entries.length > 500) throw bad();
  const out: Record<string, SkillDecision | "waiting"> = {};
  for (const [name, state] of entries) {
    if (!isSkillName(name) || (state !== "approved" && state !== "disallowed" && state !== "waiting")) throw bad();
    out[name] = state;
  }
  return out;
}

/** PUT /api/projects/:pid/skills: save the changes at once (names not found now are refused), then the fresh view. */
export async function setProjectSkills(pid: string, body: unknown, deps: SkillsScanDeps = {}): Promise<ProjectSkillsView> {
  const changes = parseSkillChanges(body);
  const p = readProject(pid);
  const { found, complete } = await projectSkillsScan(p.root, deps);
  const names = new Set(found.map((f) => f.name));
  // A partial scan can't tell a name is offered nowhere: it is saved rather than refused.
  const unknown = complete ? Object.keys(changes).filter((n) => !names.has(n) && changes[n] !== "waiting") : [];
  if (unknown.length) throw new OrgError(`No skill named ${unknown.map((n) => `"${n}"`).join(", ")} is offered in this project.`, 404);
  setSkillDecisions(p.id, changes);
  if (complete) pruneSkillDecisions(p.id, names);
  return skillsView(found, projectSkillDecisions(p.id));
}

/** The project a chat in `cwd` belongs to (its root, a folder inside it, or one of its worktrees), archived ones left out. */
export function projectForCwd(cwd: string): { id: string; name: string } | null {
  if (!cwd) return null;
  let projects;
  try {
    projects = listProjects().filter((p) => !p.archived);
  } catch {
    return null;
  }
  if (!projects.length) return null;
  const pid = folderMatcher(projects, agentRoot())(cwd);
  const p = pid ? projects.find((x) => x.id === pid) : undefined;
  return p ? { id: p.id, name: p.name } : null;
}

/** The skills a new chat in `cwd` starts with off: its project's disallowed ones (none outside a project). */
export function projectSkillsOffForCwd(cwd: string): string[] {
  const store = readProjectSkillsStore();
  if (!Object.keys(store.projects).length) return [];
  const p = projectForCwd(cwd);
  return p ? disallowedSkills(p.id, store) : [];
}

/** The skills a new chat of session file `path` starts with off (its header's folder); none when it can't be read. */
export async function projectSkillsOffForSession(path: string): Promise<string[]> {
  try {
    const cwd = await readStoredCwd(path);
    return cwd ? projectSkillsOffForCwd(cwd) : [];
  } catch {
    return [];
  }
}

/** The All settings row's words: "2 disallowed · 1 waiting", or "No preference" with no decision. */
export function skillsRowState(counts: ProjectSkillsView["counts"]): string {
  if (!counts.approved && !counts.disallowed) return "No preference";
  const parts = [counts.disallowed ? `${counts.disallowed} disallowed` : "", counts.waiting ? `${counts.waiting} waiting` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : `${counts.approved} approved`;
}
