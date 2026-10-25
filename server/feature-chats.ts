import { OPERATOR, type BatonSession } from "../shared/baton";
import { isRequestClosed, type FeatureChatRecord, type OwnerRequest } from "../shared/project-assistant";
import type { ModelPick } from "../shared/powers";
import { allBatons, batonById, closeBaton, createBaton, noteMessage, sessionPathOf, undoNote } from "./baton";
import { acquireChatHandle } from "./chat-handle";
import { handleOf } from "./person-links";
import { refreshShare } from "./share/hub";
import { envelopeFor } from "./org-engine";
import { OrgError, ownerOf, readRoster } from "./orgs";
import { addFeatureChat, advanceRequest, effectiveAssistantModel, endFeatureChatRecord, featureChatRecord, featureChats, fileRequest, findRequest, setRequestStatus } from "./project-assistant-store";
import { projectOverseerPaths, readPoSettings } from "./project-overseer-store";

/**
 * Feature request chats (§app.project-assistant/feature-chats): a gathering conversation the Project Assistant
 * opens with the organization's owner to plan something new. It is an ordinary baton session of its project
 * (server/baton.ts), told apart by its record in the workspace's `project-assistant.json` (`featureChats`), which
 * names the owner who opened it. Everything that treats one differently asks here: its loadout and prompt
 * (server/baton-loadout.ts), the plan card on the owner page (server/baton-view.ts, server/owner-page.ts), the
 * owner's own message route (server/share/routes.ts), the strip (no Hide From) and Needs you.
 *
 * It only plans: no tool it has writes, edits or runs anything, and nothing it agrees is built on its own.
 */

/** The gathering tools a feature request chat never has (§app.project-assistant/feature-chats). */
export const FEATURE_CHAT_TOOLS_OFF: readonly string[] = ["propose_roster_edit", "read_link", "inspect_files", "confirm_file"];

const firstOf = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** The record of a feature request chat, by its session id; null for any other conversation. Never throws. */
export function featureChatOf(orgId: string, sessionId: string): FeatureChatRecord | null {
  try {
    return featureChatRecord(orgId, sessionId);
  } catch {
    return null;
  }
}

/** Whether a baton row is a feature request chat. */
export const isFeatureChat = (row: Pick<BatonSession, "orgId" | "sessionId">): boolean => !!featureChatOf(row.orgId, row.sessionId);

/** A baton session id's feature chat record, wherever it lives; null when it is no feature request chat. */
export function featureChatOfSession(sessionId: string): { rec: FeatureChatRecord; row: BatonSession } | null {
  const hit = batonById(sessionId);
  if (!hit) return null;
  const rec = featureChatOf(hit.row.orgId, sessionId);
  return rec ? { rec, row: hit.row } : null;
}

const isOpen = (row: Pick<BatonSession, "state">) => row.state === "open" || row.state === "needs-you";

/** The open feature request chats of one person in an org (one at most, but read them all). */
export function openFeatureChatsOf(orgId: string, personId: string): { rec: FeatureChatRecord; row: BatonSession }[] {
  const out: { rec: FeatureChatRecord; row: BatonSession }[] = [];
  for (const rec of featureChats(orgId)) {
    if (rec.personId !== personId || rec.ended) continue;
    const row = batonById(rec.sessionId)?.row;
    if (row && row.orgId === orgId && isOpen(row)) out.push({ rec, row });
  }
  return out;
}

/** The chat is this person's to read and write on their owner page: they opened it, and they are the owner now. */
export function ownersFeatureChat(orgId: string, sessionId: string, personId: string): boolean {
  const rec = featureChatOf(orgId, sessionId);
  return !!rec && rec.personId === personId && ownerOf(orgId)?.id === personId;
}

/**
 * Whether a baton session is shown on the owner page of `ownerId` (the current owner): every conversation but a
 * feature request chat someone else opened.
 */
export const shownToOwner = (row: Pick<BatonSession, "orgId" | "sessionId">, ownerId: string): boolean => {
  const rec = featureChatOf(row.orgId, row.sessionId);
  return !rec || rec.personId === ownerId;
};

/** Why only the owner can agree the plan now, or null (§app.project-assistant/feature-chats). */
export function featureHolderRefusal(sessionId: string): string | null {
  const hit = featureChatOfSession(sessionId);
  if (!hit) return null;
  if (hit.row.holder === hit.rec.personId) return null;
  const p = readRoster(hit.row.orgId).find((x) => x.id === hit.rec.personId);
  return `Only ${p ? firstOf(p.name) : "the person who asked for this"}, who asked for this, can agree the plan: hand it back to them first.`;
}

/** Why it can't be hidden from the owner, or null for any other conversation. */
export function hideRefusal(sessionId: string): string | null {
  const hit = featureChatOfSession(sessionId);
  if (!hit) return null;
  const p = readRoster(hit.row.orgId).find((x) => x.id === hit.rec.personId);
  return `A feature request chat is ${p ? firstOf(p.name) : "the owner"}'s own: it can't be hidden from them.`;
}

// ---- starting one ----------------------------------------------------------------------------------------------

export type FeatureStart =
  | { kind: "opened"; request: OwnerRequest; sessionId: string }
  | { kind: "has-open"; title: string }
  | { kind: "no-model" }
  | { kind: "team"; request: OwnerRequest; why: string };

/** What starts the gathering (tests stand one in). */
export type StartGathering = typeof createBaton;
let startForTest: StartGathering | null = null;
export function setFeatureStartForTest(f: StartGathering | null): void {
  startForTest = f;
}

/** Starts in flight, per org and person: the one-chat check and the record are not atomic with the start. */
const starting = new Set<string>();

/** The gathering model a feature chat of this project runs on: the project's override, else the org's, else the
    host's default (the one resolution, §app.project-assistant/models). */
export function featureModelOf(orgId: string, projectId: string): ModelPick | null {
  let models = null;
  try {
    models = readPoSettings(projectOverseerPaths(projectId)).powers?.assistantModels ?? null;
  } catch {
    models = null;
  }
  return effectiveAssistantModel(orgId, "gathering", models)?.pick ?? null;
}

/**
 * Open a feature request chat for the owner (start_feature_chat, after the would-act question said `now`): the
 * one-chat and model checks first (nothing filed), then the `feature` request, then the gathering, started
 * in-process as the caller `assistant` with no link (the owner uses their page) and no hold. A start the engine
 * refuses leaves the request with the team.
 */
export async function startFeatureChat(
  orgId: string,
  input: { projectId: string; owner: { id: string; name: string }; title: string; text: string },
  o: { attended: boolean },
): Promise<FeatureStart> {
  const key = `${orgId}/${input.owner.id}`;
  const open = openFeatureChatsOf(orgId, input.owner.id);
  if (open.length || starting.has(key)) return { kind: "has-open", title: open[0]?.row.publicTitle ?? input.title };
  const model = featureModelOf(orgId, input.projectId);
  if (!model) return { kind: "no-model" };
  starting.add(key);
  try {
    const request = fileRequest(orgId, { projectId: input.projectId, kind: "feature", title: input.title, text: input.text });
    const first = firstOf(input.owner.name);
    const envelope = { ...envelopeFor(orgId, input.projectId, { by: "assistant", attended: o.attended }), holdMs: 0 };
    let made;
    try {
      made = await (startForTest ?? createBaton)(
        {
          orgId,
          projectId: input.projectId,
          to: input.owner.id,
          publicTitle: request.title,
          goal: `Plan with ${first} what they want, and agree it with them on plan cards: ${request.text}`,
          question: `Let's plan it together: ${request.title}`,
          briefing: request.text,
          model: model.model,
          ...(model.thinking ? { thinking: model.thinking } : {}),
          abilities: { draw: true, drawHtml: true, readLinks: false },
        },
        { envelope, mintLink: false, startedByAssistant: true, why: `${first} asked the Project Assistant for something new: ${request.title}` },
      );
    } catch (err) {
      return { kind: "team", request, why: err instanceof Error ? err.message : String(err) };
    }
    if (!made.sessionId || made.held || made.planned || !made.path) return { kind: "team", request, why: "the start was held" };
    addFeatureChat(orgId, { sessionId: made.sessionId, personId: input.owner.id, projectId: input.projectId, requestId: request.id, at: new Date().toISOString() });
    // The owner closed the request while the chat was starting (§app.project-assistant/closing, q9): the new chat ends
    // with it, kept as history, and no status line is written over the close.
    if (isRequestClosed(findRequest(orgId, request.id)?.status ?? "with-team")) {
      const row = batonById(made.sessionId)?.row;
      await (closeForTest ?? closeBaton)(made.sessionId, { envelope: envelopeFor(orgId, row?.projectId ?? input.projectId, { by: "system", attended: false }), reason: "The owner closed the request." }).catch((err: unknown) =>
        console.warn(`[feature-chats] ending ${made.sessionId} after its request closed: ${err instanceof Error ? err.message : String(err)}`),
      );
      return { kind: "team", request, why: "the owner closed the request while its chat was starting" };
    }
    // The request's chat (the Requests tab's Open Chat): a status line naming it, its status unchanged; never on a closed one.
    advanceRequest(orgId, request.id, "with-team", { sessionId: made.sessionId });
    return { kind: "opened", request, sessionId: made.sessionId };
  } finally {
    starting.delete(key);
  }
}

// ---- ending ----------------------------------------------------------------------------------------------------

/** What closes a chat that ended (tests stand one in that fails). */
let closeForTest: typeof closeBaton | null = null;
export function setFeatureCloseForTest(f: typeof closeBaton | null): void {
  closeForTest = f;
}

/** Why a chat's person no longer owns it: they left the roster, or someone else is the owner. */
function whyNotOwner(orgId: string, personId: string): "owner-changed" | "left" {
  try {
    const p = readRoster(orgId).find((x) => x.id === personId);
    return !p || p.status === "left" ? "left" : "owner-changed";
  } catch {
    return "owner-changed";
  }
}

/**
 * The first half of ending a former owner's chats, synchronous and idempotent: every open feature request chat
 * whose person is not the owner now gets its `ended` record (so Needs you tells the operator whatever the close
 * does). Returns every chat whose record says ended while its conversation is still open: those still to close.
 */
export function recordFormerOwnersChats(orgId: string, why?: "owner-changed" | "left"): string[] {
  const chats = featureChats(orgId);
  if (!chats.length) return [];
  const now = ownerOf(orgId)?.id ?? null;
  const toClose: string[] = [];
  for (const rec of chats) {
    const row = batonById(rec.sessionId)?.row;
    if (!row || row.orgId !== orgId || !isOpen(row)) continue;
    if (!rec.ended) {
      if (rec.personId === now) continue;
      endFeatureChatRecord(orgId, rec.sessionId, why ?? whyNotOwner(orgId, rec.personId));
    }
    toClose.push(rec.sessionId);
  }
  return toClose;
}

/** Closes in flight, so the sweeps that overlap (the owner change, startup, Needs you) close each chat once. */
const closing = new Set<string>();

/**
 * The owner changed or left: every open feature request chat of anyone who is not the owner now is recorded as
 * ended (Needs you tells the operator), then closed. A close that fails stays recorded and is tried again by the
 * next sweep: at the owner change, at each org's start, and on every Needs you scan. Returns how many closed.
 */
export async function endFormerOwnersChats(orgId: string, why?: "owner-changed" | "left"): Promise<number> {
  let n = 0;
  for (const sid of recordFormerOwnersChats(orgId, why)) {
    if (closing.has(sid)) continue;
    closing.add(sid);
    try {
      const row = batonById(sid)?.row;
      if (!row || !isOpen(row)) continue;
      await (closeForTest ?? closeBaton)(sid, { envelope: envelopeFor(orgId, row.projectId, { by: "system", attended: false }), reason: "The owner changed." });
      n++;
    } catch (err) {
      console.warn(`[feature-chat] closing ${sid.slice(0, 8)} after the owner changed (tried again on the next sweep): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      closing.delete(sid);
    }
  }
  return n;
}

/** The Needs you scan's sweep: records what ended now, and closes in the background. Never throws. */
export function convergeFeatureChats(orgId: string): void {
  try {
    if (!recordFormerOwnersChats(orgId).some((sid) => !closing.has(sid))) return;
  } catch {
    return;
  }
  void endFormerOwnersChats(orgId).catch((err) => console.warn(`[feature-chat] ${orgId}: ending the former owner's chats: ${err instanceof Error ? err.message : String(err)}`));
}

/** The owner's End Chat (§app.project-assistant/feature-chats): closed, as the operator's Close would. */
export async function ownerEndsFeatureChat(orgId: string, sessionId: string): Promise<void> {
  const row = batonById(sessionId)?.row;
  if (!row || row.orgId !== orgId) throw new OrgError("Not found", 404);
  if (!isOpen(row)) throw new OrgError("This chat has ended.", 409, "closed");
  await closeBaton(sessionId, { envelope: envelopeFor(orgId, row.projectId, { by: "system", attended: false }), reason: "The owner ended it." });
}

/** The owner closed the chat's `feature` request (§app.project-assistant/closing): an open chat ends with it, kept
    readable as history, and their one open chat is free again. A chat already ended or gone is left as it is. */
export async function closeFeatureChatForRequest(orgId: string, sessionId: string): Promise<void> {
  const row = batonById(sessionId)?.row;
  if (!row || row.orgId !== orgId || !isOpen(row)) return;
  await (closeForTest ?? closeBaton)(sessionId, { envelope: envelopeFor(orgId, row.projectId, { by: "system", attended: false }), reason: "The owner closed the request." });
}

// ---- the owner's page writes to it ------------------------------------------------------------------------------

/** The owner's own feature request chat by its page handle (k_…): only a chat this person opened while they are the
    owner; anything else is a 404, the same as a handle that never existed. */
export function ownersChatByHandle(orgId: string, personId: string, handle: string): BatonSession {
  if (ownerOf(orgId)?.id !== personId) throw new OrgError("Not found", 404, "missing");
  for (const rec of featureChats(orgId)) {
    if (rec.personId !== personId || handleOf("k", rec.sessionId) !== handle) continue;
    const row = batonById(rec.sessionId)?.row;
    if (row && row.orgId === orgId) return row;
  }
  throw new OrgError("Not found", 404, "missing");
}

/** The longest message the page takes (a hand-off page's, §app.baton/share-listener). */
export const FEATURE_TEXT_MAX = 4000;

/**
 * A message from the owner's page into their feature request chat: counted as that person's message (their person
 * id, never operator identity), under the baton's own lock and budget. Refusals are OrgErrors with a code the
 * route answers: `not-holder`, `budget`, `closed` (409), `busy` (503), `missing` (404).
 */
export async function sendOwnerFeatureMessage(orgId: string, personId: string, handle: string, raw: unknown): Promise<void> {
  const row = ownersChatByHandle(orgId, personId, handle);
  const text = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
  if (!text) throw new OrgError("Write something first.", 400, "bad-request");
  if (text.length > FEATURE_TEXT_MAX) throw new OrgError(`Messages are limited to ${FEATURE_TEXT_MAX} characters.`, 400, "too-long");
  if (text.startsWith("/")) throw new OrgError("Messages can't start with /.", 400, "bad-request");
  if (!isOpen(row)) throw new OrgError("This chat has ended.", 409, "closed");
  if (row.budget.messagesUsed >= row.budget.messagesMax) throw new OrgError("This chat has reached its message limit. The team has been told.", 409, "budget");
  if (row.holder !== personId) throw new OrgError("Someone else has this chat right now. You can read along.", 409, "not-holder");
  let chat;
  try {
    chat = await acquireChatHandle(sessionPathOf(orgDirOf(row), row));
    await chat.assertModelAllowed();
  } catch (err) {
    throw new OrgError(`The chat can't take a message right now. Try again in a moment. (${err instanceof Error ? err.message : String(err)})`, 409, "busy");
  }
  // One synchronous stretch from the lock to the hand-over, as the hand-off page's route does.
  noteMessage(row.sessionId, personId);
  try {
    await chat.send({ text, origin: "server", sentByBaton: { by: personId } });
  } catch (err) {
    undoNote(row.sessionId);
    throw new OrgError(`The chat can't take a message right now. Try again in a moment. (${err instanceof Error ? err.message : String(err)})`, 409, "busy");
  }
  refreshShare(row.sessionId);
}

const orgDirOf = (row: BatonSession): string => batonById(row.sessionId)!.dir;

/** Every feature request chat row of an org (tests, Needs you). */
export const featureChatRows = (orgId: string): BatonSession[] => allBatons().filter((r) => r.orgId === orgId && !!featureChatOf(orgId, r.sessionId));

// ---- what its model is told ------------------------------------------------------------------------------------

/**
 * The prompt's planning section (§app.project-assistant/feature-chats): the Project manager writing style of
 * §chat.alignment/style and the visuals paragraph of §chat.alignment/visuals, written for this chat; nothing of the
 * operator's own align settings is read.
 */
export const FEATURE_CHAT_PROMPT = `# Planning something new

This conversation plans something new for the project with the person who asked for it. You are their planning partner: you find out what they need, agree a plan with them, and draw it. You never build anything, and you can't: nothing you do changes the project, its files or what has been agreed for it. Never promise that or when anything will be built: once the plan is agreed, the team decides.

How to plan:
- Look up how the project works today (spec_lookup, code_read) before you suggest a change, and say what you found in plain words.
- Ask what they need, one or two things at a time. Keep one plan per need with the \`align\` tool: what we found, the plan in steps, what was ruled out and why, and the open questions, each with 2 or 3 options and the one you recommend. Update the plan as they answer (decide, accept), never by rewriting what they said.
- Their answers arrive as ordinary messages ("My answers: q1 b — …", "Go with your recommendations on the open questions."): record them on the plan, then go on.
- Write every field they read in the Project manager style: only screens, controls, wording, states and flows, never file paths, function or component names, APIs or code; questions a project manager can answer; and a technical choice with an effect a person would notice (speed, cost, data kept or lost, limits, something hard to undo) is asked as a product question. Never leave a decision out because it is technical. Plans here have no technical notes.
- Where a picture helps, put it in the plan's \`visual\` fields (a wireframe for a screen, a flow or steps for a change in behaviour, a clickable prototype as \`html\` for a new screen to try), never as a vis fence in a plan's text. At most 3 per plan; never the code, tree or layers kinds.
- When the plan is complete, note each agreed requirement (record_decision), repeat the whole plan back in their words (requirements_summary), and only after their clear yes confirm it (requirements_confirm) and finish (goal_done). Only the person who asked can agree the plan: if someone else holds the conversation, hand it back to them first.`;

/** The owner's first name for a feature chat's strip line, or null for any other conversation. */
export function featureChatOwnerFirst(sessionId: string): string | null {
  const hit = featureChatOfSession(sessionId);
  if (!hit) return null;
  const p = readRoster(hit.row.orgId).find((x) => x.id === hit.rec.personId);
  return p ? firstOf(p.name) : "the owner";
}

export { OPERATOR };
