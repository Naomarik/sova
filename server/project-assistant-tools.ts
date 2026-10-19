import { randomBytes } from "node:crypto";
import type { HEntry, ToolSpec } from "../shared/harness";
import type { ModelPick } from "../shared/powers";
import { OWNER_REQUEST_TEXT_MAX, OWNER_REQUEST_TITLE_MAX, type OwnerRequestKind } from "../shared/project-assistant";
import { agreeRequirement, changeOfRef, conversationDraftTools } from "./conversation-draft-tools";
import type { ConversationRef } from "./conversation-draft-store";
import { orgDir, OrgError, readProjects, readRoster } from "./orgs";
import { projectOverseerPaths, readPoSettings } from "./project-overseer-store";
import { assistantModelFor, fileRequest, orgRequests, setRequestStatus } from "./project-assistant-store";
import { specLookupTools } from "./spec-lookup";
import { operatorStarted } from "./project-assistant";
import type { ToolCtx } from "../shared/harness";

/**
 * The Project Assistant's served tools (§app.project-assistant/tools). Always: the spec and code
 * look-ups (outsider view, server/spec-lookup.ts), the conversation-draft tools per project
 * (server/conversation-draft-tools.ts) with its own requirement_agree, report_issue and
 * owner_requests. By the project's Project Assistant column: start_fix (codingStart) and deploy
 * (deploy), each set off as the caller kind `assistant` (assistantActs below), never as the
 * operator unless the operator started this turn (`attended`). Each answer is written for the
 * owner: what happened, in plain words, never a tool, a model or an id they would see.
 */

/** What the tools need of their conversation, asked at each call. */
export interface AssistantToolCtx {
  orgId: string;
  sessionId: string;
  /** The owner now. */
  owner(): { id: string; name: string } | null;
  /** The branch as its run started: a call's own branch when the call carries none. */
  branch(): readonly HEntry[];
}

/** An act's outcome, as the powers engine answers it. */
export type ActOutcome = { taken: true; held: boolean; sessionId?: string } | { taken: false; code: string; sentence: string };

/** The acts the tools set off: server/project-overseer.ts's assistantAct (the client column decides); tests stand in. */
export interface AssistantActs {
  buildStart(projectId: string, a: { requestId: string; title: string; text: string; model: ModelPick }, o: { attended: boolean; sessionId: string }): Promise<ActOutcome>;
  deployRun(projectId: string, a: { requestId: string; why: string }, o: { attended: boolean; sessionId: string }): Promise<ActOutcome>;
}

let actsForTest: AssistantActs | null = null;
export function setAssistantActsForTest(a: AssistantActs | null): void {
  actsForTest = a;
}

/** The powers engine's acts, stamped `by: "assistant"` (imported late: project-overseer reaches this module's store). */
async function acts(): Promise<AssistantActs> {
  if (actsForTest) return actsForTest;
  const { assistantAct } = await import("./project-overseer");
  return {
    buildStart: (pid, a, o) => assistantAct(pid, { act: "build/start", basis: { kind: "owner-request", id: a.requestId }, prompt: `${a.title}\n\n${a.text}`, title: `Fix: ${a.title}`, model: a.model ? { model: a.model.model, thinking: a.model.thinking ?? null } : null }, o),
    deployRun: (pid, a, o) => assistantAct(pid, { act: "deploy/run", basis: { kind: "owner-request", id: a.requestId }, ...(a.why ? { why: a.why.slice(0, 300) } : {}) }, o),
  };
}

/** The operator is asked to deploy the project's first target (deploy.request, as an overseer's ask):
    what a deploy left Off does (§app.project-services/deploy-callers). Best effort: the owner's request
    reaches Needs you either way. Returns whether the ask was filed. */
export async function askOperatorToDeploy(projectId: string, why: string): Promise<boolean> {
  try {
    const { listProjects } = await import("./projects/spaces");
    const root = listProjects().find((p) => p.id === projectId)?.root;
    if (!root) return false;
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { CONTRACT_FILE, parseDefinition } = await import("../shared/project-contract");
    const file = join(root, CONTRACT_FILE);
    if (!existsSync(file)) return false;
    const target = parseDefinition(readFileSync(file, "utf8")).deploy?.targets[0]?.name;
    if (!target) return false;
    const { projectEngine } = await import("./project-services/routes");
    const r = await projectEngine().run("deploy.request", { target, why: why.slice(0, 300) }, { kind: "assistant", id: "project-assistant", root });
    return !r.error;
  } catch {
    return false;
  }
}

const say = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });

/** The projects the owner may ask about: the org's, not switched off their page. */
export function assistantProjects(orgId: string): { id: string; name: string }[] {
  return readProjects(orgId)
    .filter((p) => !p.ownerHidden && !(p as { archived?: unknown }).archived)
    .map((p) => ({ id: p.id, name: p.name }));
}

function projectOf(orgId: string, asked: unknown): { id: string; name: string } {
  const ps = assistantProjects(orgId);
  if (!ps.length) throw new Error("There is no project to file this under yet.");
  if (typeof asked === "string" && asked.trim()) {
    const want = asked.trim().toLowerCase();
    const p = ps.find((x) => x.name.toLowerCase() === want || x.id.toLowerCase() === want);
    if (!p) throw new Error(`"${asked}" is not one of the owner's projects. Use one of: ${ps.map((x) => x.name).join(", ")}.`);
    return p;
  }
  if (ps.length > 1) throw new Error(`Say which project: one of ${ps.map((x) => x.name).join(", ")}.`);
  return ps[0]!;
}

const projectParam = (orgId: string) => (assistantProjects(orgId).length > 1 ? { project: str("Which project (its name).") } : {});
const needsProject = (orgId: string) => (assistantProjects(orgId).length > 1 ? ["project"] : []);

/** The project's Project Assistant column, as set, and its coding-model override. */
function columnOf(projectId: string) {
  try {
    const s = readPoSettings(projectOverseerPaths(projectId));
    return { assistant: s.powers?.assistant ?? null, models: s.powers?.assistantModels ?? null };
  } catch {
    return { assistant: null, models: null };
  }
}

const STATUS_WORDS: Record<string, string> = { "with-team": "with the team", started: "being worked on", done: "done", declined: "not planned" };

export function assistantTools(ctx: AssistantToolCtx): ToolSpec[] {
  const orgId = ctx.orgId;
  /** The operator started this run (their own turn in the chat): unrestricted. Read from the call's branch. */
  const attendedNow = (call: ToolCtx | undefined): boolean => operatorStarted(call?.branch() ?? ctx.branch());
  const conversation = (projectId?: string): ConversationRef | null => {
    const p = projectId ? assistantProjects(orgId).find((x) => x.id === projectId) : assistantProjects(orgId)[0];
    if (!p) return null;
    const owner = ctx.owner();
    return { sessionId: ctx.sessionId, projectId: p.id, orgId, kind: "assistant", title: "Project Assistant", ...(owner ? { person: owner } : {}) };
  };

  const reportIssue: ToolSpec = {
    name: "report_issue",
    label: "Report to the team",
    description:
      "File what the owner reports with the team: a problem (bug), that the app is down (outage), a question you can't answer from the spec or code, or a new feature they confirmed. The team sees it at once; an outage also reaches the operator's phone. Use the owner's own words for the title.",
    promptSnippet: "report_issue: file a problem, an outage, an open question or a confirmed feature with the team",
    parameters: obj(
      {
        ...projectParam(orgId),
        kind: str("What it is.", { enum: ["bug", "outage", "question", "feature"] }),
        title: str(`A short title in the owner's own words (at most ${OWNER_REQUEST_TITLE_MAX} characters).`),
        text: str(`What they said, what they saw, when (at most ${OWNER_REQUEST_TEXT_MAX} characters).`),
      },
      [...needsProject(orgId), "kind", "title", "text"],
    ),
    async execute(_id, params) {
      const p = projectOf(orgId, params.project);
      const kind = (["bug", "outage", "question", "feature"] as const).includes(params.kind) ? (params.kind as OwnerRequestKind) : "bug";
      const r = fileRequest(orgId, { projectId: p.id, kind, title: params.title, text: params.text });
      return say(kind === "outage" ? "Filed, and the team was alerted at once. Tell the owner the team knows the app is down." : "Filed with the team. Tell the owner it's with the team and they can follow it under Your requests.", { request: r.id });
    },
  };

  const ownerRequests: ToolSpec = {
    name: "owner_requests",
    label: "The owner's requests",
    description: "The owner's requests and where each one stands (with the team, being worked on, done, not planned), newest first.",
    promptSnippet: "owner_requests: the owner's requests and where they stand",
    parameters: obj({}, []),
    async execute() {
      const names = new Map(assistantProjects(orgId).map((p) => [p.id, p.name]));
      const rows = orgRequests(orgId).filter((r) => names.has(r.projectId));
      if (!rows.length) return say("The owner has no requests yet.");
      return say(rows.map((r) => `- ${r.title} (${names.get(r.projectId)}): ${STATUS_WORDS[r.status] ?? r.status}, since ${r.updatedAt.slice(0, 10)}`).join("\n"));
    },
  };

  const startFix: ToolSpec = {
    name: "start_fix",
    label: "Start a fix",
    description:
      "Ask for a fix of a problem the owner reported: the team's coding work starts on its own copy, or, when that isn't allowed on its own here, the request goes to the team. Say back to the owner what the answer says.",
    promptSnippet: "start_fix: have a fix started for a problem (or filed with the team when that isn't allowed here)",
    parameters: obj(
      {
        ...projectParam(orgId),
        title: str(`The fix, in the owner's words (at most ${OWNER_REQUEST_TITLE_MAX} characters).`),
        text: str("What is wrong and what the owner expects instead."),
      },
      [...needsProject(orgId), "title", "text"],
    ),
    async execute(_id, params, _signal, _update, call) {
      const p = projectOf(orgId, params.project);
      const r = fileRequest(orgId, { projectId: p.id, kind: "fix", title: params.title, text: params.text });
      const attended = attendedNow(call);
      const col = columnOf(p.id);
      const model = assistantModelFor(orgId, "coding", col.models).pick;
      const team = (why: string) => say(`Filed with the team (${why}). Tell the owner it's with the team; they can follow it under Your requests.`, { request: r.id, started: false });
      if (!model) return team("no model is set for fixes");
      if (!attended && col.assistant && !col.assistant.codingStart) return team("starting fixes on its own is off here");
      const a = await acts();
      const out = await a.buildStart(p.id, { requestId: r.id, title: r.title, text: r.text, model }, { attended, sessionId: ctx.sessionId });
      if (!out.taken) return team(out.code === "power-off" ? "starting fixes on its own is off here" : "the team has to start it");
      if (out.sessionId) setRequestStatus(orgId, r.id, "started", { sessionId: out.sessionId });
      return say(out.held ? "The fix will start in a few minutes unless the team stops it. Tell the owner it's being worked on soon." : "The fix has started. Tell the owner it's being worked on; a version to try shows up when it's ready.", { request: r.id, started: !out.held });
    },
  };

  const deploy: ToolSpec = {
    name: "deploy",
    label: "Release",
    description: "Ask for a release of the project's current version: it runs the project's own release steps, or, when that isn't allowed on its own here, asks the team to release.",
    promptSnippet: "deploy: release the current version (or ask the team to)",
    parameters: obj({ ...projectParam(orgId), why: str("Why the owner wants it released now.") }, [...needsProject(orgId), "why"]),
    async execute(_id, params, _signal, _update, call) {
      const p = projectOf(orgId, params.project);
      const r = fileRequest(orgId, { projectId: p.id, kind: "deploy", title: `Release ${p.name}`, text: String(params.why ?? "") || "The owner asked for a release." });
      const attended = attendedNow(call);
      const col = columnOf(p.id);
      const team = async () => {
        await askOperatorToDeploy(p.id, `The owner asked for a release: ${r.text}`);
        return say("Asked the team to release it. Tell the owner the team will release it.", { request: r.id, started: false });
      };
      if (!attended && col.assistant && !col.assistant.deploy) return await team();
      const a = await acts();
      const out = await a.deployRun(p.id, { requestId: r.id, why: r.text }, { attended, sessionId: ctx.sessionId });
      if (!out.taken) return await team();
      setRequestStatus(orgId, r.id, "started");
      return say(out.held ? "The release will start in a few minutes unless the team stops it." : "The release has started. Tell the owner it's on its way.", { request: r.id, started: true });
    },
  };

  const agree: ToolSpec = {
    name: "requirement_agree",
    label: "Note a requirement",
    description:
      "Note one new requirement (or a change to how something works) the owner asked for, in plain neutral words, never a quote. `changes`: the look-up reference of what it changes, when it changes something that exists. Before the conversation moves on, repeat everything back (requirements_summary) and only after a clear yes call requirements_confirm.",
    promptSnippet: "requirement_agree: note a new requirement the owner asked for",
    parameters: obj(
      {
        ...projectParam(orgId),
        title: str("A short title."),
        text: str("What should be true, in plain neutral words."),
        changes: str("A spec_lookup reference of what it changes (optional)."),
      },
      [...needsProject(orgId), "title", "text"],
    ),
    async execute(_id, params, _signal, _update, call) {
      const p = projectOf(orgId, params.project);
      const ref = conversation(p.id);
      const owner = ctx.owner();
      if (!ref || !owner) throw new Error("This conversation has no owner now.");
      const branch = call?.branch() ?? ctx.branch();
      const lastUser = [...branch].reverse().find((e) => e.kind === "user");
      const change = params.changes ? await changeOfRef(ctx.sessionId, p.id, params.changes) : {};
      const statement = `${String(params.title ?? "").trim()}: ${String(params.text ?? "").trim()}`;
      const { itemId } = await agreeRequirement(
        ref,
        { decisionId: `${ctx.sessionId}:${randomBytes(6).toString("hex")}`, area: "Requirements", areaKey: "requirements", statement, quote: "", by: owner.id, name: owner.name, at: new Date().toISOString(), entryId: lastUser?.id ?? "" },
        change,
      );
      return say("Noted (not confirmed yet). Repeat everything agreed back to the owner before you finish, and confirm only after a clear yes.", { item: itemId });
    },
  };

  const drafts = conversationDraftTools({ sessionId: ctx.sessionId, conversation, projects: () => assistantProjects(orgId).map((p) => ({ projectId: p.id, name: p.name })) });
  const lookups = specLookupTools({ sessionId: ctx.sessionId, projects: () => assistantProjects(orgId), view: "outsider" });
  return [...lookups, agree, ...drafts, reportIssue, ownerRequests, startFix, deploy];
}

/** The tool names, in loadout order (the allowlist). */
export const ASSISTANT_TOOL_NAMES = ["spec_lookup", "code_read", "requirement_agree", "requirement_drop", "requirements_summary", "requirements_confirm", "report_issue", "owner_requests", "start_fix", "deploy"] as const;

/** The owner's display name now (the tools' ctx). */
export function ownerNow(orgId: string, personId: string): { id: string; name: string } | null {
  const p = readRoster(orgId).find((x) => x.id === personId && x.status === "active");
  return p ? { id: p.id, name: p.name } : null;
}

export { orgDir, OrgError };

// A fix the assistant set off started its coding session (at once, or at its hold's end): its request
// reads `started`, with the session that shows as "Fix: {title}" (§app.project-assistant/requests, /versions).
void import("./project-overseer")
  .then(({ onOwnerFixStarted }) =>
    onOwnerFixStarted((e) => {
      try {
        setRequestStatus(e.orgId, e.basisId, "started", { sessionId: e.sessionId });
      } catch (err) {
        console.warn(`[project-assistant] marking a fix started failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  )
  .catch(() => {});
