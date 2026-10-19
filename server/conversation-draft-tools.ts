import type { ToolSpec } from "../shared/harness";
import type { ConversationDraftRecord } from "../shared/conversation-drafts";
import { batonById, nameOf } from "./baton";
import { readDecisionStore } from "./decisions";
import { itemsOfDecisions } from "./conversation-draft";
import {
  addDecisionItem,
  catchUpRecord,
  confirm,
  DraftRefusal,
  dropItem,
  listRecords,
  markSummaryShown,
  readRecord,
  recordOf,
  summaryText,
  writeRecord,
  type ConversationRef,
  type DraftPlace,
} from "./conversation-draft-store";
import { targetHash } from "./conversation-draft";
import { projectDir, readProject } from "./projects/spaces";
import { OPERATOR, POOL } from "../shared/baton";

/**
 * The conversation-draft tools and hooks (§app.requirements/conversation-drafts, /lock-in): what a
 * gathering, settle or Project Assistant conversation writes into its own spec draft, and the
 * catch-up before each of its replies. Served tools (ToolSpec), bound to one session; the baton
 * loadout and the Project Assistant's loadout add them.
 */

// ---- where -------------------------------------------------------------------------------------------------

let placeForTest: ((projectId: string) => DraftPlace) | null = null;
/** Tests: where a project's records and draft live (null: the project registry again). */
export function setDraftPlaceForTest(f: ((projectId: string) => DraftPlace) | null): void {
  placeForTest = f;
}

/** A project's record workspace (the engine that holds it) and root. */
export function placeOf(projectId: string): DraftPlace {
  if (placeForTest) return placeForTest(projectId);
  const p = readProject(projectId);
  return { workspace: projectDir(projectId), root: p.root, name: p.name };
}

type BaseOf = (projectId: string, root: string) => Promise<string | null>;
let baseForTest: BaseOf | null = null;
/** Tests: the tool root holding a project's main-line spec (null: spec-lookup's mainLineOf). */
export function setDraftBaseForTest(f: BaseOf | null): void {
  baseForTest = f;
}

/**
 * The tool root holding the project's main-line spec (§app.requirements/conversation-drafts): the
 * committed spec of its recorded target branch, else master, else main (spec-lookup's copy in the
 * state root), never the branch the root has checked out; the root itself when it isn't in Git;
 * null when the main line has no spec.
 */
export async function draftBaseOf(projectId: string, root: string): Promise<string | null> {
  if (baseForTest) return baseForTest(projectId, root);
  const lookup = "./spec-lookup";
  const { mainLineOf } = (await import(lookup)) as { mainLineOf: (pid: string, root: string) => Promise<{ specRoot: string | null }> };
  return (await mainLineOf(projectId, root)).specRoot;
}

type BranchOf = (root: string) => Promise<{ inGit: false } | { inGit: true; checkedOut: string | null; main: string | null }>;
let branchForTest: BranchOf | null = null;
/** Tests: the root's checked-out branch and main line (null: git and spec-lookup's mainLineCommit). */
export function setApproveBranchForTest(f: BranchOf | null): void {
  branchForTest = f;
}

async function branchesOf(root: string): ReturnType<BranchOf> {
  if (branchForTest) return branchForTest(root);
  const { execFile } = await import("node:child_process");
  const git = (args: string[]) =>
    new Promise<{ code: number; out: string }>((done) =>
      execFile("git", ["-C", root, ...args], { timeout: 10_000 }, (err, stdout) => done({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0, out: String(stdout).trim() })),
    );
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.out) return { inGit: false };
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const lookup = "./spec-lookup";
  const { mainLineCommit } = (await import(lookup)) as { mainLineCommit: (root: string) => Promise<{ branch: string } | null> };
  const main = await mainLineCommit(root);
  return { inGit: true, checkedOut: head.code === 0 && head.out ? head.out : null, main: main?.branch ?? null };
}

/**
 * Approve writes into the root's own spec, which is the checked-out branch's: it is refused (409)
 * unless that branch is the main line the draft was built on (§app.requirements/draft-approval).
 * Null: it may go ahead (on the main line, or the root isn't in Git).
 */
export async function approveBranchRefusal(root: string): Promise<string | null> {
  const b = await branchesOf(root);
  if (!b.inGit) return null;
  if (!b.main) return "The project folder's repository has no master or main branch, so there is no main line to approve into.";
  if (b.checkedOut === b.main) return null;
  return `The project folder is on ${b.checkedOut ?? "a detached HEAD"}; approving writes into ${b.main}'s spec. Switch it to ${b.main} first.`;
}

/** A gathering or settle session as a conversation (null: not a registered baton session). */
export function batonConversation(sessionId: string): ConversationRef | null {
  const hit = batonById(sessionId);
  if (!hit) return null;
  const row = hit.row;
  const holder = row.holder && row.holder !== OPERATOR && row.holder !== POOL ? row.holder : null;
  return {
    sessionId,
    projectId: row.projectId,
    orgId: row.orgId,
    kind: row.conflict ? "settle" : "gathering",
    title: row.publicTitle,
    ...(holder ? { person: { id: holder, name: nameOf(row.orgId, holder) } } : {}),
  };
}

// ---- one write at a time per record --------------------------------------------------------------------------

const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, f: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(f, f);
  queues.set(
    key,
    next.catch(() => {}),
  );
  return next;
}
const keyOf = (ref: Pick<ConversationRef, "projectId" | "sessionId">) => `${ref.projectId}/${ref.sessionId}`;

/** Read, change and write one conversation's record, in its queue. A person seen since keeps the record's person fresh. */
function update<T>(ref: ConversationRef, f: (rec: ConversationDraftRecord, place: DraftPlace) => Promise<{ rec: ConversationDraftRecord; out: T }> | { rec: ConversationDraftRecord; out: T }): Promise<T> {
  return serial(keyOf(ref), async () => {
    const place = placeOf(ref.projectId);
    const rec = recordOf(place.workspace, ref);
    const { rec: next, out } = await f(rec, place);
    if (next !== rec || !readRecord(place.workspace, ref.projectId, ref.sessionId)) writeRecord(place.workspace, next);
    return out;
  });
}

// ---- agreeing (record_decision) ------------------------------------------------------------------------------

/** What a recorded decision brings to its conversation's draft. */
export interface AgreedDecision {
  /** `<sessionId>:<markerId>`. */
  decisionId: string;
  area: string;
  areaKey: string;
  statement: string;
  quote: string;
  by: string;
  name: string;
  at: string;
  entryId: string;
}

/** The § id and its prose hash on the main line, for a change: `target` is already resolved (spec-lookup's resolveRef). */
export async function changeOf(projectId: string, target: string | null | undefined): Promise<{ changes?: string; changesHash?: string }> {
  if (!target) return {};
  const h = targetHash(await draftBaseOf(projectId, placeOf(projectId).root), target);
  if (h === null) throw new DraftRefusal("That part of the project's description wasn't found. Look it up again and use the reference it gives.");
  return { changes: target, changesHash: h };
}

/**
 * record_decision's second half: the decision becomes an item of its conversation's draft record
 * (new, or a change to `change.changes`). The draft folder follows at the next catch-up. Returns the item's id.
 */
export function agreeRequirement(ref: ConversationRef, d: AgreedDecision, change: { changes?: string; changesHash?: string } = {}, now = new Date()): Promise<{ itemId: string }> {
  return update(ref, (rec) => {
    const { rec: next, item } = addDecisionItem(rec, { id: d.decisionId, area: d.area, areaKey: d.areaKey, statement: d.statement, quote: d.quote, by: d.by, name: d.name, at: d.at, entryId: d.entryId }, change, now);
    return { rec: next, out: { itemId: item.id } };
  });
}

type ResolveRef = (sessionId: string, ref: string) => { projectId: string; id: string } | null;
let resolveForTest: ResolveRef | null = null;
/** Tests: how a spec look-up reference resolves (null: spec-lookup's resolveRef). */
export function setResolveRefForTest(f: ResolveRef | null): void {
  resolveForTest = f;
}

/**
 * record_decision's `changes` (a spec look-up reference this conversation was given): the § id it names
 * and that record's prose hash now, for the decision entry. Undefined/empty: a new requirement. An unknown
 * reference, or one of another project, is refused (an Error, the tool's answer).
 */
export async function changeOfRef(sessionId: string, projectId: string, ref: unknown): Promise<{ changes?: string; changesHash?: string }> {
  if (ref === undefined || ref === null || ref === "") return {};
  if (typeof ref !== "string") throw new Error("changes is the reference spec_lookup gave for the part it changes.");
  // spec-lookup's (server/spec-lookup.ts), loaded when first needed: it lands beside this module.
  const lookup = "./spec-lookup";
  const resolve: ResolveRef = resolveForTest ?? ((await import(lookup)) as { resolveRef: ResolveRef }).resolveRef;
  const hit = resolve(sessionId, ref.trim());
  if (!hit || hit.projectId !== projectId) throw new Error(`"${ref}" is not a reference spec_lookup gave in this conversation. Look the part up, then use the reference it shows.`);
  try {
    return await changeOf(projectId, hit.id);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

/**
 * After record_decision wrote its entry (with `changes`/`changesHash` when given) and recorded the
 * decision: it becomes an item of the conversation's draft. Returns the words to add to the tool's
 * answer ("Requirement r3."), or "" when the session isn't a conversation with a draft. Never throws:
 * the decision is recorded either way, and a later catch-up seeds what this missed.
 */
export async function noteRecordedDecision(sessionId: string, d: AgreedDecision, change: { changes?: string; changesHash?: string } = {}): Promise<string> {
  const ref = batonConversation(sessionId);
  if (!ref) return "";
  try {
    const { itemId } = await agreeRequirement(ref, d, change);
    return `Requirement ${itemId}.`;
  } catch (err) {
    console.warn(`[conversation-draft] item for ${d.decisionId}: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

export const GOAL_DONE_UNCONFIRMED = "Repeat back what's agreed and get a clear yes first: call requirements_summary, say it back in their words, and call requirements_confirm once they say yes. Drop what they let go with requirement_drop.";

/**
 * goal_done's guard (§app.requirements/lock-in): a gathering or settle session whose record holds
 * agreed requirements not confirmed by the person can't end on the model's word. Null: it may.
 */
export function goalDoneRefusal(sessionId: string): string | null {
  const ref = batonConversation(sessionId);
  if (!ref) return null;
  let rec: ConversationDraftRecord | null;
  try {
    rec = readRecord(placeOf(ref.projectId).workspace, ref.projectId, sessionId);
  } catch {
    return null;
  }
  return goalDoneRefusalOf(rec);
}

/** The guard on one record: agreed items the person hasn't confirmed. */
export function goalDoneRefusalOf(rec: Pick<ConversationDraftRecord, "state" | "items"> | null): string | null {
  if (!rec || rec.state === "confirmed") return null;
  return rec.items.some((i) => i.status === "agreed") ? GOAL_DONE_UNCONFIRMED : null;
}

// ---- catching up -----------------------------------------------------------------------------------------------

/** The prompt's lines for clashing items: check them with the person again, in plain words. */
function clashNotes(rec: ConversationDraftRecord): string[] {
  return rec.items
    .filter((i) => i.status === "agreed" && i.clash)
    .map((i) => `What "${i.title}" would change has changed in the project since you agreed it: check that requirement with the person again, in plain words, and record what they say now.`);
}

/** The decisions a baton session recorded that its record doesn't hold yet (rollout; a crash between entry and item). */
function seedFromDecisions(ref: ConversationRef, rec: ConversationDraftRecord): ConversationDraftRecord {
  if (!ref.orgId) return rec;
  const rows = readDecisionStore(ref.orgId, ref.projectId).decisions;
  const add = itemsOfDecisions(rows, ref.sessionId, rec.items);
  if (!add.length) return rec.seeded ? rec : { ...rec, seeded: true };
  return { ...rec, seeded: true, state: "unconfirmed", confirmedAt: null, summaryShownAt: null, items: [...rec.items, ...add] };
}

/**
 * Before each reply of a gathering, settle or Project Assistant conversation (spec-lookup calls it from
 * the baton's runStart; the Project Assistant from its own): its draft brought onto the current spec,
 * for `projectId` or every project the session has a record for. A baton session's recorded decisions
 * seed its record (once per decision). Cheap when nothing changed. Null: not a conversation with a draft.
 * Never throws: a failure is logged and the reply goes on.
 */
export async function catchUpConversationDraft(sessionId: string, projectId?: string, ref?: ConversationRef): Promise<{ notes: string[] } | null> {
  const r = ref ?? batonConversation(sessionId);
  const projects = projectId ? [projectId] : r ? [r.projectId] : [];
  if (!projects.length) return null;
  const notes: string[] = [];
  for (const pid of projects) {
    const one: ConversationRef = r && r.projectId === pid ? r : { sessionId, projectId: pid, kind: "assistant" };
    try {
      const rec = await serial(keyOf(one), async () => {
        const place = placeOf(pid);
        const base = recordOf(place.workspace, one);
        const seeded = one.kind === "assistant" ? base : seedFromDecisions(one, base);
        return catchUpRecord(place, seeded, new Date(), await draftBaseOf(pid, place.root));
      });
      notes.push(...clashNotes(rec));
    } catch (err) {
      console.warn(`[conversation-draft] catch-up ${sessionId.slice(0, 8)}/${pid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { notes };
}

/** Every project a session has a record in, among `projectIds`. */
export function projectsWithRecord(sessionId: string, projectIds: readonly string[]): string[] {
  return projectIds.filter((pid) => {
    try {
      return !!readRecord(placeOf(pid).workspace, pid, sessionId);
    } catch {
      return false;
    }
  });
}

// ---- the tools ---------------------------------------------------------------------------------------------------

export const DRAFT_TOOLS = ["requirement_drop", "requirements_summary", "requirements_confirm"] as const;

/** What the tools need of their session. */
export interface DraftToolCtx {
  sessionId: string;
  /** The conversation as it is now, for one of its projects (the baton's own; the assistant's per project). */
  conversation(projectId?: string): ConversationRef | null;
  /** The projects a `project` argument may name (more than one: it is required). */
  projects(): { projectId: string; name?: string }[];
}

const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });

function pick(ctx: DraftToolCtx, project: unknown): ConversationRef {
  const ps = ctx.projects();
  let pid: string | undefined;
  if (typeof project === "string" && project.trim()) {
    const want = project.trim().toLowerCase();
    pid = ps.find((p) => p.projectId.toLowerCase() === want || p.name?.toLowerCase() === want)?.projectId;
    if (!pid) throw new DraftRefusal(`"${project}" is not one of this conversation's projects. Use one of: ${ps.map((p) => p.name ?? p.projectId).join(", ")}.`);
  } else if (ps.length > 1) throw new DraftRefusal(`Say which project: one of ${ps.map((p) => p.name ?? p.projectId).join(", ")}.`);
  const ref = ctx.conversation(pid ?? ps[0]?.projectId);
  if (!ref) throw new DraftRefusal("This conversation is no longer registered.");
  return ref;
}

/** Whether a user message follows the entry `leaf` on the branch (no leaf: none can be shown to follow it). */
export function personWroteAfter(branch: readonly { id?: string | null; kind: string }[], leaf: string | null | undefined): boolean {
  if (!leaf) return false;
  const i = branch.findIndex((e) => e.id === leaf);
  if (i < 0) return false;
  return branch.slice(i + 1).some((e) => e.kind === "user");
}

/** Run a tool body; a refusal is the tool's error, in its words. */
async function refusing<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof DraftRefusal) throw new Error(err.message);
    throw err;
  }
}

export function conversationDraftTools(ctx: DraftToolCtx): ToolSpec[] {
  const projectParam = () => (ctx.projects().length > 1 ? { project: str("Which project (its name).") } : {});
  return [
    {
      name: "requirement_drop",
      label: "Drop requirement",
      description: "The person let an agreed requirement go: drop it by its id (requirements_summary lists them). It is no longer part of what will be built.",
      parameters: obj({ id: str('The requirement\'s id ("r3").'), ...projectParam() }, ["id"]) as any,
      async execute(_id, params: any) {
        return refusing(async () => {
          const ref = pick(ctx, params?.project);
          const id = typeof params?.id === "string" ? params.id.trim() : "";
          await update(ref, (rec) => ({ rec: dropItem(rec, id), out: null }));
          return say(`Dropped ${id}. Repeat back what is still agreed before asking the person to confirm.`);
        });
      },
    },
    {
      name: "requirements_summary",
      label: "Requirements summary",
      description:
        "Everything agreed in this conversation, for the repeat-back at its end. Call it, then say it back to the person as simply as you can, in their own voice and language, and ask them to approve it, change it or let parts go.",
      parameters: obj({ ...projectParam() }, []) as any,
      async execute(_id, params: any, _signal, _update, tctx) {
        return refusing(async () => {
          const ref = pick(ctx, params?.project);
          const text = await update(ref, (rec) => {
            const leaf = tctx?.leafId() ?? null;
            const next = rec.items.some((i) => i.status !== "dropped") ? markSummaryShown(rec, leaf) : rec;
            return { rec: next, out: summaryText(next) };
          });
          return say(text);
        });
      },
    },
    {
      name: "requirements_confirm",
      label: "Confirm requirements",
      description:
        "The person said yes, in a message of their own, to the summary you repeated back after requirements_summary. Give that summary as you said it. Never call it without their explicit yes: until then nothing is locked in and the conversation stays open.",
      parameters: obj({ summary: str("The summary the person said yes to, as you said it."), ...projectParam() }, ["summary"]) as any,
      async execute(_id, params: any, _signal, _update, tctx) {
        return refusing(async () => {
          const ref = pick(ctx, params?.project);
          const branch = tctx?.branch() ?? [];
          await update(ref, (rec) => ({ rec: confirm(rec, typeof params?.summary === "string" ? params.summary : "", personWroteAfter(branch, rec.summaryLeaf)), out: null }));
          return say("Locked in. Tell the person, in plain words, that the team will look at it and come back to them; nothing is promised until then.");
        });
      },
    },
  ];
}

/** The tools of a gathering or settle session (one project: no `project` argument). */
export function batonDraftTools(sessionId: string): ToolSpec[] {
  return conversationDraftTools({
    sessionId,
    conversation: () => batonConversation(sessionId),
    projects: () => {
      const r = batonConversation(sessionId);
      return r ? [{ projectId: r.projectId }] : [];
    },
  });
}

/** Every record of a project (the draft-specs query). */
export const recordsOf = (projectId: string): ConversationDraftRecord[] => listRecords(placeOf(projectId).workspace, projectId);
