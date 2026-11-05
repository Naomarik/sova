/**
 * Projects: the project verbs, made from the contract's lists, and the project screens. Part of the command catalogue, assembled by shared/commands-catalog.ts
 * (rules: agents/server/commands/overview.md). Pure, erasable syntax only.
 */
import { DEPLOY_READ_VERBS, DEPLOY_VERBS, MERGE_READ_VERBS, MERGE_VERBS, READ_VERBS, RELEASE_READ_VERBS, RELEASE_VERBS, VERB_FLAGS, VERB_PARAMS, VERBS } from "../project-contract.ts";
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

/** The keys scripts/sova-project.mjs sends for a merge verb, as params. */
const MERGE_PARAMS: Record<string, CommandParam> = Object.fromEntries(VERB_FLAGS.merge.map((f) => verbParam(f, false)));

/** The keys scripts/sova-project.mjs sends for a release verb, as params. */
const RELEASE_PARAMS: Record<string, CommandParam> = Object.fromEntries(VERB_FLAGS.release.map((f) => verbParam(f, false)));

/** One entry per project verb, deploy verb, merge verb and release verb, from the contract's own lists. */
export const VERB_ENTRIES: CommandEntry[] = [...VERBS, ...DEPLOY_VERBS, ...MERGE_VERBS, ...RELEASE_VERBS].map((verb): CommandEntry => {
  const deploy = (DEPLOY_VERBS as readonly string[]).includes(verb);
  const merge = (MERGE_VERBS as readonly string[]).includes(verb);
  const release = (RELEASE_VERBS as readonly string[]).includes(verb);
  const reads = (READ_VERBS as readonly string[]).includes(verb) || (DEPLOY_READ_VERBS as readonly string[]).includes(verb) || (MERGE_READ_VERBS as readonly string[]).includes(verb) || (RELEASE_READ_VERBS as readonly string[]).includes(verb);
  return {
    id: `project.verb.${verb}`,
    label: `Project ${verb}`,
    summary: `The project verb ${verb}, as the operator (sova-project ${verb}).`,
    effect: reads ? "looks" : "changes",
    params: deploy ? DEPLOY_PARAMS : merge ? MERGE_PARAMS : release ? RELEASE_PARAMS : INSTANCE_PARAMS,
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

/** The merge queue's settings (Settings → Merge Queue) and the read-only folder viewer they open. */
const mqProject: CommandParam = { type: "string", description: "The project's id", in: "path", required: true };
const folderSrc: CommandParam = { type: "json", description: 'The folder: {kind: "project", project, ref, dir} or {kind: "builtin", id}', in: "query", required: true };
const MERGE_SETTINGS: CommandEntry[] = [
  {
    id: "project.merge-queue.settings.get",
    label: "Show Queue Settings",
    summary: "Every setting a project's merge queue uses: from the project's file on the target, this computer, or set by Sova.",
    effect: "looks",
    params: { project: mqProject },
    route: { method: "GET", path: "/api/merge-queue/projects/:project/settings" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "sessions",
  },
  {
    id: "project.merge-queue.models.set",
    label: "Change Review Model",
    summary: "The review's and the merge thread's model and effort for this project, on this computer; null: Same as new chats.",
    effect: "changes",
    params: {
      project: mqProject,
      review: { type: "json", description: '{model: "provider/model", thinking?} or null', in: "body", nullable: true },
      thread: { type: "json", description: '{model: "provider/model", thinking?} or null', in: "body", nullable: true },
    },
    route: { method: "PUT", path: "/api/merge-queue/projects/:project/models" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "admin",
  },
  {
    id: "project.merge-queue.settings.save",
    label: "Save Queue Setting",
    summary: "Push, review on or off, and each check's time limit, rerun and optional, as one commit on the target; waits while a branch is checking.",
    effect: "changes",
    params: {
      project: mqProject,
      changes: { type: "json", description: "{push?, review?, checks?: {<id>: {timeoutSec?, rerun?, optional?}}}", in: "body", required: true },
      confirm: { type: "boolean", description: "The commit on the target is confirmed", in: "body", required: true },
    },
    route: { method: "POST", path: "/api/merge-queue/projects/:project/settings" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "admin",
  },
  {
    id: "project.merge-queue.settings.cancel",
    label: "Cancel Waiting Save",
    summary: "Cancel a queue settings save that waits for the branch checking now.",
    effect: "changes",
    params: { project: mqProject },
    route: { method: "DELETE", path: "/api/merge-queue/projects/:project/settings/pending" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "admin",
  },
  {
    id: "project.folder.list",
    label: "Open Folder",
    summary: "The files of one folder of a project at a commit, or of one of Sova's own folders; read only, never run.",
    effect: "looks",
    params: { src: folderSrc },
    route: { method: "GET", path: "/api/folders/list" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "sessions",
  },
  {
    id: "project.folder.read",
    label: "Read Folder File",
    summary: "One file of such a folder, as text: documents to render, scripts shown, never run.",
    effect: "looks",
    params: { src: folderSrc, path: { type: "string", description: "The file, inside the folder", in: "query", required: true } },
    route: { method: "GET", path: "/api/folders/read" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "sessions",
  },
];

/** A branch's summary on the queue's rows: Try Again after a failed one (a summary that worked is never rewritten). */
const MERGE_SUMMARY: CommandEntry[] = [
  {
    id: "project.merge-queue.branch-summary.retry",
    label: "Try Again",
    summary: "Write a branch's summary again after it failed, for the same commit; refused for a summary that worked.",
    effect: "changes",
    params: {
      project: mqProject,
      branch: { type: "string", description: "The branch", in: "body", required: true },
      commit: { type: "string", description: "The full commit id the row shows", in: "body", required: true },
    },
    route: { method: "POST", path: "/api/merge-queue/projects/:project/branch-summary" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "admin",
  },
  {
    id: "project.merge-queue.landing-summary",
    label: "Show Landings",
    summary: "Every project's merge queue and open release in one quick read: the run checking now, the line, what waits for you, the newest landings and the release's steps.",
    effect: "looks",
    params: {},
    route: { method: "GET", path: "/api/merge-queue/landing-summary" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "sessions",
  },
];

/** How a branch lands (al_3): Update Local Main, a request's Publish, How it lands. The operator's own page only. */
const MERGE_LANDING: CommandEntry[] = [
  {
    id: "project.merge-queue.update-local-main",
    label: "Update Local Main",
    summary: "On a project that lands by request: fast-forward this computer's main (and its folder) to origin's; refused, with why, when the folder has uncommitted edits.",
    effect: "changes",
    params: { project: mqProject },
    route: { method: "POST", path: "/api/merge-queue/projects/:project/update-local-main" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "admin",
  },
  {
    id: "project.merge-queue.request.publish",
    label: "Publish Request",
    summary: "Publish a checked branch's pull or merge request with the title and description you reviewed: the spec docs commit, the leak scan, the push, then the request.",
    effect: "changes",
    params: {
      id: { type: "string", description: "The queue entry (mq_…)", in: "path", required: true },
      title: { type: "string", description: "The request's title", in: "body", required: true },
      body: { type: "string", description: "The request's description", in: "body", required: true },
      draft: { type: "boolean", description: "Open it as a draft", in: "body" },
    },
    route: { method: "POST", path: "/api/merge-queue/entries/:id/publish" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "admin",
  },
  {
    id: "project.merge-queue.land-how.set",
    label: "Change How It Lands",
    summary: "How the project's branches land (merge locally, pull request, merge request, push branch only), on this computer or in the project's file.",
    effect: "changes",
    params: {
      project: mqProject,
      how: { type: "string", description: '"local", "github-pr", "gitlab-mr" or "push-branch"', in: "body", required: true },
      where: { type: "string", description: '"computer" (this computer only) or "project" (the project\'s file)', in: "body", required: true },
    },
    route: { method: "PUT", path: "/api/merge-queue/projects/:project/land-how" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "admin",
  },
  {
    id: "project.merge-queue.land-how.clear",
    label: "Clear This Computer's Choice",
    summary: "Drop this computer's How it lands choice, so the project file's (or Merge locally) applies.",
    effect: "changes",
    params: { project: mqProject },
    route: { method: "DELETE", path: "/api/merge-queue/projects/:project/land-how/override" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "admin",
  },
];

/** The projects sweep (§app.project-commands/projects-sweep): each row points at the route the web app's own control uses. */
const PROJECTS_SWEEP: CommandEntry[] = [
  looks("project.list", "List Projects", "Every registered project, in an organization or not.", "/api/projects", {}),
  looks("project.glance", "Show Project Glance", "Every listed project's runtime figures, as the overview's cards show them: ready to merge, running copies, memory in use, a landing or release moving.", "/api/projects/glance", {}),
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
  changes("project.coding.start", "New Chat in Project", "Start a coding chat in a project: in its root (or a folder inside it), on the project's coding model and mode; with worktree later it cuts its own branch once the work has a name.", "POST", "/api/projects/:pid/overseer/coding", {
    pid,
    title: { type: "string", description: "Names the chat (and, with worktree now, its branch)", in: "body" },
    model: { type: "string", description: "Its model (provider/model); absent: the project's coding model", in: "body" },
    thinking: { type: "string", description: "Its thinking level", in: "body" },
    worktree: { type: "string", description: "now: cut its worktree at the start; later: start in the root, adopt the first worktree it makes", in: "body", enum: ["now", "later"], default: "now" },
    cwd: { type: "path", description: "Where it starts: the root, a folder inside it, or one inside its worktrees (default: the root)", in: "body" },
  }),
  // A project's icon (§app.projects/icon): kept on this host only.
  looks("project.icon.get", "Show Project Icon", "What a project's icon is: an uploaded picture, one found in its folder, or letters (rescans the folder).", "/api/projects/:pid/icon/info"),
  {
    id: "project.icon.upload",
    label: "Upload Project Icon",
    summary: "Set a project's icon to a picture: a square PNG of 64 to 1024 px, at most 1 MB, base64. Kept on this computer only.",
    effect: "changes",
    params: { pid, png: { type: "string", description: "The picture: a square PNG, base64", in: "body", required: true } },
    route: { method: "PUT", path: "/api/projects/:pid/icon" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "admin",
  },
  changes("project.icon.letters", "Use Project Letters", "Show a project's letters instead of its picture (true), or its picture again (false).", "PATCH", "/api/projects/:pid/icon", {
    pid,
    letters: { type: "boolean", description: "true: letters; false: the uploaded or found picture", in: "body", required: true },
  }),
  {
    id: "project.icon.remove",
    label: "Remove Project Icon",
    summary: "Remove a project's uploaded picture: back to the icon found in its folder, or letters.",
    effect: "changes",
    params: { pid },
    route: { method: "DELETE", path: "/api/projects/:pid/icon" },
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
  looks("project.offers.list", "List Project Offers", "A project's offers file, read now: each offer, its buttons, run approval and shown/used counts.", "/api/projects/:pid/offers"),
  looks("project.cards.list", "List Project Card Types", "A project's card folders on its main checkout, read now: each type, or what is wrong with a broken one, and whether its cards are trusted.", "/api/projects/:pid/cards"),
  // A project's settings (§app.project-overseer/settings). Apply and Land are trust grants, never commands.
  looks("project.settings.get", "Show Project Settings", "Every setting of a project, Sova-kept and in its files, with its state; the settings cards waiting and the folder's uncommitted settings edits.", "/api/projects/:pid/settings"),
  looks("project.settings.history", "Show Settings History", "A project's settings changes, newest first: what changed, from and to, and who changed it.", "/api/projects/:pid/settings/history"),
  changes("project.settings.undo", "Undo Settings Change", "Put a Sova-kept setting back (refused when it changed since); undoing a file change makes a new card to apply.", "POST", "/api/projects/:pid/settings/undo", {
    pid,
    id: { type: "string", description: "The history line's id (h…)", in: "body", required: true },
  }),
  changes("project.settings.propose.withdraw", "Dismiss Settings Card", "Dismiss a settings card the project overseer made; on the folder's uncommitted edits (local) it discards them.", "POST", "/api/projects/:pid/settings/cards/:card/withdraw", {
    pid,
    card: { type: "string", description: "The card's id (sc_…), or local", in: "path", required: true },
    fingerprint: { type: "string", description: "local only: the fingerprint the card showed", in: "body" },
    "cancel-save": { type: "boolean", description: "local only: cancel a held Land and keep the edits", in: "body", key: "cancelSave" },
  }),
  changes("project.overseer.settings.set", "Set Project Overseer Settings", "Change a project overseer's settings: Watch, powers, models, limits, pace, the hold, extra instructions.", "PATCH", "/api/projects/:pid/overseer", {
    pid,
    watch: { type: "boolean", description: "Watch: it looks on its own", in: "body" },
    powers: { type: "json", description: "Switches: {overseer: {<power>: true|false}, assistant: {…}}", in: "body" },
    resume: { type: "boolean", description: "true lifts the brake", in: "body" },
    caps: { type: "json", description: "Limits: {<limit>: <whole number> | null}", in: "body" },
    model: { type: "string", description: "Its model (provider/model), or null for the default", in: "body", nullable: true },
    thinking: { type: "string", description: "Its thinking level, or null", in: "body", nullable: true },
    "coding-model": { type: "string", description: "Coding sessions' model, or null for its own", in: "body", key: "codingModel", nullable: true },
    "coding-thinking": { type: "string", description: "Coding sessions' thinking, or null", in: "body", key: "codingThinking", nullable: true },
    "gathering-model": { type: "string", description: "Gathering sessions' model, or null for its own", in: "body", key: "gatheringModel", nullable: true },
    "gathering-thinking": { type: "string", description: "Gathering sessions' thinking, or null", in: "body", key: "gatheringThinking", nullable: true },
    "gathering-abilities": { type: "json", description: "Gathering sessions' abilities, or null for Automatic", in: "body", key: "gatheringAbilities", nullable: true },
    "watch-gap-min": { type: "integer", description: "At most one look every this many minutes (1–1440)", in: "body", key: "watchGapMin" },
    "soon-look-sec": { type: "integer", description: "A look this many seconds after something to see soon (30–3600), or null for Off", in: "body", key: "soonLookSec", nullable: true },
    "hold-min": { type: "integer", description: "The hold in minutes (0–1440; 0: no hold)", in: "body", key: "holdMin" },
    "extra-instructions": { type: "string", description: "Its extra instructions (blank removes them)", in: "body", key: "extraSystemPrompt" },
    "assistant-models": { type: "json", description: "The Project Assistant's models for this project, or null", in: "body", key: "assistantModels", nullable: true },
  }),
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
  ...MERGE_SETTINGS,
  ...MERGE_LANDING,
  ...MERGE_SUMMARY,
];
