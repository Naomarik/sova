import type { ToolSpec } from "../shared/harness";
import {
  HISTORY_BOUNDS,
  HISTORY_KINDS,
  HISTORY_OUTCOMES,
  KIND_HEADLINES,
  OUTCOME_WORDS,
  isUnknown,
  type ActorRef,
  type ActorView,
  type DecisionBody,
  type EventDetail,
  type EventSummary,
  type EvidenceRef,
  type HistoryChain,
  type HistoryInput,
  type HistoryPage,
  type HistoryQuery,
  type HistoryReader,
  type QuoteCheck,
  type Unknown,
} from "../shared/org-history";
import { batonSid } from "./baton";
import { hostOf, isOrgHostOpen, type OrgHostApi } from "./org-engine";
import type { HistoryLabels } from "./org-history/query";
import { orgLabels, orgSources } from "./org-history-routes";
import { contactRedactor, resolveOrg, resolveProject, untrusted, ViewRefusal } from "./overseer-org-view";
import { placementSid, readIndex } from "./orgs";
import { obj, Refusal, str, text } from "./project-overseer-tools";
import { contributeProjectPart, type OverseerToolCtx } from "./projects/contributions";

/**
 * The overseers' reads of the org's history and the project overseer's own decisions. Org-layer only: a project overseer gets these through the project layer's registration
 * point (contributeProjectPart), so no project module imports the history.
 *
 * - `sova_history` (a project overseer): its own project's events, and of the org's other projects only the
 *   boundary card a link to one of its own reaches. No model call: the history's own index answers.
 * - `sova_decide` (a project overseer): a decision of its own, a decision not to act included, with its reason
 *   and options, recorded in the org's history and nowhere else (no statechart changes).
 * - `sova_org_history` (the global Overseer, server/overseer-tools.ts): the same reads over the whole org.
 *
 * Text from the history is data: every result is fenced as untrusted, and contact values are scrubbed.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const iso = (ms: number) => new Date(ms).toISOString();
const NONE = "No recorded event in this scope.";

/** The project a cited session belongs to: a statechart session's own (`baton/…`, `build/…`, `decision/…`,
    `watch/<p>`: every project-scoped statechart holds its projectId), a gathering's (its baton statechart), a
    coding session's (its build). Unplaceable: null (a project overseer is then not shown it). */
export function sessionProjectOf(host: OrgHostApi, orgId: string): (session: string) => string | null {
  return (session) => {
    if (session.includes("/")) {
      const own = host.data(session)?.projectId;
      return typeof own === "string" && own ? own : null;
    }
    const b = host.data(batonSid(orgId, session));
    if (typeof b?.projectId === "string") return b.projectId;
    const build = host.sessions("build").find((s) => s.data.sessionId === session);
    return typeof build?.data.projectId === "string" ? build.data.projectId : null;
  };
}

/** The labels a model reader gets: names, the session's project, and contact values scrubbed from every text. */
export function modelLabels(orgId: string): HistoryLabels {
  const scrub = contactRedactor().text;
  return { ...orgLabels(orgId), scrub, sessionProject: sessionProjectOf(hostOf(orgId), orgId) };
}

// ---- words -------------------------------------------------------------------------------------------------

function actorWords(a: ActorView | Unknown | undefined): string {
  if (!a || isUnknown(a)) return a?.why && a.why !== "Not recorded." && a.why !== "withheld" ? `not recorded (${a.why})` : "not recorded";
  return (a as { label?: string }).label || (a as ActorRef).kind;
}

function summaryLine(e: EventSummary): string {
  const where = e.boundary ? `${e.project?.name ?? "another project"} (outside this project: a linked event)` : (e.project?.name ?? "the org");
  const reason = e.reason ? ` · reason: ${e.reason}` : e.reasonState === "purged" ? " · reason purged" : "";
  // a boundary card carries no actors: who is withheld from this reader, not unrecorded
  const who = e.boundary && !e.actors ? "who: withheld" : `decided by ${actorWords(e.actors?.decidedBy)}, initiated by ${actorWords(e.actors?.initiatedBy)}`;
  return `- ${e.id} · ${iso(e.occurredAt ?? e.recordedAt)} · ${where} · ${e.headline} · ${OUTCOME_WORDS[e.outcome as keyof typeof OUTCOME_WORDS] ?? e.outcome} · ${who}${e.attended === false ? " (unattended)" : ""}${reason}`;
}

export function pageText(page: HistoryPage): string {
  if (!page.items.length) return NONE;
  return [
    `${page.items.length} of ${page.total} events (newest first)${page.cursor ? `; more with cursor ${page.cursor}` : ""}${page.freshness.current ? "" : "; the index is still catching up"}:`,
    ...page.items.map(summaryLine),
  ].join("\n");
}

/** What a cited quote shows, and no more: found in its sender's message, or the recorder's reading, not checked (and why). */
function quoteClaim(ref: Extract<EvidenceRef, { kind: "transcript" }>): string {
  if (ref.check === "checked") return "quote found in the speaker's message (the statement is the recorder's wording)";
  const reasons: Partial<Record<QuoteCheck, string>> = { "quote-not-found": "The words weren't found in that message.", "speaker-mismatch": "Someone else sent that message.", "source-unavailable": "The message couldn't be read." };
  const why = ref.why ?? reasons[ref.check];
  return `quote not checked, the recorder's reading of what was said${why ? `: ${why}` : ""}`;
}

export function detailText(d: EventDetail): string {
  const r = d.rationale;
  const lines = [summaryLine(d.event)];
  if (d.event.boundary) return lines.join("\n");
  if (r?.what) lines.push(`What: ${r.what}`);
  lines.push(r?.reason ? `Recorded reason (${r.reason.contemporaneous ? "at the time" : "added later"}): ${r.reason.text}` : d.event.reasonState === "purged" ? "Reason purged." : "Reason not recorded.");
  for (const o of d.options) lines.push(`Option ${o.id}: ${o.label ?? "(label not readable)"} — ${o.outcome}${o.reason ? ` (${o.reason})` : ""}${o.condition ? ` until ${o.condition}` : ""}`);
  const a = d.event.actors;
  if (a) lines.push(`Initiated by ${actorWords(a.initiatedBy)}; decided by ${actorWords(a.decidedBy)}; recorded by ${actorWords(a.recordedBy)}; executed by ${actorWords(a.executedBy)}.`);
  for (const ev of d.evidence) lines.push(`Source [${ev.ref.n}] ${ev.ref.kind} · ${ev.availability}${ev.ref.kind === "transcript" ? ` · ${quoteClaim(ev.ref)}` : ""}${ev.quote ? `: "${ev.quote}"` : ""}`);
  lines.push(d.triggeredBy.length ? `Triggered by: ${d.triggeredBy.map((l) => `${l.event.id} (${l.via ?? l.type})`).join(", ")}` : "Trigger not recorded.");
  if (d.resultedIn.length) lines.push(`Resulted in: ${d.resultedIn.map((l) => `${l.event.id} (${l.via ?? l.type})`).join(", ")}`);
  if (d.related.length) lines.push(`Related: ${d.related.map((l) => `${l.event.id} (${l.type}, ${l.direction})`).join(", ")}`);
  if (d.event.superseded) lines.push(`Superseded ${iso(d.event.superseded.at)} — Open New Decision: ${d.event.superseded.by}.`);
  return lines.join("\n");
}

export function chainText(c: HistoryChain): string {
  const lines = [`Chain of ${c.root} (${c.nodes.length} events; ${c.omitted.before} earlier and ${c.omitted.after} later left out${c.cursor ? `, more with cursor ${c.cursor}` : ""}):`];
  // A node's position says only before or after; whether it is a cause says how it was reached, a relation by its type.
  const relType = (id: string) => c.edges.find((e) => e.link === "relation" && (e.from === id || e.to === id))?.type;
  const how = (n: HistoryChain["nodes"][number]) => (n.reached === "cause" ? (n.hop < 0 ? "cause" : "result") : `relation${relType(n.id) ? `: ${relType(n.id)}` : ""}`);
  for (const n of [...c.nodes].sort((a, b) => a.hop - b.hop)) lines.push(`${n.hop === 0 ? "*" : `${n.hop < 0 ? "before" : "after"} ${Math.abs(n.hop)} (${how(n)})`} ${summaryLine(n).slice(2)}`);
  for (const e of c.edges) lines.push(`${e.from} → ${e.to}: ${e.link === "cause" ? `cause (${e.via})` : `relation, ${e.type} (not a cause)`}`);
  if (c.noTrigger.length) lines.push(`Trigger not recorded: ${c.noTrigger.join(", ")}`);
  return lines.join("\n");
}

// ---- reading -----------------------------------------------------------------------------------------------

const ACTIONS = ["search", "event", "trace", "packet"] as const;

const historyParams = (withOrg: boolean) =>
  obj(
    {
      ...(withOrg ? { org: str("The organization, by id or exact name."), project: str("search/packet: only this project's events (id or exact name).") } : {}),
      action: str("search (a list), event (one event in full), trace (its recorded causes and results, and its recorded relations, each marked which), packet (one event's or a search's bounded context)", { enum: [...ACTIONS] }),
      q: str("search/packet: words in the headline, the recorded reason, a quote, an option's label or a review condition."),
      kind: { type: "array", items: { type: "string", enum: [...HISTORY_KINDS] }, description: "search/packet: only these kinds." },
      outcome: { type: "array", items: { type: "string", enum: [...HISTORY_OUTCOMES] }, description: "search/packet: only these outcomes." },
      from: str("search/packet: from this time (ISO)."),
      to: str("search/packet: up to this time (ISO)."),
      event: str("event/trace/packet: the event id (he_…)."),
      hops: { type: "integer", description: `trace: how far each way (1–${HISTORY_BOUNDS.hops}).` },
      cursor: str("search/trace: the cursor a previous result gave."),
      limit: { type: "integer", description: `search: at most this many (≤ ${HISTORY_BOUNDS.searchHits}).` },
    },
    withOrg ? ["org", "action"] : ["action"],
  );

const time = (name: string, v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) throw new Refusal(`${name} must be an ISO time.`);
  return t;
};

/** The search a tool call asks for. */
function queryOf(q: Record<string, unknown>, projects?: string[]): HistoryQuery {
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T[] | undefined => (Array.isArray(v) ? v.filter((x): x is T => allowed.includes(x as T)) : undefined);
  const from = time("from", q.from);
  const to = time("to", q.to);
  return {
    ...(projects ? { projects } : {}),
    ...(pick(q.kind, HISTORY_KINDS)?.length ? { kinds: pick(q.kind, HISTORY_KINDS) } : {}),
    ...(pick(q.outcome, HISTORY_OUTCOMES)?.length ? { outcomes: pick(q.outcome, HISTORY_OUTCOMES) } : {}),
    ...(typeof q.q === "string" && q.q.trim() ? { text: q.q.trim() } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(typeof q.cursor === "string" && q.cursor ? { cursor: q.cursor } : {}),
    ...(typeof q.limit === "number" ? { limit: Math.max(1, Math.min(HISTORY_BOUNDS.searchHits, Math.floor(q.limit))) } : {}),
  };
}

/** One history read for `reader`, as the tool's text: never a model call. `projects`: a search's filter. */
export function historyRead(orgId: string, reader: HistoryReader, q: Record<string, unknown>, projects?: string[]): string {
  const h = hostOf(orgId).history;
  const labels = modelLabels(orgId);
  const sources = orgSources(orgId);
  const action = String(q.action ?? "");
  const event = typeof q.event === "string" ? q.event.trim() : "";
  const need = () => {
    if (!event) throw new Refusal("Name the event (event: he_…).");
    return event;
  };
  const missing = "No such event in this scope.";
  let body: string;
  if (action === "search") body = pageText(h.search(reader, queryOf(q, projects), labels));
  else if (action === "event") {
    const d = h.event(reader, need(), {}, labels, sources);
    if (!d) throw new Refusal(missing);
    body = detailText(d);
  } else if (action === "trace") {
    const hops = typeof q.hops === "number" ? Math.max(1, Math.min(HISTORY_BOUNDS.hops, Math.floor(q.hops))) : undefined;
    const c = h.trace(reader, need(), { ...(hops ? { hops } : {}), ...(typeof q.cursor === "string" && q.cursor ? { cursor: q.cursor } : {}) }, labels);
    if (!c) throw new Refusal(missing);
    body = chainText(c);
  } else if (action === "packet") {
    const p = event ? h.packet(reader, { event }, labels, sources) : h.packet(reader, { query: queryOf(q, projects) }, labels, sources);
    if (!p) throw new Refusal(missing);
    body = p.text || NONE;
  } else throw new Refusal(`action is one of ${ACTIONS.join(", ")}.`);
  return untrusted("the organization's history (what was recorded, by whom and why)", body);
}

// ---- deciding ----------------------------------------------------------------------------------------------

/** The adapter of an overseer's own decision (sova_decide): the only kind sova_decide may supersede. */
export const DECIDE_ADAPTER = "sova_decide";

const DISPOSITIONS = ["choose", "reject", "defer", "do-not-do"] as const;
const OUTCOME_OF = { choose: "chosen", reject: "rejected", defer: "deferred", "do-not-do": "do-not-do" } as const;
const OPTION_OUTCOMES = ["selected", "rejected", "deferred", "do-not-do"] as const;

/** The refusal for superseding a decision sova_decide didn't record as an overseer's own (coordinator ruling): a
    person's or the operator's decision is theirs to change. */
export const SUPERSEDE_REFUSAL = "That decision was made by a person or the operator: only they change it. Record your own decision without superseding it, and raise a card if theirs should change.";

/** sova_decide's input, checked: the history input of an overseer's own decision. Pure but for `superseded`. */
export function decisionInput(
  q: Record<string, unknown>,
  ctx: { projectId: string; overseerId: string; attended: boolean; level: string; lookRun?: string; toolCallId: string },
  superseded: (id: string) => { decidedBy: ActorRef | Unknown; adapter: string } | null,
): HistoryInput {
  const disposition = q.disposition;
  if (!DISPOSITIONS.includes(disposition as (typeof DISPOSITIONS)[number])) throw new Refusal(`disposition is one of ${DISPOSITIONS.join(", ")}.`);
  const d = disposition as (typeof DISPOSITIONS)[number];
  const what = typeof q.what === "string" ? q.what.trim().slice(0, 500) : "";
  const reason = typeof q.reason === "string" ? q.reason.trim().slice(0, 500) : "";
  if (!what) throw new Refusal("Say what you decided in one sentence (what).");
  if (!reason) throw new Refusal("Say why (reason): a decision is recorded with its reason.");
  const options: NonNullable<HistoryInput["rationale"]>["options"] = [];
  const body: DecisionBody["options"] = [];
  if (q.options !== undefined) {
    if (!Array.isArray(q.options)) throw new Refusal("options is a list.");
    for (const o of q.options.slice(0, 12)) {
      const x = isObj(o) ? o : {};
      const label = typeof x.label === "string" ? x.label.trim().slice(0, 200) : "";
      if (!label) throw new Refusal("Each option needs a label.");
      if (!OPTION_OUTCOMES.includes(x.outcome as (typeof OPTION_OUTCOMES)[number])) throw new Refusal(`Each option's outcome is one of ${OPTION_OUTCOMES.join(", ")}.`);
      const id = `o${body.length + 1}`;
      body.push({ id, outcome: x.outcome as (typeof OPTION_OUTCOMES)[number] });
      options.push({ id, label, ...(typeof x.reason === "string" && x.reason.trim() ? { reason: x.reason.trim().slice(0, 500) } : {}) });
    }
  }
  const review = typeof q.review === "string" ? q.review.trim().slice(0, 300) : "";
  if (d === "defer" && !review) throw new Refusal("A deferral says when or on what condition to look again (review).");
  const reviewAt = /^\d{4}-\d{2}-\d{2}/.test(review) && Number.isFinite(Date.parse(review)) ? Date.parse(review) : undefined;
  const supersedes = typeof q.supersedes === "string" ? q.supersedes.trim() : "";
  if (supersedes) {
    const target = superseded(supersedes);
    if (!target) throw new Refusal("No such decision in this project.");
    // Only an overseer's own decision, recorded by sova_decide: a gathering's decision is a person's, whatever
    // its decidedBy reads (an unchecked quote stays the model's, but the decision is still theirs).
    const by = target.decidedBy;
    if (target.adapter !== DECIDE_ADAPTER || isUnknown(by) || !["project-overseer", "global-overseer"].includes((by as ActorRef).kind)) throw new Refusal(SUPERSEDE_REFUSAL);
  }
  const gap = typeof q.gap === "string" && q.gap.trim() ? q.gap.trim() : "";
  const po: ActorRef = { kind: "project-overseer", id: ctx.projectId, ...(ctx.overseerId ? { session: ctx.overseerId } : {}) };
  return {
    kind: "decision.recorded",
    outcome: OUTCOME_OF[d],
    projects: { primary: ctx.projectId },
    entities: gap ? [{ type: "gap", id: gap }] : [],
    actors: {
      // An attended turn is the operator's message; an unattended one was started by its look (its trigger).
      initiatedBy: ctx.attended ? { kind: "operator" } : { unknown: true, why: "Started by its trigger." },
      decidedBy: po,
      recordedBy: po,
      executedBy: { kind: "sova" },
      authorization: ctx.attended ? { kind: "attended-turn", attended: true, level: ctx.level } : { kind: "autonomy-level", attended: false, level: ctx.level },
    },
    source: { adapter: DECIDE_ADAPTER, version: 1, key: `decide:${ctx.overseerId}:${ctx.toolCallId}` },
    ...(ctx.lookRun ? { parentKeys: [{ key: `invoke:${ctx.lookRun}`, via: "invocation" as const, optional: true }] } : {}),
    ...(supersedes ? { relations: [{ type: "supersedes" as const, target: { event: supersedes } }] } : {}),
    decision: { disposition: d, options: body, authority: po, ...(gap ? { scope: [{ type: "gap", id: gap }] } : {}), ...(reviewAt ? { reviewAt } : {}) },
    policy: { attended: ctx.attended, inForce: ctx.level },
    rationale: {
      what,
      reason: { text: reason, author: po, contemporaneous: true },
      ...(options.length ? { options: options.map((o) => (d === "defer" && review && body.find((b) => b.id === o.id)?.outcome === "deferred" ? { ...o, condition: review } : o)) } : {}),
    },
  };
}

/**
 * A tool whose result, partial results and error carry no contact value of the org's roster: each becomes
 * `[contact]`. The history's reads scrub their text already; this holds for anything else a result carries.
 */
function contactFree(tool: ToolSpec): ToolSpec {
  const clean = <R>(r: ReturnType<typeof contactRedactor>, out: R): R => {
    if (!out || typeof out !== "object") return out;
    const res = out as { content?: unknown; details?: unknown };
    const content = Array.isArray(res.content) ? res.content.map((b: { type?: string; text?: unknown }) => (b?.type === "text" && typeof b.text === "string" ? { ...b, text: r.text(b.text) } : b)) : res.content;
    return { ...out, content, details: r.deep(res.details) } as R;
  };
  const run = tool.execute as (...a: unknown[]) => Promise<unknown>;
  return {
    ...tool,
    execute: (async (id: string, params: unknown, signal?: AbortSignal, onUpdate?: (p: unknown) => void, ctx?: unknown) => {
      try {
        return clean(contactRedactor(), await run(id, params, signal, onUpdate && ((p: unknown) => onUpdate(clean(contactRedactor(), p))), ctx));
      } catch (err) {
        if (err instanceof Error) err.message = contactRedactor().text(err.message);
        throw err;
      }
    }) as ToolSpec["execute"],
  };
}

/** The project overseer's history tools for `orgId`'s placed project. */
export function historyTools(orgId: string, ctx: OverseerToolCtx): ToolSpec[] {
  const reader: HistoryReader = { role: "project-overseer", project: ctx.projectId };
  return ([
    {
      name: "sova_history",
      label: "History",
      description:
        "Read the organization's history of this project: what was requested, decided (including decisions not to do something), held, refused, built and merged, by whom, why as recorded at the time, and what led to what. " +
        "search lists events; event reads one in full with its sources; trace follows its recorded causes and results and its recorded relations, each marked cause or relation (a relation is never a cause); packet gives one event's or a search's bounded context. Events of other projects show only as linked boundary cards.",
      promptSnippet: "read this project's recorded history: who decided what and why, and what it led to",
      parameters: historyParams(false),
      execute: ctx.read(async (q) => ({ content: text(historyRead(orgId, reader, q)), details: {} })),
    } as unknown as ToolSpec,
    {
      name: "sova_decide",
      label: "Record decision",
      description:
        "Record a decision of your own in the organization's history, with your reason: to choose, reject or defer something, or not to do it (an abstention is a decision too). " +
        "It changes nothing else: it is what a later reader sees as why. Name the options you weighed. A person's or the operator's decision is never yours to supersede.",
      promptSnippet: "record your own decision (or a decision not to act) with its reason, in the org's history",
      parameters: obj(
        {
          disposition: str("choose, reject, defer (put off until review) or do-not-do", { enum: [...DISPOSITIONS] }),
          what: str("What you decided, in one sentence."),
          reason: str("Why, in one or two sentences."),
          options: { type: "array", description: "The options you weighed.", items: obj({ label: str("The option."), outcome: str("selected | rejected | deferred | do-not-do", { enum: [...OPTION_OUTCOMES] }), reason: str("Why, for this option.") }, ["label", "outcome"]) },
          gap: str("The gap it is about (§gap/…), when there is one."),
          review: str("defer: when (YYYY-MM-DD) or on what condition to look again."),
          supersedes: str("An earlier decision of yours this replaces (he_…)."),
        },
        ["disposition", "what", "reason"],
      ),
      execute: ctx.act("sova_decide", async (q, toolCallId) => {
        const env = ctx.envelope() as Record<string, unknown>;
        const host = hostOf(orgId);
        const input = decisionInput(
          q,
          { projectId: ctx.projectId, overseerId: ctx.overseerId(), attended: ctx.attended(), level: ctx.effective().autonomy, ...(typeof env.lookRun === "string" ? { lookRun: env.lookRun } : {}), toolCallId },
          (id) => {
            const d = host.history.event(reader, id, {}, modelLabels(orgId));
            return d?.record && !d.event.boundary && d.record.kind === "decision.recorded" ? { decidedBy: d.record.actors.decidedBy, adapter: d.record.source.adapter } : null;
          },
        );
        const [id] = await host.record([input]);
        return { content: text(`Recorded ${id}: ${KIND_HEADLINES["decision.recorded"]} · ${OUTCOME_WORDS[input.outcome]}.`), details: { event: id, note: `Decided (${input.decision!.disposition}): ${input.rationale!.what}` } };
      }),
    } as unknown as ToolSpec,
  ] as ToolSpec[]).map(contactFree);
}

/** The org that places `projectId` on `engine`, or null (a standalone project has no org history). */
function placedIn(engine: string, projectId: string): string | null {
  if (!readIndex().orgs.some((o) => o.id === engine) || !isOrgHostOpen(engine)) return null;
  return hostOf(engine).data(placementSid(engine, projectId)) ? engine : null;
}

contributeProjectPart({
  overseerTools: (ctx) => {
    const orgId = placedIn(ctx.engine, ctx.projectId);
    return orgId ? historyTools(orgId, ctx) : [];
  },
});

// ---- the global Overseer ------------------------------------------------------------------------------------

/** Why the global Overseer may not read an org's history now, or null: only in a turn the operator started. */
export const ORG_HISTORY_UNATTENDED = "The organization's history is read only in a turn the operator started: ask them.";

/** sova_org_history's parameters (the global Overseer names the org, and may name one project). */
export const orgHistoryParams = () => historyParams(true);

/** sova_org_history: the whole org's history for the global Overseer, when the operator's turn asks for it. */
export function orgHistoryRead(q: Record<string, unknown>, attended: boolean): string {
  if (!attended) throw new Refusal(ORG_HISTORY_UNATTENDED);
  try {
    const org = resolveOrg(q.org);
    const projects = typeof q.project === "string" && q.project.trim() ? [resolveProject(org.id, q.project).id] : undefined;
    return historyRead(org.id, { role: "global-overseer" }, q, projects);
  } catch (err) {
    if (err instanceof ViewRefusal) throw new Refusal(err.message);
    throw err;
  }
}
