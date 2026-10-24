import { randomBytes } from "node:crypto";
import type { HEntry, ToolSpec } from "../shared/harness";
import type { ModelPick } from "../shared/powers";
import { assistantWouldAct, deployTargetOf } from "./assistant-would-act";
import { OWNER_REQUEST_TEXT_MAX, OWNER_REQUEST_TITLE_MAX, type OwnerRequest, type OwnerRequestKind } from "../shared/project-assistant";
import { closeTryRequests, noteVersionFailed, noteVersionStarting, projectVersions, START_TIMEOUT_MS, type OwnerVersion } from "./owner-versions";
import { agreeRequirement, changeOfRef, conversationDraftTools } from "./conversation-draft-tools";
import type { ConversationRef } from "./conversation-draft-store";
import { orgDir, OrgError, readProjects, readRoster } from "./orgs";
import { projectOverseerPaths, readPoSettings } from "./project-overseer-store";
import { advanceRequest, effectiveAssistantModel, fileRequest, orgRequests } from "./project-assistant-store";
import { specLookupTools } from "./spec-lookup";
import { setFeatureStartForTest, startFeatureChat } from "./feature-chats";
import type { ToolWords } from "./project-assistant-offers";

/**
 * The Project Assistant's served tools (§app.project-assistant/tools). Always: the spec and code
 * look-ups (outsider view, server/spec-lookup.ts), the conversation-draft tools per project
 * (server/conversation-draft-tools.ts) with its own requirement_agree, report_issue and
 * owner_requests. By the project's Project Assistant column: start_fix (codingStart), deploy
 * (deploy), start_version (copiesRun) and start_feature_chat (gather), each set off as the caller
 * kind `assistant` (assistantActs below), never as the operator, in the operator's own turns too
 * (§app.project-assistant/offers: no part of the question is skipped). Which of them the model sees,
 * and how deploy and start_version describe themselves, follow what would happen now
 * (server/project-assistant-offers.ts). Each answer is written for the owner: what happened, in
 * plain words, never a tool, a model or an id they would see.
 */

/** What the tools need of their conversation, asked at each call. */
export interface AssistantToolCtx {
  orgId: string;
  sessionId: string;
  /** The owner now. */
  owner(): { id: string; name: string } | null;
  /** The branch as its run started: a call's own branch when the call carries none. */
  branch(): readonly HEntry[];
  /** How deploy and start_version describe themselves (§app.project-assistant/offers); absent: as when every ability is on. */
  words?: ToolWords;
}

/** An act's outcome, as the powers engine answers it. */
export type ActOutcome = { taken: true; held: boolean; sessionId?: string } | { taken: false; code: string; sentence: string };
/** A copy's start, as start_version's act answers it: `done` follows the `up` that goes on after the answer. */
export type CopyStartOutcome = { taken: true; done: Promise<{ ok: true } | { ok: false; code: string; message: string }> } | { taken: false; code: string; sentence: string };

/** The acts the tools set off: server/project-overseer.ts's assistantAct (the client column decides); tests stand in. */
export interface AssistantActs {
  buildStart(projectId: string, a: { requestId: string; title: string; text: string; model: ModelPick }, o: { attended: boolean; sessionId: string }): Promise<ActOutcome>;
  deployRun(projectId: string, a: { requestId: string; why: string }, o: { attended: boolean; sessionId: string }): Promise<ActOutcome>;
  /** The project's services/run act, then the engine's up of exactly that instance (§app.project-services/callers). */
  copyStart(projectId: string, a: { instance: string; root: string }, o: { attended: boolean; sessionId: string }): Promise<CopyStartOutcome>;
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
    copyStart: async (pid, a, o) => {
      const out = await assistantAct(pid, { act: "services/run", instance: a.instance, root: a.root }, o);
      if (!out.taken) return out;
      return { taken: true, done: out.done ?? Promise.resolve({ ok: true as const }) };
    },
  };
}

/** The operator is asked to deploy the project's first target (deploy.request, as an overseer's ask):
    what a deploy left Off does (§app.project-services/deploy-callers). Best effort: the owner's request
    reaches Needs you either way. Returns whether the ask was filed. */
export async function askOperatorToDeploy(projectId: string, why: string): Promise<boolean> {
  try {
    const target = await deployTargetOf(projectId);
    if (!target) return false;
    const { listProjects } = await import("./projects/spaces");
    const root = listProjects().find((p) => p.id === projectId)?.root;
    if (!root) return false;
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

// ---- versions to try (§app.project-assistant/versions) ------------------------------------------------------

const VERSION_STATE_WORDS: Record<OwnerVersion["state"], string> = { running: "running", starting: "starting", failed: "didn't start (the team knows)", "not-running": "not running" };

/** A shown project's versions (its root read now); none when it has no root or none are listed. */
async function versionsOf(orgId: string, projectId: string): Promise<OwnerVersion[]> {
  const p = readProjects(orgId).find((x) => x.id === projectId);
  if (!p) return [];
  return await projectVersions(orgId, p).catch((): OwnerVersion[] => []);
}

/** The open `try` request for this version, or a new one (a second ask files none, §app.project-assistant/requests). */
function tryRequest(orgId: string, projectId: string, label: string, text: string): OwnerRequest {
  const open = orgRequests(orgId).find((r) => r.projectId === projectId && r.kind === "try" && r.title === label.slice(0, OWNER_REQUEST_TITLE_MAX) && r.status === "with-team");
  return open ?? fileRequest(orgId, { projectId, kind: "try", title: label.slice(0, OWNER_REQUEST_TITLE_MAX), text: text.slice(0, OWNER_REQUEST_TEXT_MAX) });
}

/** After the answer: the up that goes on, and the start timeout. A failure files the `try` request once (the team knows). */
function followStart(orgId: string, projectId: string, v: OwnerVersion, done: Promise<{ ok: true } | { ok: false; code: string; message: string }>): void {
  let filed = false;
  const fail = (why: string) => {
    if (filed) return;
    filed = true;
    noteVersionFailed(v.rec.id);
    try {
      tryRequest(orgId, projectId, v.label, `The owner asked to try it; it didn't start: ${why}`);
    } catch (err) {
      console.warn(`[project-assistant] filing a version that didn't start: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  void done.then((r) => {
    if (!r.ok) fail(`${r.code}: ${r.message}`);
    else closeTryRequests(orgId, projectId, v.label);
  });
  const t = setTimeout(() => {
    void versionsOf(orgId, projectId).then((vs) => {
      if (vs.find((x) => x.rec.id === v.rec.id)?.state === "failed") fail(`it hadn't answered ${START_TIMEOUT_MS / 60_000} minutes after the start`);
    });
  }, START_TIMEOUT_MS + 1000);
  t.unref?.();
}

const STATUS_WORDS: Record<string, string> = { "with-team": "with the team", started: "being worked on", done: "done", declined: "not planned" };

export function assistantTools(ctx: AssistantToolCtx): ToolSpec[] {
  const orgId = ctx.orgId;
  const words = ctx.words ?? { releaseSelf: true, versionStart: true };
  /** No turn is attended here, the operator's own included (§app.project-assistant/offers). */
  const attended = false;
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
    async execute(_id, params) {
      const p = projectOf(orgId, params.project);
      const r = fileRequest(orgId, { projectId: p.id, kind: "fix", title: params.title, text: params.text });
      const col = columnOf(p.id);
      const model = effectiveAssistantModel(orgId, "coding", col.models)?.pick ?? null;
      const team = (why: string) => say(`Filed with the team (${why}). Tell the owner it's with the team; they can follow it under Your requests.`, { request: r.id, started: false });
      // The owner page's question (§app.project-assistant/abilities): on `team`, nothing is set off.
      const would = await assistantWouldAct(orgId, p.id, "fix");
      const why = { "no-model": "no model is set for fixes", "power-off": "starting fixes on its own is off here" } as Record<string, string>;
      if (would.outcome === "team") return team(why[would.reason] ?? "the team has to start it");
      if (!model) return team(why["no-model"]!);
      const a = await acts();
      const out = await a.buildStart(p.id, { requestId: r.id, title: r.title, text: r.text, model }, { attended, sessionId: ctx.sessionId });
      if (!out.taken) return team(out.code === "power-off" ? "starting fixes on its own is off here" : "the team has to start it");
      if (out.sessionId) advanceRequest(orgId, r.id, "started", { sessionId: out.sessionId });
      return say(out.held ? "The fix will start in a few minutes unless the team stops it. Tell the owner it's being worked on soon." : "The fix has started. Tell the owner it's being worked on; a version to try shows up when it's ready.", { request: r.id, started: !out.held });
    },
  };

  const deploy: ToolSpec = {
    name: "deploy",
    label: "Release",
    description: words.releaseSelf
      ? "Ask for a release of the project's current version: it runs the project's own release steps, or, when that isn't allowed on its own here, asks the team to release."
      : "Ask the team for a release of the project's current version: the request goes to the team (and, where the project has release steps, asks them to release). It never releases on its own here.",
    promptSnippet: words.releaseSelf ? "deploy: release the current version (or ask the team to)" : "deploy: ask the team for a release",
    parameters: obj({ ...projectParam(orgId), why: str("Why the owner wants it released now.") }, [...needsProject(orgId), "why"]),
    async execute(_id, params) {
      const p = projectOf(orgId, params.project);
      const r = fileRequest(orgId, { projectId: p.id, kind: "deploy", title: `Release ${p.name}`, text: String(params.why ?? "") || "The owner asked for a release." });
      const team = async (noSteps = false) => {
        const asked = await askOperatorToDeploy(p.id, `The owner asked for a release: ${r.text}`);
        // No release steps (or no ask filed): the request is with the team, never a promise that they release it.
        if (noSteps || !asked) return say("Filed with the team. Tell the owner their request is with the team; they can follow it under Your requests. Don't say it is released or that the team will release it.", { request: r.id, started: false });
        return say("Asked the team to release it. Tell the owner the team will release it.", { request: r.id, started: false });
      };
      const would = await assistantWouldAct(orgId, p.id, "release");
      if (would.outcome === "team") return await team(would.reason === "no-recipe");
      const a = await acts();
      const out = await a.deployRun(p.id, { requestId: r.id, why: r.text }, { attended, sessionId: ctx.sessionId });
      if (!out.taken) return await team();
      advanceRequest(orgId, r.id, "started");
      return say(out.held ? "The release will start in a few minutes unless the team stops it." : "The release has started. Tell the owner it's on its way.", { request: r.id, started: true });
    },
  };

  const ownerVersions: ToolSpec = {
    name: "owner_versions",
    label: "Versions to try",
    description:
      "The versions of each project the owner can try (the current version, each fix's copy), and whether each is running, starting, didn't start or not running. Use it before you answer \"can I try it?\"; start one with start_version.",
    promptSnippet: "owner_versions: the versions the owner can try, and whether each is running",
    parameters: obj({}, []),
    async execute() {
      const lines: string[] = [];
      for (const p of assistantProjects(orgId)) {
        const vs = await versionsOf(orgId, p.id);
        if (!vs.length) {
          lines.push(`- ${p.name}: no versions to try.`);
          continue;
        }
        for (const v of vs) lines.push(`- ${p.name}: ${v.label}: ${v.endpoint === null ? "can't be shown outside the team" : VERSION_STATE_WORDS[v.state]}`);
      }
      return say(lines.length ? lines.join("\n") : "There is no project yet.");
    },
  };

  const startVersion: ToolSpec = {
    name: "start_version",
    label: "Start a version",
    description: words.versionStart
      ? "Start a version the owner wants to try: one owner_versions lists, by its label. When it starts (or already runs), its Open button shows in this chat and on the owner's home page; never write a link yourself. When starting it on its own isn't allowed here, it goes to the team. Say back to the owner what the answer says."
      : "Open a version the owner wants to try that is running or starting: one owner_versions lists, by its label. Its Open button shows in this chat and on the owner's home page; never write a link yourself. A version that isn't running is not started here: the request goes to the team. Say back to the owner what the answer says.",
    promptSnippet: words.versionStart ? "start_version: start a version the owner wants to try (or ask the team to)" : "start_version: open a running version the owner wants to try (or ask the team to start one)",
    parameters: obj(
      {
        ...projectParam(orgId),
        version: str("The version's label, as owner_versions gives it (e.g. \"Current version\"); optional when the project has only one."),
      },
      needsProject(orgId),
    ),
    async execute(_id, params) {
      const p = projectOf(orgId, params.project);
      const vs = await versionsOf(orgId, p.id);
      if (!vs.length) return say(`${p.name} has no versions to try.`);
      const asked = typeof params.version === "string" ? params.version.trim().toLowerCase() : "";
      const v = asked ? vs.find((x) => x.label.toLowerCase() === asked) : vs.length === 1 ? vs[0] : undefined;
      if (!v) throw new Error(`Say which version: one of ${vs.map((x) => `"${x.label}"`).join(", ")}.`);
      if (v.endpoint === null) return say(`${p.name}'s versions can't be shown outside the team.`);
      const ready = `${v.label} of ${p.name}`;
      if (v.state === "running") return say(`${ready} is running. Its Open button is in this chat and on the home page.`, { version: v.handle });
      if (v.state === "starting") return say(`${ready} is starting. Its Open button is in this chat and on the home page.`, { version: v.handle });
      const team = (sentence: string) => {
        const r = tryRequest(orgId, p.id, v.label, `The owner asked to try it. ${sentence}`);
        return say(sentence, { request: r.id, started: false });
      };
      const failed = (why: string) => {
        noteVersionFailed(v.rec.id);
        const r = tryRequest(orgId, p.id, v.label, `The owner asked to try it; it didn't start: ${why}`);
        return say("It didn't start; the team knows.", { request: r.id, started: false });
      };
      const would = await assistantWouldAct(orgId, p.id, "version");
      if (would.outcome === "team") return team(would.sentence ?? "It went to the team.");
      const a = await acts();
      const out = await a.copyStart(p.id, { instance: v.rec.id, root: v.rec.project }, { attended, sessionId: ctx.sessionId });
      if (!out.taken) return out.code === "power-off" || out.code === "brake" ? team(out.sentence) : failed(`${out.code}: ${out.sentence}`);
      noteVersionStarting(v.rec.id);
      followStart(orgId, p.id, v, out.done);
      return say(`${ready} is starting. Its Open button is in this chat and on the home page.`, { version: v.handle, started: true });
    },
  };

  const startFeature: ToolSpec = {
    name: "start_feature_chat",
    label: "Plan something new",
    description:
      "The owner wants something new: open a feature request chat, a separate conversation where it is planned with them on plan cards, with drawings and prototypes to try. Agree a short title with them first. When opening one on its own isn't allowed here, it goes to the team. Say back to the owner what the answer says.",
    promptSnippet: "start_feature_chat: open a chat to plan something new with the owner (or send it to the team)",
    parameters: obj(
      {
        ...projectParam(orgId),
        title: str(`What they want, in their words (at most ${OWNER_REQUEST_TITLE_MAX} characters).`),
        text: str("What they asked for and why, as they said it."),
      },
      [...needsProject(orgId), "title", "text"],
    ),
    async execute(_id, params) {
      const p = projectOf(orgId, params.project);
      const owner = ctx.owner();
      if (!owner) throw new Error("This conversation has no owner now.");
      const toTeam = (why: string) => {
        const r = fileRequest(orgId, { projectId: p.id, kind: "feature", title: params.title, text: params.text });
        return say(`Filed with the team (${why}). Tell the owner it's with the team; they can follow it under Your requests.`, { request: r.id, started: false });
      };
      // The owner page's question (§app.project-assistant/abilities): on `team`, no chat opens.
      const would = await assistantWouldAct(orgId, p.id, "feature");
      if (would.outcome === "team" && would.reason !== "no-model") return toTeam(would.reason === "power-off" ? "opening a planning chat on its own is off here" : "the team has to start it");
      const out = await startFeatureChat(orgId, { projectId: p.id, owner, title: String(params.title ?? ""), text: String(params.text ?? "") }, { attended });
      if (out.kind === "has-open")
        return say(`Not opened: the owner already has a planning chat open ("${out.title}"). Tell them to finish or end that one first, or offer to send this to the team instead (report_issue, kind feature).`, { started: false });
      if (out.kind === "no-model") return say("Not opened: no model is set for planning chats yet. Offer to send it to the team instead (report_issue, kind feature).", { started: false });
      if (out.kind === "team") return say("Filed with the team: a planning chat couldn't be opened now. Tell the owner it's with the team; they can follow it under Your requests.", { request: out.request.id, started: false });
      return say("The planning chat is open. Tell the owner it's open: they can tap Open Feature Chat under your message, or find it under Waiting on you on their home page.", { request: out.request.id, featureChat: out.sessionId, started: true });
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
  return [...lookups, agree, ...drafts, reportIssue, ownerRequests, startFix, deploy, ownerVersions, startVersion, startFeature];
}

/** The tool names, in loadout order (the allowlist). */
export const ASSISTANT_TOOL_NAMES = ["spec_lookup", "code_read", "requirement_agree", "requirement_drop", "requirements_summary", "requirements_confirm", "report_issue", "owner_requests", "start_fix", "deploy", "owner_versions", "start_version", "start_feature_chat"] as const;

export { setFeatureStartForTest };

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
        // Never on a request the owner closed meanwhile (§app.project-assistant/closing): it stays closed.
        advanceRequest(e.orgId, e.basisId, "started", { sessionId: e.sessionId });
      } catch (err) {
        console.warn(`[project-assistant] marking a fix started failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  )
  .catch(() => {});
