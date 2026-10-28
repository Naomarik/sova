import type { ClaudeLoginContext, ClaudeLoginPreference } from "../../pi-config/extensions/claude-code/accounts.ts";
import type { ProjectClaudeLogin, ClaudeLoginResolved } from "../../shared/projects";
import { isAssignableLogin, readAssignments, registerLoginUsers, updateAssignments, type ClaudeLoginAssignments } from "../claude-login-store";
import { folderMatcher } from "../project-folder";
import { agentRoot } from "../state-root";
import { claudeLoginOf } from "./contributions";
import { engineOf, listProjects, readProject } from "./spaces";
import type { ProjectSummary } from "../../shared/projects";

/**
 * A project's Claude login (§app.claude-logins/project-login), the project layer's part: its own
 * setting, kept host-local in claude-login-assignments.json, and, while a layer places it, the default
 * that layer contributes (claudeLoginOf). Never reads an organization itself (§app.projects/seam).
 */

const placed = (p: ProjectSummary): boolean => p.space.kind !== "standalone";

/** The project's setting: a login id, "none", or "org" (absent while placed: it follows its placement). */
export function projectLoginSetting(p: ProjectSummary, a: ClaudeLoginAssignments = readAssignments()): string {
  const own = a.projects[p.id];
  if (own) return own;
  return placed(p) ? "org" : "none";
}

/** What the project's new chats prefer, or null: this computer's order. */
export function resolveProjectLogin(p: ProjectSummary, a: ClaudeLoginAssignments = readAssignments()): ClaudeLoginPreference | null {
  const setting = projectLoginSetting(p, a);
  if (setting === "none") return null;
  if (setting !== "org") return isAssignableLogin(setting) ? { login: setting, source: "project", name: p.name } : null;
  if (!placed(p)) return null;
  const engine = engineOf(p.id);
  const inherited = engine ? claudeLoginOf(engine, p.id) : null;
  return inherited && isAssignableLogin(inherited.login) ? { login: inherited.login, source: "org", name: inherited.name } : null;
}

const resolvedWire = (r: ClaudeLoginPreference | null): ClaudeLoginResolved | null => (r ? { login: r.login, source: r.source, name: r.name } : null);

/** The page's read: the setting, whether "Same as organization" is offered, and what it resolves to. */
export function projectLoginView(projectId: string): ProjectClaudeLogin {
  const p = readProject(projectId);
  const a = readAssignments();
  const engine = engineOf(p.id);
  const inherited = placed(p) && engine ? claudeLoginOf(engine, p.id) : null;
  return {
    setting: projectLoginSetting(p, a),
    placed: placed(p),
    ...(placed(p) ? { orgLogin: inherited?.login ?? null } : {}),
    resolved: resolvedWire(resolveProjectLogin(p, a)),
  };
}

/** Save the project's setting (validated by the caller): "org" drops its own entry. */
export function setProjectLogin(projectId: string, value: string): ProjectClaudeLogin {
  const p = readProject(projectId);
  updateAssignments((a) => {
    if (value === "org" || (value === "none" && !placed(p))) delete a.projects[p.id];
    else a.projects[p.id] = value;
  });
  return projectLoginView(projectId);
}

/**
 * The login context a chat started in `cwd` gets (accounts.ts ClaudeLoginContext): its project's
 * login, if it has one (the folder rule of §app/projects, archived projects left out), and every other
 * login a project here resolves to, saved for that work. Undefined when neither applies, so a host with
 * no assignment hands nothing over.
 */
export function loginContextForCwd(cwd: string): ClaudeLoginContext | undefined {
  const a = readAssignments();
  if (!Object.keys(a.projects).length && !Object.keys(a.orgs).length) return undefined;
  const projects = listProjects().filter((p) => !p.archived);
  if (!projects.length) return undefined;
  const resolved = new Map(projects.map((p) => [p.id, resolveProjectLogin(p, a)] as const));
  const pid = cwd ? folderMatcher(projects, agentRoot())(cwd) : null;
  const prefer = pid ? (resolved.get(pid) ?? undefined) : undefined;
  const saved = [...new Set([...resolved.values()].flatMap((r) => (r && r.login !== "default" && r.login !== prefer?.login ? [r.login] : [])))];
  if (!prefer && !saved.length) return undefined;
  return { ...(prefer ? { prefer } : {}), ...(saved.length ? { saved } : {}) };
}

/** The preference a chat in `cwd` starts with (the composer's label before its first record), or null. */
export function loginPreferenceForCwd(cwd: string): ClaudeLoginPreference | null {
  return loginContextForCwd(cwd)?.prefer ?? null;
}

// Settings → Accounts names the projects that picked a login of their own.
registerLoginUsers(() => {
  const a = readAssignments();
  return listProjects()
    .filter((p) => !p.archived)
    .flatMap((p) => {
      const own = a.projects[p.id];
      return own && isAssignableLogin(own) ? [{ login: own, name: `Project ${p.name}` }] : [];
    });
});
