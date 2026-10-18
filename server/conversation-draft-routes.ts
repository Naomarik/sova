import type { Context, Hono } from "hono";
import type { ConversationDraftRecord, DraftApproveResult, DraftBuildResult, DraftItem, DraftSpecSummary } from "../shared/conversation-drafts";
import type { ToolSpec } from "../shared/harness";
import type { DecisionRow } from "../shared/decisions";
import { blocksOf, currentClaims, promoteEdit, specDirOf, SpecToolError } from "./spec-draft-writer";
import { catchUpRecord, readRecord, writeRecord } from "./conversation-draft-store";
import { baseBlocks, editOfItems, isCurrent } from "./conversation-draft";
import { approveBranchRefusal, draftBaseOf, placeOf, recordsOf } from "./conversation-draft-tools";
import { readDecisionStore } from "./decisions";
import { commitSpec, specSnapshot } from "./project-worktrees";
import { OrgError } from "./orgs";
import { listProjects } from "./projects/spaces";

/**
 * The operator's side of conversation drafts (§app.requirements/draft-specs, /draft-approval): "what are
 * the draft specs?" (the route and both overseers' `sova_draft_specs`), approving a conversation's
 * draft, and starting a coding session to build its changes. Main listener only.
 */

// ---- reading -----------------------------------------------------------------------------------------------

/** The legacy decisions of an org's project by id (to link the two promotion paths); empty for a standalone project. */
function legacyDecisions(orgId: string | undefined, projectId: string): Map<string, DecisionRow> {
  if (!orgId) return new Map();
  try {
    return new Map(readDecisionStore(orgId, projectId).decisions.map((d) => [d.id, d]));
  } catch {
    return new Map();
  }
}

/**
 * An item's status as it reads now: a decision the legacy path promoted is `promoted`; an approved
 * change whose note record is now current (its coding session promoted it) is `built`.
 */
export function statusNow(it: DraftItem, legacy: ReadonlyMap<string, Pick<DecisionRow, "state">>, current: Record<string, unknown>, sessionId: string): DraftItem["status"] {
  if (it.status === "dropped" || it.status === "built") return it.status;
  if (it.kind === "change") return it.status === "approved" && it.recordId && it.recordId in current ? "built" : it.status;
  const promoted = it.status === "promoted" || (it.decisionId && legacy.get(it.decisionId)?.state === "promoted") || isCurrent(it, current, sessionId);
  if (!promoted) return it.status;
  // A new requirement is built once a coding session recorded its code with reviewed or verified evidence on its record.
  return it.recordId && builtRecord(current[it.recordId]) ? "built" : "promoted";
}

/** A record a builder has recorded as built: it maps code, with reviewed or verified evidence (§app.requirements/decisions "Built"). */
function builtRecord(rec: unknown): boolean {
  const r = (rec ?? {}) as { code?: unknown; evidence?: unknown };
  return Array.isArray(r.code) && r.code.length > 0 && (r.evidence === "reviewed" || r.evidence === "verified");
}

/** Operator-side view of an item (no quote's author id; everything else). */
function shown(it: DraftItem, status: DraftItem["status"]): DraftItem {
  return { ...it, status };
}

/** One conversation's summary against the current spec. */
export function summaryOfRecord(rec: ConversationDraftRecord, projectName: string, root: string, baseRoot: string | null = root): DraftSpecSummary {
  // Promotions land in the root's spec; the draft and its changes are compared with the main line's.
  const current = currentClaims(root);
  const blocks = baseBlocks(baseRoot);
  const legacy = legacyDecisions(rec.orgId, rec.projectId);
  const live = rec.items.filter((i) => i.status !== "dropped").map((i) => shown(i, statusNow(i, legacy, current, rec.sessionId)));
  return {
    sessionId: rec.sessionId,
    projectId: rec.projectId,
    projectName,
    ...(rec.person ? { person: rec.person.name } : {}),
    title: rec.title ?? rec.sessionId,
    kind: rec.kind,
    state: rec.state,
    draft: rec.draft,
    newItems: live.filter((i) => i.kind === "new"),
    changes: live.filter((i) => i.kind === "change").map((i) => ({ ...i, ...(i.target && blocks.has(i.target) ? { currentText: blocks.get(i.target)!.replace(/\n+$/, "") } : {}) })),
    clashes: live.filter((i) => i.clash).length,
    updatedAt: rec.updatedAt,
  };
}

/** Every conversation's draft of `projectId`, or of every project on this host. */
export async function listDraftSpecs(projectId?: string, sessionId?: string): Promise<DraftSpecSummary[]> {
  const ids = projectId ? [projectId] : listProjects().filter((p) => !p.archived).map((p) => p.id);
  const out: DraftSpecSummary[] = [];
  for (const pid of ids) {
    let recs: ConversationDraftRecord[];
    let place: ReturnType<typeof placeOf>;
    try {
      place = placeOf(pid);
      recs = recordsOf(pid);
    } catch (err) {
      if (projectId) throw err;
      continue;
    }
    const mine = recs.filter((r) => !sessionId || r.sessionId === sessionId);
    if (!mine.length) continue;
    const base = await draftBaseOf(pid, place.root);
    for (const r of mine) out.push(summaryOfRecord(r, place.name ?? pid, place.root, base));
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The words an overseer reads ("what are the draft specs?"). */
export function draftSpecsText(drafts: readonly DraftSpecSummary[], full: boolean): string {
  if (!drafts.length) return "No conversation has a draft spec.";
  const out: string[] = [];
  for (const d of drafts) {
    out.push(
      `## ${d.title} (${d.kind}${d.person ? ` with ${d.person}` : ""}) · ${d.projectName}`,
      `Session ${d.sessionId} · draft ${d.draft} · ${d.state === "confirmed" ? "Confirmed by the person" : "Not confirmed yet"} · updated ${d.updatedAt}${d.clashes ? ` · ${d.clashes} clash${d.clashes === 1 ? "" : "es"}` : ""}`,
    );
    if (!d.newItems.length && !d.changes.length) out.push("Nothing agreed yet.");
    for (const i of d.newItems) out.push(`- ${i.id} New [${i.status}]: ${i.text}${full ? `\n  Their words: "${i.quote}"` : ""}`);
    for (const i of d.changes)
      out.push(
        `- ${i.id} Change to ${i.target} [${i.status}${i.clash ? `, clash: ${i.clash}` : ""}]: ${i.text}${full ? `\n  Their words: "${i.quote}"` : ""}${full && i.currentText ? `\n  Now: ${i.currentText.split("\n").slice(2).join(" ").trim().slice(0, 400)}` : ""}`,
      );
    out.push("");
  }
  return out.join("\n").trimEnd();
}

/** `sova_draft_specs` for an overseer: `ownProject` set (the project overseer) confines it to that project. */
export function draftSpecsTool(ownProject?: string): ToolSpec {
  return {
    name: "sova_draft_specs",
    label: "Draft specs",
    description:
      "What are the draft specs? Every gathering, settle and Project Assistant conversation's own spec draft: its new requirements and changes to existing behaviour compared with the current spec, whether the person confirmed them, and what clashes. Read only.",
    parameters: {
      type: "object",
      properties: {
        ...(ownProject ? {} : { project: { type: "string", description: "A project id; every project when omitted." } }),
        session: { type: "string", description: "One conversation's session id, in full." },
      },
      required: [],
      additionalProperties: false,
    } as any,
    async execute(_id, params: any) {
      const pid = ownProject ?? (typeof params?.project === "string" && params.project.trim() ? params.project.trim() : undefined);
      const sid = typeof params?.session === "string" && params.session.trim() ? params.session.trim() : undefined;
      const text = draftSpecsText(await listDraftSpecs(pid, sid), true);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  };
}

// ---- approving -------------------------------------------------------------------------------------------------

function recordOrThrow(projectId: string, sessionId: string): { rec: ConversationDraftRecord; place: ReturnType<typeof placeOf> } {
  const place = placeOf(projectId);
  const rec = readRecord(place.workspace, projectId, sessionId);
  if (!rec) throw new OrgError("This conversation has no draft spec.", 404);
  return { rec, place };
}

function chosenItems(rec: ConversationDraftRecord, items: unknown): DraftItem[] {
  if (items !== undefined && (!Array.isArray(items) || !items.every((x) => typeof x === "string"))) throw new OrgError("items must be a list of item ids.");
  const live = rec.items.filter((i) => i.status !== "dropped");
  if (!items) return live;
  const ids = new Set(items as string[]);
  const out = live.filter((i) => ids.has(i.id));
  const missing = [...ids].filter((id) => !out.some((i) => i.id === id));
  if (missing.length) throw new OrgError(`Not in this draft: ${missing.join(", ")}.`, 404);
  return out;
}

const verificationOf = (rec: ConversationDraftRecord, it: DraftItem): string =>
  `Agreed in conversation ${rec.sessionId}${rec.person ? ` with ${rec.person.name}` : ""} on ${it.agreedAt.slice(0, 10)}${rec.state === "confirmed" ? `, confirmed ${String(rec.confirmedAt ?? "").slice(0, 10)}` : ", not confirmed by the person"}; approved by the operator from draft ${rec.draft}. Their words: "${it.quote}".`;

/**
 * Approve (§app.requirements/draft-approval): new items promoted into the current spec now (a
 * promotion draft through the spec tools, committed like any promotion), changes approved to wait
 * for a build, and items the legacy path already promoted marked so. The operator's only.
 */
export async function approveDraft(projectId: string, sessionId: string, items?: unknown, now = new Date()): Promise<DraftApproveResult> {
  const { rec: had, place } = recordOrThrow(projectId, sessionId);
  // It writes into the root's spec: only while the root is on the main line the draft was built on.
  const wrongBranch = await approveBranchRefusal(place.root);
  if (wrongBranch) throw new OrgError(wrongBranch, 409);
  // The draft on current first: record ids assigned, clashes known.
  const base = await draftBaseOf(projectId, place.root);
  const rec = await catchUpRecord(place, had, now, base);
  const chosen = chosenItems(rec, items);
  const current = currentClaims(place.root);
  const legacy = legacyDecisions(rec.orgId, projectId);
  const alreadyPromoted: string[] = [];
  const toPromote: DraftItem[] = [];
  const waitingForBuild: string[] = [];
  for (const it of chosen) {
    const st = statusNow(it, legacy, current, rec.sessionId);
    if (it.kind === "new") {
      if (st === "promoted" || st === "built") alreadyPromoted.push(it.id);
      else toPromote.push(it);
    } else if (st === "agreed" || st === "approved") waitingForBuild.push(it.id);
  }
  // A legacy decision already drafted under its own record id: the same record, never a second one.
  const prepared = toPromote.map((it) => {
    const d = it.decisionId ? legacy.get(it.decisionId) : undefined;
    return d?.recordId && d.recordId !== it.recordId ? { ...it, recordId: d.recordId } : it;
  });
  let commit: DraftApproveResult["commit"];
  const promoted: string[] = [];
  if (prepared.length) {
    const snap = await specSnapshot(place.root).catch(() => null);
    const byRecord = new Map(prepared.map((it) => [it.recordId!, it]));
    const out = await promoteEdit(place.root, editOfItems(prepared, sessionId), (rid) => {
      const it = byRecord.get(rid);
      return it ? verificationOf(rec, it) : `Area of requirements approved from draft ${rec.draft}.`;
    }, now);
    const nowCurrent = currentClaims(place.root);
    for (const it of prepared) if (it.recordId && it.recordId in nowCurrent) promoted.push(it.id);
    if (snap && promoted.length) {
      const message = `Approve ${promoted.length} requirement${promoted.length === 1 ? "" : "s"} from ${rec.title ?? rec.sessionId}: ${prepared.filter((i) => promoted.includes(i.id)).slice(0, 10).map((i) => i.title.slice(0, 72)).join("; ")}`;
      commit = await commitSpec(snap, message).catch((err) => ({ skipped: `Not committed: ${err instanceof Error ? err.message : String(err)}` }));
    }
    void out;
  }
  const at = now.toISOString();
  const recIds = new Map(prepared.map((it) => [it.id, it.recordId]));
  const next: ConversationDraftRecord = {
    ...rec,
    items: rec.items.map((it) => {
      if (promoted.includes(it.id) || alreadyPromoted.includes(it.id)) return { ...it, status: it.status === "built" ? ("built" as const) : ("promoted" as const), approvedAt: it.approvedAt ?? at, ...(recIds.get(it.id) ? { recordId: recIds.get(it.id)! } : {}) };
      if (waitingForBuild.includes(it.id)) return { ...it, status: "approved" as const, approvedAt: it.approvedAt ?? at };
      return it;
    }),
    updatedAt: at,
  };
  writeRecord(place.workspace, next);
  // The draft follows: promoted records are current now, so they leave the draft's changes.
  const caught = await catchUpRecord(place, next, now, base);
  return { promoted, waitingForBuild, alreadyPromoted, ...(commit ? { commit } : {}), draft: summaryOfRecord(caught, place.name ?? projectId, place.root, base) };
}

/** A legacy promotion of these decisions: their items in any conversation's record of the project read promoted. */
export function markDecisionItemsPromoted(projectId: string, decisionIds: readonly string[], now = new Date()): void {
  if (!decisionIds.length) return;
  const ids = new Set(decisionIds);
  let place: ReturnType<typeof placeOf>;
  try {
    place = placeOf(projectId);
  } catch {
    return;
  }
  for (const rec of recordsOf(projectId)) {
    if (!rec.items.some((i) => i.decisionId && ids.has(i.decisionId) && i.kind === "new" && i.status !== "promoted" && i.status !== "dropped")) continue;
    writeRecord(place.workspace, {
      ...rec,
      items: rec.items.map((i) => (i.decisionId && ids.has(i.decisionId) && i.kind === "new" && i.status !== "dropped" ? { ...i, status: "promoted" as const } : i)),
      updatedAt: now.toISOString(),
    });
  }
}

// ---- building ----------------------------------------------------------------------------------------------------

/**
 * The first prompt of a coding session that builds a conversation's draft: every item given, grouped
 * as "New requirements" and "Changes to existing behaviour", each with what to do with its record.
 */
export function buildPrompt(rec: ConversationDraftRecord, items: readonly DraftItem[], root: string, current: Record<string, unknown> = currentClaims(root), baseRoot: string | null = root): string {
  const blocks = baseBlocks(baseRoot);
  const news = items.filter((i) => i.kind === "new");
  const changes = items.filter((i) => i.kind === "change");
  const lines = [
    `Build what was agreed in the conversation "${rec.title ?? rec.sessionId}"${rec.person ? ` with ${rec.person.name}` : ""}: ${news.length} new requirement${news.length === 1 ? "" : "s"} and ${changes.length} change${changes.length === 1 ? "" : "s"} to existing behaviour. They are in its spec draft \`${rec.draft}\` (.sova/spec/drafts/${rec.draft}/), compared with the current spec below.`,
    "",
    "Work in your own spec draft; never edit the conversation's draft itself.",
    "- A new requirement already in the current spec: implement it, then record its code and evidence on that record in your draft.",
    "- A new requirement not in the current spec yet: implement it, copy its note record from the conversation's draft into yours, and promote it with its code and evidence.",
    "- A change: implement it, update the record it changes to say what the app now does, and promote that record together with the change's own note record (copied from the conversation's draft).",
    "",
  ];
  const section = (title: string, group: readonly DraftItem[]) => {
    if (!group.length) return;
    lines.push(`## ${title}`, "");
    for (const it of group) entry(it);
  };
  const entry = (it: DraftItem) => {
    const cur = it.target ? blocks.get(it.target) : undefined;
    const inCurrent = !!it.recordId && it.recordId in current;
    lines.push(
      `### ${it.kind === "change" ? `Change to ${it.target}` : inCurrent ? "New requirement (in the spec, not built yet)" : "New requirement (not in the spec yet)"}: ${it.title}`,
      "",
      it.text,
      "",
      `Their words: "${it.quote}"`,
      ...(it.recordId ? ["", `Its note record in the draft: ${it.recordId}`] : []),
      ...(it.clash ? ["", `Clash: ${it.target} ${it.clash === "gone" ? "is no longer in the current spec" : "changed in the current spec since this was agreed"}; check it before building.`] : []),
      ...(cur ? ["", "The record it changes, as it reads now:", "", "```markdown", cur.replace(/\n+$/, ""), "```"] : []),
      "",
    );
  };
  section("New requirements", news);
  section("Changes to existing behaviour", changes);
  return `${lines.join("\n").trimEnd()}\n`;
}

type StartDraftBuild = (projectId: string, input: { title: string; prompt: string; extra?: { conversationDraft: string } }) => Promise<{ sessionId: string; path?: string }>;
let startForTest: StartDraftBuild | null = null;
/** Tests: what starts the coding session (null: the project overseer's startDraftBuild). */
export function setDraftBuildStarterForTest(f: StartDraftBuild | null): void {
  startForTest = f;
}

async function starter(): Promise<StartDraftBuild> {
  if (startForTest) return startForTest;
  const mod = (await import("./project-overseer")) as unknown as { startDraftBuild?: StartDraftBuild };
  if (typeof mod.startDraftBuild !== "function") throw new OrgError("Starting a coding session from a draft is not available yet.", 409);
  return mod.startDraftBuild;
}

/** Build: a coding session of the project, the operator's, that builds the chosen items: every item not built or dropped (new and change alike, agreed, approved or promoted) unless `items` narrows it. */
export async function buildDraft(projectId: string, sessionId: string, items?: unknown, now = new Date()): Promise<DraftBuildResult> {
  const { rec: had, place } = recordOrThrow(projectId, sessionId);
  const base = await draftBaseOf(projectId, place.root);
  const rec = await catchUpRecord(place, had, now, base);
  const current = currentClaims(place.root);
  const legacy = legacyDecisions(rec.orgId, projectId);
  const chosen = chosenItems(rec, items).filter((i) => {
    const st = statusNow(i, legacy, current, rec.sessionId);
    return st !== "built" && st !== "dropped";
  });
  if (!chosen.length) throw new OrgError("Nothing in this draft is waiting to be built.", 409);
  const title = `Build: ${rec.title ?? "conversation draft"}`.slice(0, 80);
  const made = await (await starter())(projectId, { title, prompt: buildPrompt(rec, chosen, place.root, current, base), extra: { conversationDraft: rec.draft } });
  const at = now.toISOString();
  const ids = new Set(chosen.map((i) => i.id));
  writeRecord(place.workspace, {
    ...rec,
    items: rec.items.map((i) => (ids.has(i.id) ? { ...i, ...(i.kind === "change" ? { status: "approved" as const } : {}), approvedAt: i.approvedAt ?? at, buildSessionId: made.sessionId } : i)),
    updatedAt: at,
  });
  return { sessionId: made.sessionId, title, ...(made.path ? { path: made.path } : {}), items: chosen.map((i) => i.id) };
}

// ---- the overseers' approve and build -------------------------------------------------------------------------------

export const DRAFT_ACT_REFUSAL = "Approving a draft is the operator's: ask them.";
export const DRAFT_BUILD_REFUSAL = "Building a draft is the operator's: ask them.";

/**
 * `sova_draft_approve` and `sova_draft_build` for an overseer: run only in a turn the operator is in
 * (`attended()`), whatever the power switches say; refused otherwise. `ownProject` (the project
 * overseer) confines them to that project.
 */
export function draftActTools(opts: { ownProject?: string; attended: () => boolean }): ToolSpec[] {
  const params = (what: string) =>
    ({
      type: "object",
      properties: {
        ...(opts.ownProject ? {} : { project: { type: "string", description: "The project's id." } }),
        session: { type: "string", description: "The conversation's session id (sova_draft_specs lists them)." },
        items: { type: "array", items: { type: "string" }, description: `Item ids (r1, r2…) to ${what}; every one when omitted.` },
      },
      required: opts.ownProject ? ["session"] : ["project", "session"],
      additionalProperties: false,
    }) as any;
  const target = (p: any): { pid: string; sid: string } => {
    const pid = opts.ownProject ?? (typeof p?.project === "string" ? p.project.trim() : "");
    const sid = typeof p?.session === "string" ? p.session.trim() : "";
    if (!pid || !sid) throw new Error("Name the project and the conversation's session id.");
    return { pid, sid };
  };
  const run = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  };
  return [
    {
      name: "sova_draft_approve",
      label: "Approve draft",
      description:
        "The operator approves a conversation's draft spec: its new requirements are promoted into the spec at once, its changes to existing behaviour wait for a coding session to build them. Only when the operator asks you to, in their own turn.",
      parameters: params("approve"),
      async execute(_id, p: any) {
        if (!opts.attended()) throw new Error(DRAFT_ACT_REFUSAL);
        const { pid, sid } = target(p);
        const out = await run(() => approveDraft(pid, sid, p?.items));
        const commit = out.commit ? ("sha" in out.commit ? ` Committed ${out.commit.sha.slice(0, 7)} on ${out.commit.branch}.` : ` ${out.commit.skipped}`) : "";
        const text = `Promoted: ${out.promoted.join(", ") || "none"}. Waiting for a build: ${out.waitingForBuild.join(", ") || "none"}. Already promoted: ${out.alreadyPromoted.join(", ") || "none"}.${commit}`;
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    },
    {
      name: "sova_draft_build",
      label: "Build draft",
      description: "The operator starts a coding session that builds a conversation draft's changes, with the draft as its context. Only when the operator asks you to, in their own turn.",
      parameters: params("build"),
      async execute(_id, p: any) {
        if (!opts.attended()) throw new Error(DRAFT_BUILD_REFUSAL);
        const { pid, sid } = target(p);
        const out = await run(() => buildDraft(pid, sid, p?.items));
        return { content: [{ type: "text" as const, text: `Started the coding session "${out.title}" (${out.sessionId}) for ${out.items.join(", ")}.` }], details: {} };
      },
    },
  ];
}

// ---- routes --------------------------------------------------------------------------------------------------------

async function body(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const b = JSON.parse(text);
    return typeof b === "object" && b !== null && !Array.isArray(b) ? b : {};
  } catch {
    throw new OrgError("Expected a JSON object body");
  }
}

const handle =
  (fn: (c: Context) => Promise<Response> | Response) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message }, err.status);
      if (err instanceof SpecToolError) return c.json({ error: err.message, codes: err.codes }, 409);
      throw err;
    }
  };

/** The operator's routes (shared/conversation-drafts.ts). Main listener only. */
export function registerConversationDraftRoutes(app: Hono<any>): void {
  app.get(
    "/api/draft-specs",
    handle(async (c) => {
      const project = c.req.query("project") || undefined;
      const session = c.req.query("session") || undefined;
      return c.json({ drafts: await listDraftSpecs(project, session) });
    }),
  );
  app.post(
    "/api/projects/:pid/draft-specs/:sid/approve",
    handle(async (c) => c.json(await approveDraft(c.req.param("pid") ?? "", c.req.param("sid") ?? "", (await body(c)).items))),
  );
  app.post(
    "/api/projects/:pid/draft-specs/:sid/build",
    handle(async (c) => c.json(await buildDraft(c.req.param("pid") ?? "", c.req.param("sid") ?? "", (await body(c)).items), 202)),
  );
}
