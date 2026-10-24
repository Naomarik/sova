/**
 * Projects: the project verbs, made from the contract's lists, and the project screens. Part of the command catalogue, assembled by shared/commands-catalog.ts
 * (rules: agents/server/commands/overview.md). Pure, erasable syntax only.
 */
import { DEPLOY_READ_VERBS, DEPLOY_VERBS, READ_VERBS, VERB_FLAGS, VERB_PARAMS, VERBS } from "../project-contract.ts";
import type { CommandEntry, CommandParam } from "./types.ts";
import { PROJECT_OVERSEER_ENTRIES } from "./overseer.ts";

/** One flag of the contract's param table (§app.project-commands/verb-params) as a param; `deploy`: a deploy verb's. */
function verbParam(flag: string, deploy: boolean): [string, CommandParam] {
  const p = VERB_PARAMS.find((r) => r.cli?.flag === flag);
  if (!p || !p.cli) throw new Error(`no verb param with the flag --${flag}`);
  const def = deploy ? p.cli.deployDefault : undefined;
  return [flag, { type: p.type, description: p.cli.description, in: "body", ...(p.wire !== flag ? { key: p.wire } : {}), ...(def !== undefined ? { default: def } : {}) }];
}

/** The keys scripts/sova-project.mjs sends for an instance verb, as params. */
const INSTANCE_PARAMS: Record<string, CommandParam> = Object.fromEntries(VERB_FLAGS.instance.map((f) => verbParam(f, false)));

/** The keys scripts/sova-project.mjs sends for a deploy verb, as params. */
const DEPLOY_PARAMS: Record<string, CommandParam> = Object.fromEntries(VERB_FLAGS.deploy.map((f) => verbParam(f, true)));

/** One entry per project verb and deploy verb, from the contract's own lists. */
export const VERB_ENTRIES: CommandEntry[] = [...VERBS, ...DEPLOY_VERBS].map((verb): CommandEntry => {
  const deploy = (DEPLOY_VERBS as readonly string[]).includes(verb);
  const reads = (READ_VERBS as readonly string[]).includes(verb) || (DEPLOY_READ_VERBS as readonly string[]).includes(verb);
  return {
    id: `project.verb.${verb}`,
    label: `Project ${verb}`,
    summary: `The project verb ${verb}, as the operator (sova-project ${verb}).`,
    effect: reads ? "looks" : "changes",
    params: deploy ? DEPLOY_PARAMS : INSTANCE_PARAMS,
    route: { method: "POST", path: `/api/project-services/${verb}` },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "admin",
  };
});

const pid: CommandParam = { type: "string", description: "The project's id", in: "path", required: true };
const looks = (id: string, label: string, summary: string, path: string, params: Record<string, CommandParam> = { pid }): CommandEntry => ({
  id,
  label,
  summary,
  effect: "looks",
  params,
  route: { method: "GET", path },
  sessionKey: null,
  sessionFile: "never",
  meshNeed: "sessions",
});
const changes = (id: string, label: string, summary: string, method: "POST" | "PATCH", path: string, params: Record<string, CommandParam>): CommandEntry => ({
  id,
  label,
  summary,
  effect: "changes",
  params,
  route: { method, path },
  sessionKey: null,
  sessionFile: "never",
  meshNeed: "admin",
});
const codingSession: CommandParam = { type: "string", description: "The coding session's id", in: "body", key: "sessionId", required: true };
const previewId: CommandParam = { type: "string", description: "The preview's id", in: "path", required: true };

/** The projects sweep (§app.project-commands/projects-sweep): each row points at the route the web app's own control uses. */
const PROJECTS_SWEEP: CommandEntry[] = [
  looks("project.list", "List Projects", "Every registered project, in an organization or not.", "/api/projects", {}),
  looks("project.get", "Show Project", "One registered project.", "/api/projects/:pid"),
  changes("project.create", "Add Project", "Register a folder as a project, or clone a GitHub repository and register it; on this host only.", "POST", "/api/projects", {
    root: { type: "path", description: "The folder to register", in: "body" },
    clone: { type: "json", description: "Clone instead: { repo, parent, folder? }", in: "body" },
  }),
  changes("project.update", "Edit Project", "Rename a project or move its root.", "PATCH", "/api/projects/:pid", {
    pid,
    name: { type: "string", description: "The new name", in: "body" },
    root: { type: "path", description: "The new root folder", in: "body" },
  }),
  looks("project.claude-login.get", "Show Project Claude Login", "The Claude login a project's new chats start on, and where it comes from.", "/api/projects/:pid/claude-login"),
  {
    id: "project.claude-login.set",
    label: "Set Project Claude Login",
    summary: "Choose the Claude login a project's new chats start on: a login id, org (same as its organization) or none (this computer's order). Open chats keep theirs.",
    effect: "changes",
    params: { pid, login: { type: "string", description: "A login id (default: this computer's own), org, or none", in: "body", required: true } },
    route: { method: "PUT", path: "/api/projects/:pid/claude-login" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "admin",
  },
  changes("project.archive", "Archive Project", "Archive a project; refused while anything in it is open.", "POST", "/api/projects/:pid/archive", { pid }),
  changes("project.unarchive", "Unarchive Project", "Bring an archived project back.", "POST", "/api/projects/:pid/unarchive", { pid }),
  changes("project.preview.off", "Turn Off Preview Link", "Turn a preview link off at once.", "POST", "/api/previews/:id/off", { id: previewId }),
  looks("project.worktree.list", "List Project Worktrees", "A project's coding sessions' worktrees and their branches.", "/api/projects/:pid/overseer/worktrees"),
  changes("project.worktree.merge", "Merge Worktree", "Merge a coding session's worktree branch into its target.", "POST", "/api/projects/:pid/overseer/worktrees/merge", { pid, "session-id": codingSession }),
  changes("project.worktree.remove", "Remove Worktree", "Remove a coding session's worktree; its branch goes too only when merged.", "POST", "/api/projects/:pid/overseer/worktrees/remove", { pid, "session-id": codingSession }),
  looks("project.files.list", "List Project Files", "The files a project keeps.", "/api/projects/:pid/files"),
  looks("project.costs", "Show Project Costs", "A project's cost card: the last count at once, or a new one with --fresh 1.", "/api/projects/:pid/costs", {
    pid,
    fresh: { type: "string", description: "1: wait for a new count", in: "query", enum: ["1"] },
  }),
];

export const PROJECT_ENTRIES: CommandEntry[] = [
  {
    id: "project.services.view",
    label: "Show Project Services",
    summary: "A project's Branches tab: its copies, their services and the supervisor.",
    effect: "looks",
    params: { pid: { type: "string", description: "The project's id", in: "path", required: true } },
    route: { method: "GET", path: "/api/projects/:pid/services" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "sessions",
  },
  ...PROJECT_OVERSEER_ENTRIES,
  ...PROJECTS_SWEEP,
];
