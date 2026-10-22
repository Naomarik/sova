import type { OwnerRequestRow, OwnerVersionRow } from "../shared/project-assistant";
import { orgRequests } from "./project-assistant-store";
import { assistantReady } from "./project-assistant-ready";
import { projectVersions, versionRows, type OwnerVersion } from "./owner-versions";
import { assistantWouldAct } from "./assistant-would-act";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OPERATOR, POOL, type BatonSession } from "../shared/baton";
import type { DecisionRow } from "../shared/decisions";
import type { OrgProject, Person } from "../shared/orgs";
import type {
  OwnerAbilities,
  OwnerAbilityOutcome,
  OwnerConversation,
  OwnerConversationRow,
  OwnerConversationStatus,
  OwnerCounts,
  OwnerDecision,
  OwnerDecisionState,
  OwnerDifference,
  OwnerHome,
  OwnerName,
  OwnerNews,
  OwnerPerson,
  OwnerProject,
  OwnerProjectAbilities,
  OwnerProjectCard,
  OwnerStatus,
  OwnerWaiting,
} from "../shared/owner";
import { allBatons, currentOffer, sessionPathOf } from "./baton";
import { isSessionBusy } from "./chat-handle";
import { readConflicts, readDecisionStore } from "./decisions";
import { operatorName, orgDir, OrgError, ownerOf, readOrg, readProjects, readRoster } from "./orgs";
import { handleOf } from "./person-links";
import { transcriptFacts } from "./person-page";
import { readBuilds, withWorktreePath } from "./build-loadout";
import { publishedUpdates } from "./project-updates";
import { featureChatOf, shownToOwner } from "./feature-chats";
import { readWorktree, type WorktreeReading } from "./project-worktrees";
import { listDecisions } from "./reconcile";
import { opaqueSenders, outsiderRedactor, readView } from "./share/hub";

/**
 * The Owner page (§app.owner-page/content): ONE function family, `ownerView`, answers the share
 * route (`/api/i/<token>`, the token's org) and the operator's preview (no token) alike, so the
 * preview is exactly what the owner reads.
 *
 * Built field by field into the shapes of shared/owner.ts: nothing here spreads a row, a Person, an
 * OrgProject or a DecisionRow into an answer. Model-written strings (decision statements, updates)
 * go through the outsider filter's `said` and `redact`; people's words, titles and names through
 * `redact`. No id leaves: projects and conversations are named by host handles (person-links.ts).
 *
 * Shown: the projects the operator didn't switch off, and their conversations (baton sessions) not
 * hidden from the owner. Never read here: the org's About text, the project overseer's notes,
 * ideas, to-dos, actions, settings or conversation, coding sessions' titles or transcripts, costs,
 * visits (server/owner-page-privacy.test.ts pins the imports).
 */

const firstOf = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

interface Ctx {
  orgId: string;
  dir: string;
  orgName: string;
  owner: Person;
  operator: OwnerName;
  roster: Map<string, Person>;
  projects: OrgProject[];
  /** Shown conversations, by project id. */
  rows: Map<string, BatonSession[]>;
  r: ReturnType<typeof outsiderRedactor>;
  now: number;
}

function contextOf(orgId: string, now: number): Ctx {
  const owner = ownerOf(orgId);
  if (!owner) throw new OrgError("This organization has no owner.", 409);
  const projects = readProjects(orgId).filter((p) => !p.ownerHidden);
  const shown = new Set(projects.map((p) => p.id));
  const rows = new Map<string, BatonSession[]>(projects.map((p) => [p.id, []]));
  // A feature request chat shows only to the owner who opened it (§app.project-assistant/feature-chats); it is never hidden from them.
  for (const row of allBatons())
    if (row.orgId === orgId && shown.has(row.projectId) && shownToOwner(row, owner.id) && (!row.hiddenFromOwner || featureChatOf(orgId, row.sessionId))) rows.get(row.projectId)!.push(row);
  const op = operatorName();
  const r = outsiderRedactor(orgId);
  return {
    orgId,
    dir: orgDir(orgId),
    orgName: r.redact(readOrg(orgId).name),
    owner,
    operator: { name: r.redact(op), first: r.redact(firstOf(op)) },
    roster: new Map(readRoster(orgId).map((p) => [p.id, p])),
    projects,
    rows,
    r,
    now,
  };
}

const nameOf = (ctx: Ctx, id: string): OwnerName => {
  if (id === OPERATOR) return ctx.operator;
  const p = ctx.roster.get(id);
  const name = p ? p.name : "Someone";
  return { name: ctx.r.redact(name), first: ctx.r.redact(firstOf(name)) };
};

function latest(times: (string | undefined)[]): string {
  let best = "";
  for (const t of times) if (t && t > best) best = t;
  return best;
}

// ---- one conversation's facts ------------------------------------------------------------------------

interface RowFacts {
  row: BatonSession;
  handle: string;
  status: OwnerConversationStatus;
  /** Roster people asked or writing in it (never the operator, never a proposed person). */
  people: Set<string>;
  sent: Map<string, { n: number; last: string }>;
  messages: number;
  lastActivityAt: string;
}

function statusOf(ctx: Ctx, row: BatonSession): OwnerConversationStatus {
  if (row.state === "closed") return { kind: "closed" };
  // The owner's own feature request chat: Planning with you while they hold it, Plan agreed once done.
  const feature = !!featureChatOf(ctx.orgId, row.sessionId);
  if (feature && row.state === "done") return { kind: "plan-agreed" };
  if (feature && row.holder === ctx.owner.id) return { kind: "planning" };
  if (row.state === "done") return { kind: "done" };
  const offer = currentOffer(row);
  if (row.holder === ctx.owner.id) return { kind: "waiting-on-you" };
  if (row.holder === null && offer && offer.state === "open") return offer.to.includes(ctx.owner.id) ? { kind: "waiting-on-you" } : { kind: "offered", count: offer.to.length };
  if (row.holder === null || row.holder === OPERATOR || row.state === "needs-you") return { kind: "with-operator", ...ctx.operator };
  return { kind: "waiting-on", ...nameOf(ctx, row.holder) };
}

function factsOf(ctx: Ctx, row: BatonSession): RowFacts {
  const path = sessionPathOf(ctx.dir, row);
  const facts = existsSync(join(ctx.dir, row.file)) ? transcriptFacts(path) : null;
  const sent = facts?.sent ?? new Map<string, { n: number; last: string }>();
  const people = new Set<string>();
  const add = (id: string) => {
    if (id === OPERATOR || id === POOL) return;
    const p = ctx.roster.get(id);
    if (p && p.status !== "proposed") people.add(id);
  };
  for (const h of row.handoffs) add(h.to);
  for (const o of row.offers ?? []) o.to.forEach(add);
  row.participants.forEach(add);
  if (row.holder) add(row.holder);
  for (const id of sent.keys()) add(id);
  let messages = 0;
  for (const s of sent.values()) messages += s.n;
  return {
    row,
    handle: handleOf("k", row.sessionId),
    status: statusOf(ctx, row),
    people,
    sent,
    messages,
    lastActivityAt: latest([row.createdAt, row.closedAt, ...row.handoffs.map((h) => h.at), ...(row.offers ?? []).map((o) => o.lastActivityAt), ...[...sent.values()].map((s) => s.last)]),
  };
}

/** When the conversation was put to the owner: the newest hand-off to them, or the open offer's. */
function askedAt(ctx: Ctx, f: RowFacts): string {
  const offer = currentOffer(f.row);
  if (f.row.holder === null && offer) return offer.createdAt;
  return [...f.row.handoffs].reverse().find((h) => h.to === ctx.owner.id)?.at ?? f.row.createdAt;
}

// ---- built work: counts only ----------------------------------------------------------------------------

const WORKTREE_TTL_MS = 60_000;
const worktreeCache = new Map<string, { at: number; reading: WorktreeReading }>();

async function builtCounts(ctx: Ctx, project: OrgProject): Promise<{ finished: number; inProgress: number; lastAt: string }> {
  let finished = 0;
  let inProgress = 0;
  const times: string[] = [];
  for (const b of readBuilds(project.id)) {
    times.push(b.createdAt, b.merged?.at ?? "");
    const r = await withWorktreePath(b, project.root);
    if (!r) {
      // Runs in the project root: its work lands there; building while it runs.
      if (b.path && isSessionBusy(b.path)) inProgress++;
      else finished++;
      continue;
    }
    const key = `${project.root}\0${r.worktree.path}\0${r.worktree.branch}`;
    let hit = worktreeCache.get(key);
    if (!hit || ctx.now - hit.at > WORKTREE_TTL_MS) {
      hit = { at: ctx.now, reading: await readWorktree(r.worktree, project.root) };
      worktreeCache.set(key, hit);
    }
    // Git decides, as on the project page (a branch merged once may have new commits); the recorded
    // merge, or removal with its branch, only when the branch is gone or git can't be read.
    const w = hit.reading;
    if (w.branch && !w.error ? w.merged : w.merged || !!r.merged || !!r.branchDeleted) finished++;
    else if (!r.removed) inProgress++;
  }
  return { finished, inProgress, lastAt: latest(times) };
}

// ---- decisions and differences --------------------------------------------------------------------------

function decisionRows(ctx: Ctx, projectId: string): DecisionRow[] {
  try {
    return listDecisions(ctx.orgId, projectId).decisions;
  } catch {
    return readDecisionStore(ctx.orgId, projectId).decisions;
  }
}

const DECISION_STATE: Record<string, OwnerDecisionState | undefined> = { promoted: "agreed", pending: "noted", drafted: "noted", conflict: "needs-choice" };

function decisionsOf(ctx: Ctx, projectId: string, shownSessions: Set<string>): { rows: DecisionRow[]; out: OwnerDecision[] } {
  const rows = decisionRows(ctx, projectId).filter((d) => shownSessions.has(d.sessionId) && DECISION_STATE[d.state]);
  const out = rows
    .map(
      (d): OwnerDecision => ({
        topic: ctx.r.redact(d.area),
        statement: ctx.r.said(ctx.r.redact(d.statement)),
        quote: ctx.r.redact(d.quote),
        by: nameOf(ctx, d.by),
        at: d.at,
        state: DECISION_STATE[d.state]!,
      }),
    )
    .sort((a, b) => b.at.localeCompare(a.at));
  return { rows, out };
}

function differencesOf(ctx: Ctx, projectId: string, shown: DecisionRow[]): OwnerDifference[] {
  const byId = new Map(shown.map((d) => [d.id, d]));
  const out: OwnerDifference[] = [];
  for (const c of readConflicts(ctx.orgId, projectId)) {
    if (c.state !== "open") continue;
    const a = byId.get(c.a);
    const b = byId.get(c.b);
    // Both sides must be shown: a side from a hidden conversation hides the difference.
    if (!a || !b) continue;
    const between = [...new Set([nameOf(ctx, a.by).name, nameOf(ctx, b.by).name])];
    const chooser: OwnerDifference["chooser"] =
      c.routedTo === ctx.owner.id ? { kind: "you" } : c.routedTo === OPERATOR ? { kind: "operator", ...ctx.operator } : { kind: "person", ...nameOf(ctx, c.routedTo) };
    out.push({ topic: ctx.r.redact(a.area), between, chooser });
  }
  return out;
}

// ---- a project ------------------------------------------------------------------------------------------

function newsOf(ctx: Ctx, projectId: string): OwnerNews[] {
  return publishedUpdates(ctx.orgId, projectId).map((u) => ({
    id: u.id,
    at: u.at,
    // The project overseer wrote it: the model's filter, as its replies get.
    text: ctx.r.said(ctx.r.redact(u.text)),
  }));
}

interface Assembled {
  card: OwnerProjectCard;
  facts: RowFacts[];
  news: OwnerNews[];
  decisions: OwnerDecision[];
  differences: OwnerDifference[];
  people: OwnerPerson[];
  waiting: OwnerWaiting[];
}

async function assemble(ctx: Ctx, project: OrgProject): Promise<Assembled> {
  const handle = handleOf("q", project.id);
  const name = ctx.r.redact(project.name);
  const facts = (ctx.rows.get(project.id) ?? []).map((row) => factsOf(ctx, row));
  const news = newsOf(ctx, project.id);
  const { rows: decisionList, out: decisions } = decisionsOf(ctx, project.id, new Set(facts.map((f) => f.row.sessionId)));
  const differences = differencesOf(ctx, project.id, decisionList);
  const built = await builtCounts(ctx, project);

  const who = new Map<string, OwnerPerson>();
  for (const f of facts)
    for (const id of f.people) {
      const p = who.get(id) ?? { ...nameOf(ctx, id), conversations: 0, waitingOnThem: false, isYou: id === ctx.owner.id };
      p.conversations++;
      const s = f.sent.get(id);
      if (s?.last && (!p.lastWroteAt || s.last > p.lastWroteAt)) p.lastWroteAt = s.last;
      if (f.row.holder === id && (f.row.state === "open" || f.row.state === "needs-you")) p.waitingOnThem = true;
      who.set(id, p);
    }
  const people = [...who.values()].sort((a, b) => (b.lastWroteAt ?? "").localeCompare(a.lastWroteAt ?? "") || a.name.localeCompare(b.name));

  const waiting: OwnerWaiting[] = facts
    .filter((f) => f.status.kind === "waiting-on-you" || f.status.kind === "planning")
    .map((f) => ({ conversation: f.handle, publicTitle: ctx.r.redact(f.row.publicTitle), project: handle, projectName: name, askedAt: askedAt(ctx, f), ...(f.status.kind === "planning" ? { feature: true as const } : {}) }))
    .sort((a, b) => b.askedAt.localeCompare(a.askedAt));

  const status: OwnerStatus = waiting.length
    ? "waiting-on-you"
    : facts.some((f) => f.row.state === "open" || f.row.state === "needs-you")
      ? "asking"
      : built.inProgress > 0
        ? "building"
        : "quiet";
  const counts: OwnerCounts = { people: people.length, decisions: decisions.length, finished: built.finished, inProgress: built.inProgress };
  const card: OwnerProjectCard = {
    id: handle,
    name,
    status,
    lastActivityAt: latest([...facts.map((f) => f.lastActivityAt), news[0]?.at, built.lastAt]),
    latestNews: news[0] ?? null,
    conversations: facts.length,
    ...counts,
  };
  return { card, facts, news, decisions, differences, people, waiting };
}

function rowOf(ctx: Ctx, f: RowFacts): OwnerConversationRow {
  return { id: f.handle, publicTitle: ctx.r.redact(f.row.publicTitle), status: f.status, createdAt: f.row.createdAt, messages: f.messages, lastActivityAt: f.lastActivityAt };
}

// ---- the three answers ------------------------------------------------------------------------------------

export async function ownerHome(orgId: string, now = Date.now()): Promise<OwnerHome> {
  const ctx = contextOf(orgId, now);
  const all = await Promise.all(ctx.projects.map((p) => assemble(ctx, p)));
  const cards = all.map((a) => a.card).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.name.localeCompare(b.name));
  const ready = await assistantReady(orgId);
  return {
    org: { name: ctx.orgName },
    owner: nameOf(ctx, ctx.owner.id),
    operator: ctx.operator,
    updatedAt: new Date(now).toISOString(),
    waiting: all.flatMap((a) => a.waiting).sort((a, b) => b.askedAt.localeCompare(a.askedAt)),
    projects: cards,
    requests: requestRows(ctx),
    versions: await versionsOf(ctx),
    assistant: { ready },
    ...(ready ? { abilities: await abilitiesOf(ctx, cards) } : {}),
  };
}

/** What the assistant can do for the owner, per shown project, in the cards' order (§app.project-assistant/abilities):
    the tools' own question, asked without doing anything; outcome words only. */
async function abilitiesOf(ctx: Ctx, cards: OwnerProjectCard[]): Promise<OwnerAbilities> {
  const byHandle = new Map(ctx.projects.map((p) => [handleOf("q", p.id), p.id]));
  const word = (a: { outcome: OwnerAbilityOutcome | "none" }): OwnerAbilityOutcome => (a.outcome === "none" ? "team" : a.outcome);
  const projects = await Promise.all(
    cards.map(async (c): Promise<OwnerProjectAbilities> => {
      const id = byHandle.get(c.id)!;
      const [fix, version, release, feature] = await Promise.all((["fix", "version", "release", "feature"] as const).map((k) => assistantWouldAct(ctx.orgId, id, k).catch(() => ({ outcome: "team" as const }))));
      return { project: c.id, fix: word(fix!), version: version!.outcome, release: word(release!), feature: feature!.outcome === "now" ? "now" : "team" };
    }),
  );
  // Imported late: server/project-assistant.ts imports this module.
  const { assistantPhotoLimits } = await import("./project-assistant");
  const photos = !!(await assistantPhotoLimits(ctx.orgId).catch(() => null));
  return { photos, projects };
}

/** The owner's requests of the shown projects (§app.project-assistant/requests): handles, names, the words the model wrote passed through `said`. */
function requestRows(ctx: Ctx): OwnerRequestRow[] {
  const names = new Map(ctx.projects.map((p) => [p.id, p.name]));
  return orgRequests(ctx.orgId)
    .filter((r) => names.has(r.projectId))
    .map((r) => ({ handle: handleOf("r", r.id), project: ctx.r.redact(names.get(r.projectId)!), kind: r.kind, title: ctx.r.redact(ctx.r.said(r.title)), status: r.status, at: r.updatedAt, ...planOfRequest(ctx, r) }));
}

/** A `feature` request's chat as it stands (§app.project-assistant/feature-chats): planning while open, agreed once
    done, while the request is still with the team; only for the owner who opened it. */
function planOfRequest(ctx: Ctx, r: { kind: string; status: string; sessionId?: string }): { plan?: "planning" | "agreed" } {
  if (r.kind !== "feature" || r.status !== "with-team" || !r.sessionId) return {};
  const rec = featureChatOf(ctx.orgId, r.sessionId);
  if (!rec || rec.personId !== ctx.owner.id) return {};
  const row = [...ctx.rows.values()].flat().find((x) => x.sessionId === r.sessionId);
  if (!row) return {};
  if (row.state === "done") return { plan: "agreed" };
  if (row.state === "open" || row.state === "needs-you") return { plan: "planning" };
  return {};
}

/** Versions you can try of the shown projects (§app.project-assistant/versions); never an address. */
async function versionsOf(ctx: Ctx): Promise<OwnerVersionRow[]> {
  const out: OwnerVersionRow[] = [];
  for (const p of ctx.projects) out.push(...versionRows(await projectVersions(ctx.orgId, p).catch(() => []), ctx.r));
  return out;
}

/** A version of a shown project by its handle, for the Open route; null when none. */
export async function ownerVersionOf(orgId: string, handle: string): Promise<OwnerVersion | null> {
  const ctx = contextOf(orgId, Date.now());
  for (const p of ctx.projects) {
    const hit = (await projectVersions(orgId, p).catch(() => [])).find((v) => v.handle === handle);
    if (hit) return hit;
  }
  return null;
}

export async function ownerProject(orgId: string, handle: string, now = Date.now()): Promise<OwnerProject> {
  const ctx = contextOf(orgId, now);
  const project = ctx.projects.find((p) => handleOf("q", p.id) === handle);
  if (!project) throw new OrgError("Not found", 404);
  const a = await assemble(ctx, project);
  const { people: _people, decisions: _decisions, latestNews: _latest, conversations: _conversations, ...card } = a.card;
  return {
    ...card,
    org: { name: ctx.orgName },
    owner: nameOf(ctx, ctx.owner.id),
    operator: ctx.operator,
    updatedAt: new Date(now).toISOString(),
    news: a.news,
    waiting: a.waiting,
    people: a.people,
    decisions: a.decisions,
    differences: a.differences,
    conversations: a.facts.map((f) => rowOf(ctx, f)).sort((x, y) => y.lastActivityAt.localeCompare(x.lastActivityAt)),
  };
}

export async function ownerConversation(orgId: string, handle: string, now = Date.now()): Promise<OwnerConversation> {
  const ctx = contextOf(orgId, now);
  let hit: { project: OrgProject; row: BatonSession } | null = null;
  for (const project of ctx.projects) for (const row of ctx.rows.get(project.id) ?? []) if (handleOf("k", row.sessionId) === handle) hit = { project, row };
  if (!hit) throw new OrgError("Not found", 404);
  const f = factsOf(ctx, hit.row);
  // The owner reads the whole thread (never cut at an offer), briefings only when addressed to them.
  const view = await readView(hit.row, ctx.dir, ctx.owner.id);
  return {
    id: f.handle,
    project: handleOf("q", hit.project.id),
    projectName: ctx.r.redact(hit.project.name),
    status: f.status,
    yourTurn: hit.row.holder === ctx.owner.id && (hit.row.state === "open" || hit.row.state === "needs-you"),
    ...(featureChatOf(orgId, hit.row.sessionId)
      ? { feature: { canWrite: hit.row.holder === ctx.owner.id && (hit.row.state === "open" || hit.row.state === "needs-you") && hit.row.budget.messagesUsed < hit.row.budget.messagesMax, canEnd: hit.row.state === "open" || hit.row.state === "needs-you" } }
      : {}),
    org: { name: ctx.orgName },
    operator: ctx.operator,
    updatedAt: new Date(now).toISOString(),
    publicTitle: view.publicTitle,
    state: view.state,
    holder: view.holder,
    drawings: view.drawings,
    viewer: { name: nameOf(ctx, ctx.owner.id).name, canWrite: false },
    items: opaqueSenders(view.items, ctx.owner.id),
  };
}

/** The one entry point: the share route (with the token's org) and the operator's preview. */
export function ownerView(orgId: string, what: { project?: string; conversation?: string } = {}, now = Date.now()): Promise<OwnerHome | OwnerProject | OwnerConversation> {
  if (what.conversation !== undefined) return ownerConversation(orgId, what.conversation, now);
  if (what.project !== undefined) return ownerProject(orgId, what.project, now);
  return ownerHome(orgId, now);
}

/** The assistant takes messages (§app.project-assistant/chat): the one readiness predicate. */
export { assistantReady };
