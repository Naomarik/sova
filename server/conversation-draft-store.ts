import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DRAFT_ITEMS_MAX, DRAFT_SUMMARY_MAX, type ConversationDraftRecord, type ConversationKind, type DraftItem } from "../shared/conversation-drafts";
import { catchUpDraft, conversationDraftName, itemOfDecision, nextItemNumber } from "./conversation-draft";
import { specHash } from "./spec-draft-writer";

/**
 * A conversation's draft record (§app.requirements/conversation-drafts "Its record"): one JSON file per
 * conversation in the workspace of the engine that holds its project
 * (`<engine dir>/projects/<pid>/conversation-drafts/<sessionId>.json`; an org's workspace travels with
 * it, a standalone project's is under the state root). The items are the source of truth; the draft
 * folder in the project root is rebuilt from the current spec and them.
 *
 * Where the engine dir and the project root come from is the caller's (`DraftPlace`), so this module
 * reads no org or project registry: the baton and Project Assistant layers give theirs.
 */

/** Where one conversation's record and draft live. */
export interface DraftPlace {
  /** The engine's workspace-layout directory (`projectDir(projectId)`). */
  workspace: string;
  /** The project root (its `.sova/spec`). */
  root: string;
  /** The project's name, for the operator. */
  name?: string;
}

/** Who and what the conversation is (written into a new record; kept fresh on each catch-up). */
export interface ConversationRef {
  sessionId: string;
  projectId: string;
  orgId?: string;
  kind: ConversationKind;
  title?: string;
  person?: { id: string; name: string };
}

const SAFE = /^[A-Za-z0-9_-]{1,80}$/;

export function recordPath(workspace: string, projectId: string, sessionId: string): string {
  if (!SAFE.test(projectId) || !SAFE.test(sessionId)) throw new Error("Unknown conversation.");
  return join(workspace, "projects", projectId, "conversation-drafts", `${sessionId}.json`);
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseRecord(v: unknown): ConversationDraftRecord | null {
  if (!isObj(v) || v.version !== 1 || typeof v.sessionId !== "string" || typeof v.projectId !== "string" || !Array.isArray(v.items)) return null;
  return v as unknown as ConversationDraftRecord;
}

export function readRecord(workspace: string, projectId: string, sessionId: string): ConversationDraftRecord | null {
  try {
    return parseRecord(JSON.parse(readFileSync(recordPath(workspace, projectId, sessionId), "utf8")));
  } catch {
    return null;
  }
}

export function writeRecord(workspace: string, rec: ConversationDraftRecord): void {
  writeAtomic(recordPath(workspace, rec.projectId, rec.sessionId), `${JSON.stringify(rec, null, 2)}\n`);
}

/** Every record of a project, newest update first. */
export function listRecords(workspace: string, projectId: string): ConversationDraftRecord[] {
  const dir = join(workspace, "projects", projectId, "conversation-drafts");
  if (!existsSync(dir)) return [];
  const out: ConversationDraftRecord[] = [];
  for (const n of readdirSync(dir)) {
    if (!n.endsWith(".json")) continue;
    const r = readRecord(workspace, projectId, n.slice(0, -5));
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The record, made (empty, unconfirmed) when the conversation has none. Not written. */
export function recordOf(workspace: string, ref: ConversationRef, now = new Date()): ConversationDraftRecord {
  const have = readRecord(workspace, ref.projectId, ref.sessionId);
  const base: ConversationDraftRecord = have ?? {
    version: 1,
    sessionId: ref.sessionId,
    projectId: ref.projectId,
    kind: ref.kind,
    draft: conversationDraftName(ref.sessionId),
    baseSha: null,
    state: "unconfirmed",
    summaryShownAt: null,
    confirmedAt: null,
    items: [],
    updatedAt: now.toISOString(),
  };
  return {
    ...base,
    ...(ref.orgId ? { orgId: ref.orgId } : {}),
    ...(ref.title ? { title: ref.title } : {}),
    ...(ref.person ? { person: ref.person } : {}),
  };
}

// ---- what the chat's tools do ----------------------------------------------------------------------------

export class DraftRefusal extends Error {}

/** Any change to the agreed items: the person hasn't confirmed what is there now. */
function itemsChanged(rec: ConversationDraftRecord, now: Date): ConversationDraftRecord {
  return { ...rec, state: "unconfirmed", confirmedAt: null, confirmedSummary: null, summaryShownAt: null, updatedAt: now.toISOString() };
}

/** A decision recorded in the conversation, as its new item (record_decision). Returns the record and the item. */
export function addDecisionItem(
  rec: ConversationDraftRecord,
  d: Parameters<typeof itemOfDecision>[1],
  change: { changes?: string; changesHash?: string } = {},
  now = new Date(),
): { rec: ConversationDraftRecord; item: DraftItem } {
  const already = rec.items.find((i) => i.decisionId && i.decisionId === d.id);
  if (already) return { rec, item: already };
  if (rec.items.filter((i) => i.status !== "dropped").length >= DRAFT_ITEMS_MAX) throw new DraftRefusal(`This conversation already holds ${DRAFT_ITEMS_MAX} requirements.`);
  const item = itemOfDecision(`r${nextItemNumber(rec.items)}`, d, change);
  return { rec: { ...itemsChanged(rec, now), items: [...rec.items, item] }, item };
}

/** requirement_drop: the person let it go. Only an agreed item can be dropped (one the operator approved is theirs). */
export function dropItem(rec: ConversationDraftRecord, id: string, now = new Date()): ConversationDraftRecord {
  const it = rec.items.find((i) => i.id === id);
  if (!it || it.status === "dropped") throw new DraftRefusal(`There is no requirement ${id} in this conversation. requirements_summary lists them.`);
  if (it.status !== "agreed") throw new DraftRefusal(`Requirement ${id} was already approved; it can't be dropped from here. Tell the person it's with ${"the team"} now.`);
  return { ...itemsChanged(rec, now), items: rec.items.map((i) => (i.id === id ? { ...i, status: "dropped" as const } : i)) };
}

/** The live items, for the repeat-back. */
export const liveItems = (rec: ConversationDraftRecord): DraftItem[] => rec.items.filter((i) => i.status !== "dropped");

/** requirements_summary's text for the chat (never shown to the person as it stands: the chat says it in their words). */
export function summaryText(rec: ConversationDraftRecord): string {
  const items = liveItems(rec);
  if (!items.length) return "Nothing has been agreed in this conversation yet: there is nothing to confirm.";
  const lines = items.map((i) => `- ${i.id}${i.kind === "change" ? " (changes how something works now)" : ""}${i.clash ? " (check again: what it changes has changed since)" : ""}: ${i.text}`);
  return [
    "What was agreed in this conversation:",
    ...lines,
    "",
    "Repeat this back to the person now, as simply as you can, in their own voice and language: what was agreed and what is going to be built. Never these ids or how it is recorded. Ask them to approve it, change it or let parts go. Call requirements_confirm only after they say yes in a message of their own; record a change with record_decision, and drop what they let go with requirement_drop.",
  ].join("\n");
}

/** requirements_summary: marks when it was shown and the leaf it was shown at. */
export function markSummaryShown(rec: ConversationDraftRecord, leaf: string | null, now = new Date()): ConversationDraftRecord {
  return { ...rec, summaryShownAt: now.toISOString(), summaryLeaf: leaf, updatedAt: now.toISOString() } as ConversationDraftRecord;
}

/**
 * requirements_confirm: only after requirements_summary in this conversation, with nothing agreed or
 * dropped since, and a message of the person's written after it (`personWroteSince`).
 */
export function confirm(rec: ConversationDraftRecord, summary: string, personWroteSince: boolean, now = new Date()): ConversationDraftRecord {
  if (!liveItems(rec).length) throw new DraftRefusal("Nothing has been agreed in this conversation yet: there is nothing to confirm.");
  if (!rec.summaryShownAt) throw new DraftRefusal("Call requirements_summary and repeat everything agreed back to the person first, then wait for their yes.");
  if (!personWroteSince) throw new DraftRefusal("Wait for the person's answer: confirm only after they say yes in a message of their own.");
  const text = summary.trim().slice(0, DRAFT_SUMMARY_MAX);
  if (!text) throw new DraftRefusal("Give the summary the person said yes to.");
  return { ...rec, state: "confirmed", confirmedAt: now.toISOString(), confirmedSummary: text, updatedAt: now.toISOString() };
}

// ---- catching up -----------------------------------------------------------------------------------------

/** What a rebuild is made from: the base spec (the main line's) and the items. Equal: nothing to do. */
export function builtFromOf(baseRoot: string | null, rec: Pick<ConversationDraftRecord, "items">): { spec: string; key: string } {
  const spec = baseRoot === null ? "" : specHash(baseRoot);
  const items = createHash("sha256").update(JSON.stringify(rec.items.map((i) => [i.id, i.status, i.kind, i.text, i.area, i.target, i.basedOnHash, i.recordId]))).digest("hex");
  return { spec, key: `${spec}:${items}` };
}

const draftThere = (root: string, name: string): boolean => existsSync(join(root, ".sova", "spec", "drafts", name, "draft.json"));

/**
 * Bring the record's draft onto the current spec (idempotent: nothing is run when neither the spec,
 * nor the items changed since the last rebuild and the draft is still there; nothing at all, and
 * nothing written, while the conversation has agreed nothing). Returns the record as written (record
 * ids and clashes updated).
 */
export async function catchUpRecord(place: DraftPlace, rec: ConversationDraftRecord, now = new Date(), baseRoot: string | null = place.root): Promise<ConversationDraftRecord> {
  // No requirement yet, and no draft: nothing to build (the draft is made at the first requirement).
  if (!rec.items.length && !draftThere(place.root, rec.draft)) return rec;
  const before = builtFromOf(baseRoot, rec);
  if (rec.builtFrom === before.key && draftThere(place.root, rec.draft)) return rec;
  const out = await catchUpDraft(place.root, rec.sessionId, rec.items, baseRoot);
  const next: ConversationDraftRecord = { ...rec, draft: out.draft, items: out.items };
  // The ids it assigned are part of the items: the key is taken after them, so the next unchanged catch-up is a no-op.
  const after = builtFromOf(baseRoot, next);
  const written = { ...next, baseSha: after.spec, builtFrom: after.key, updatedAt: rec.builtFrom === after.key ? rec.updatedAt : now.toISOString() };
  writeRecord(place.workspace, written);
  return written;
}
