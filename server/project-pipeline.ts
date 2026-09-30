import type { AttentionItem } from "../shared/protocol";
import type { HeldAct, PipelineBuild, PipelineDecision, PipelineGathering, PipelineInfo, PipelineRow, PipelineTimeline, TimelineRow } from "../shared/pipeline";
import { OPERATOR } from "../shared/baton";
import { batonById, namesOf, sessionPathOf } from "./baton";
import { buildSessionPath, readBuild } from "./build-loadout";
import type { Hold } from "./org-charts";
import { actOrThrow, hostOf, isOrgHostOpen } from "./org-engine";
import { OrgError } from "./org-error";
import type { LogRow } from "./org-host/log";
import { operatorEnvelope, readIndex, readOrg, readProjects, type OperatorBy } from "./orgs";
import { readManifest } from "./overseer-ideas";
import { projectOverseerPaths } from "./project-overseer-store";
import { listDecisions } from "./reconcile";

/**
 * A project's Pipeline and the acts waiting in a hold (§app.project-overseer/pipeline, /holds), read from
 * the engine host: one row per gap (its item chart's lane state, time in it, stalled, its gatherings,
 * decisions and builds), the holds of the project's sessions, an item's timeline from the transition log,
 * and the operator's Hold / Resume / Cancel as chart acts. Plain reads; nothing is written here.
 */

/** The item chart's lane states, in lane order (the Pipeline's phase ids). */
const LANE = ["open", "gather-starting", "asking", "needs-operator", "unreconciled", "conflicted", "drafted", "spec-edited", "awaiting-build", "build-starting", "working", "idle", "failed", "merged", "done", "on-hold", "dropped"];
const FOLLOW_UP = ["follow-up-asking", "follow-up-needs-operator"];
/** A waiting phase is stalled after this long, unless the item's start data says otherwise (the chart's default). */
const DEFAULT_STALL_MS = 3 * 24 * 3_600_000;

const itemSid = (orgId: string, projectId: string, itemId: string) => `item/${orgId}/${projectId}/${itemId}`;
const iso = (ms: unknown): string => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const last = (sid: string) => sid.split("/").at(-1) ?? sid;

function knownProject(orgId: string, projectId: string): void {
  if (!readProjects(orgId).some((x) => x.id === projectId)) throw new OrgError("Unknown project", 404);
}

/** The lane state among `states` (the deepest lane id the configuration holds), or "". */
const laneOf = (states: readonly string[]): string => [...LANE].reverse().find((s) => states.includes(s)) ?? "";

// ---- held acts ----------------------------------------------------------------------------------------

/** A hold's project: the one it was stamped for, else its session's. */
function projectOfHold(h: Hold): string {
  return h.projectId ?? h.sessionId.split("/")[2] ?? "";
}

/** The person an hours wait waits for, by display name (the act's stamped target). */
function personOf(orgId: string, h: Hold): string | undefined {
  const t = obj(h.data?.["target"]);
  const id = typeof t["id"] === "string" ? t["id"] : typeof h.data?.["to"] === "string" ? (h.data["to"] as string) : "";
  const name = typeof t["name"] === "string" ? t["name"] : id ? namesOf(orgId)[id] : undefined;
  return name || undefined;
}

/** A gap's title (its idea's), else its id. */
function gapTitle(orgId: string, projectId: string, ideaId: string): string {
  try {
    return readManifest(projectOverseerPaths(orgId, projectId).ideas).ideas[ideaId]?.title || ideaId;
  } catch {
    return ideaId;
  }
}

/**
 * What a held act is, as the operator reads it (Needs you, the Pipeline): who it reaches and about what,
 * never a gap's id (the row already opens the project). The chart's own `what` (kept for the overseer) when
 * the act reaches no one.
 */
export function heldWhat(orgId: string, h: Hold): string {
  const d = obj(h.data);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const projectId = projectOfHold(h);
  const ideaId = h.sessionId.startsWith("item/") && isOrgHostOpen(orgId) ? str(hostOf(orgId).data(h.sessionId)?.["ideaId"]) : "";
  const about = str(d["publicTitle"]) || (ideaId ? gapTitle(orgId, projectId, ideaId) : "");
  const tail = about ? `: ${about}` : "";
  if (h.event === "gather/start" || h.event === "baton/start") {
    const targets = Array.isArray(d["targets"]) ? d["targets"] : [];
    if (targets.length >= 2) return `An offer to ${targets.length} people${tail}`;
    const to = str(d["to"]) || str(obj(d["target"])["id"]);
    if (to === OPERATOR) return `A gathering with you${tail}`;
    const who = personOf(orgId, h);
    return who ? `A gathering with ${who}${tail}` : `A gathering${tail}`;
  }
  if (h.event === "build/start" && ideaId) return `A coding session for ${gapTitle(orgId, projectId, ideaId)}`;
  return h.what || "An act";
}

function heldActOf(orgId: string, h: Hold): HeldAct {
  const projectId = projectOfHold(h);
  const itemId = h.sessionId.startsWith("item/") ? last(h.sessionId) : undefined;
  const ideaId = itemId && isOrgHostOpen(orgId) ? hostOf(orgId).data(h.sessionId)?.["ideaId"] : undefined;
  const person = h.wait === "hours" ? personOf(orgId, h) : undefined;
  return {
    id: h.id,
    orgId,
    projectId,
    ...(itemId ? { itemId } : {}),
    ...(typeof ideaId === "string" ? { gap: ideaId } : {}),
    what: heldWhat(orgId, h),
    kind: h.kind,
    goesAt: iso(h.until),
    since: iso(h.since),
    ...(h.by === "overseer" || h.by === "chart" ? { by: h.by } : {}),
    ...(h.wait === "hours" ? { wait: "hours" as const, ...(person ? { person } : {}) } : {}),
    ...(h.waiting ? { reviewSince: iso(h.until) } : {}),
  };
}

/** The org's acts waiting in a hold (of one project, when given), soonest first. */
export function heldActs(orgId: string, projectId?: string): HeldAct[] {
  if (!isOrgHostOpen(orgId)) return [];
  return hostOf(orgId)
    .holds()
    .filter((h) => h.act !== false && (!projectId || projectOfHold(h) === projectId))
    .sort((a, b) => a.until - b.until)
    .map((h) => heldActOf(orgId, h));
}

/**
 * The held acts as Needs-you items (r2): act tier, kind `held-act`, never pushed, linked to the project
 * page; the row recounts "{what} starts in {n} min unless you cancel it." from `held`.
 */
export function heldAttention(): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const o of readIndex().orgs) {
    if (!isOrgHostOpen(o.id)) continue;
    let orgName = "";
    let projects: { id: string; name: string; archived?: unknown }[] = [];
    try {
      orgName = readOrg(o.id).name;
      projects = readProjects(o.id);
    } catch {
      continue;
    }
    for (const h of heldActs(o.id)) {
      const p = projects.find((x) => x.id === h.projectId);
      const goesAt = Date.parse(h.goesAt);
      out.push({
        id: `held-act:${h.id}`,
        path: "",
        title: p?.name ?? orgName,
        where: orgName,
        tier: "act",
        kind: "held-act",
        since: Date.parse(h.since) || 0,
        detail:
          h.wait === "hours"
            ? `${h.what} waits for ${h.person ?? "the person"}'s working hours: it starts in ${Math.max(0, Math.ceil((goesAt - Date.now()) / 60_000))} min unless you cancel it.`
            : `${h.what} starts in ${Math.max(0, Math.ceil((goesAt - Date.now()) / 60_000))} min unless you cancel it.`,
        href: p ? `#/orgs/${encodeURIComponent(o.id)}/projects/${encodeURIComponent(p.id)}` : `#/orgs/${encodeURIComponent(o.id)}`,
        org: { orgId: o.id, orgName, ...(p ? { projectId: p.id, projectName: p.name, ...(p.archived ? { projectArchived: true as const } : {}) } : {}) },
        held: {
          id: h.id,
          goesAt,
          what: h.what,
          ...(h.wait ? { wait: h.wait } : {}),
          ...(h.person ? { person: h.person } : {}),
          ...(h.reviewSince ? { reviewSince: Date.parse(h.reviewSince) } : {}),
        },
      });
    }
  }
  return out;
}

/** The operator's Cancel: `hold/cancel` on the hold's session (a declared correction). 404 unknown; the chart's
    sentence when it already went ahead. */
export async function cancelHeld(orgId: string, holdId: string, reason: string | undefined, by?: OperatorBy): Promise<void> {
  const h = isOrgHostOpen(orgId) ? hostOf(orgId).holds().find((x) => x.id === holdId) : undefined;
  if (!h) throw new OrgError("That act is no longer held: it went ahead or was cancelled.", 404);
  await actOrThrow(orgId, h.sessionId, "hold/cancel", { id: holdId, ...(reason ? { reason } : {}) }, operatorEnvelope(orgId, projectOfHold(h) || null, by), { settle: true });
}

// ---- the Pipeline ---------------------------------------------------------------------------------------

function gatheringOf(sid: string, names: Record<string, string>): PipelineGathering | null {
  const hit = batonById(last(sid));
  if (!hit) return null;
  const r = hit.row;
  const holder = r.state === "done" || r.state === "closed" ? null : r.holder === OPERATOR ? "the operator" : r.holder ? (names[r.holder] ?? r.holder) : null;
  const path = sessionPathOf(hit.dir, r);
  return { sessionId: r.sessionId, ...(path ? { path } : {}), title: r.publicTitle, state: r.state, holder };
}

function buildOf(orgId: string, projectId: string, sid: string, fact: Record<string, unknown>): PipelineBuild {
  const sessionId = last(sid);
  const row = readBuild(orgId, projectId, sessionId);
  const exported = obj(fact["exported"]);
  const branch = exported["branchState"];
  const path = buildSessionPath(sessionId);
  return {
    sessionId,
    ...(path ? { path } : {}),
    title: row?.title || sessionId,
    turn: row?.turn ?? "idle",
    ...(branch === "no-commits" || branch === "unmerged" || branch === "merged" || branch === "new-since-merge" ? { branch } : {}),
  };
}

/** Where a gap stands, one row per item of the project (dropped ones left out). */
export function pipelineInfo(orgId: string, projectId: string): PipelineInfo {
  knownProject(orgId, projectId);
  const host = isOrgHostOpen(orgId) ? hostOf(orgId) : null;
  const rows: PipelineRow[] = [];
  if (host) {
    const names = namesOf(orgId);
    const ideas = readManifest(projectOverseerPaths(orgId, projectId).ideas).ideas;
    let decisionRows: { id: string; statement: string; state: string }[] = [];
    try {
      decisionRows = listDecisions(orgId, projectId).decisions;
    } catch {
      // an index that can't be read: the rows show the chart's states only
    }
    for (const s of host.sessions("item")) {
      const d = s.data;
      if (d["projectId"] !== projectId || !s.running) continue;
      const phase = laneOf(s.configuration) || String(d["phase"] ?? "open");
      if (phase === "dropped") continue;
      const ideaId = String(d["ideaId"] ?? "");
      const since = typeof d["phaseSince"] === "number" ? (d["phaseSince"] as number) : 0;
      const stallMs = Number(obj(d["stallAfterMs"])[phase]) || DEFAULT_STALL_MS;
      const enabled = new Set(host.enabledEvents(s.id, operatorEnvelope(orgId, projectId)).filter((e) => e.enabled).map((e) => e.event));
      const decisions: PipelineDecision[] = Object.entries(obj(d["decisions"])).map(([id, f]) => {
        const row = decisionRows.find((x) => x.id === id);
        return { id, statement: row?.statement ?? "", state: row?.state ?? String(obj(obj(f)["exported"])["state"] ?? "pending") };
      });
      const followUp = FOLLOW_UP.find((x) => s.configuration.includes(x));
      rows.push({
        itemId: s.id.split("/").at(-1)!,
        gap: ideaId,
        title: ideas[ideaId]?.title ?? ideaId,
        phase,
        since: iso(since),
        ...(s.configuration.includes("stalled") ? { stalled: { since: iso(since + stallMs) } } : {}),
        ...(phase === "on-hold" ? { held: { since: iso(since), from: heldFrom(orgId, s.id) } } : {}),
        ...(followUp ? { followUp } : {}),
        gatherings: Object.keys(obj(d["batons"]))
          .map((sid) => gatheringOf(sid, names))
          .filter((g): g is PipelineGathering => !!g),
        decisions,
        builds: Object.entries(obj(d["builds"])).map(([sid, f]) => buildOf(orgId, projectId, sid, obj(f))),
        canHold: enabled.has("item/hold"),
        canResume: enabled.has("item/resume"),
      });
    }
  }
  rows.sort((a, b) => a.since.localeCompare(b.since));
  return { rows, held: heldActs(orgId, projectId) };
}

/** The lane state an on-hold item left (Resume returns to it): the log row that put it on hold. */
function heldFrom(orgId: string, sid: string): string {
  const rows = hostOf(orgId).log.rows({ session: sid, newestFirst: true });
  const r = rows.find((x) => !x.refused && x.after.includes("on-hold") && !x.before.includes("on-hold"));
  return r ? laneOf(r.before) : "";
}

/** The operator's Hold or Resume on a gap (the item chart's item/hold, item/resume). */
export async function holdItem(orgId: string, projectId: string, itemId: string, resume: boolean, by?: OperatorBy): Promise<PipelineInfo> {
  knownProject(orgId, projectId);
  const sid = itemSid(orgId, projectId, itemId);
  if (!isOrgHostOpen(orgId) || !hostOf(orgId).configuration(sid)) throw new OrgError("Unknown item", 404);
  await actOrThrow(orgId, sid, resume ? "item/resume" : "item/hold", {}, operatorEnvelope(orgId, projectId, by), { settle: true });
  return pipelineInfo(orgId, projectId);
}

// ---- an item's timeline -------------------------------------------------------------------------------------

/** What happened, in a sentence (the log keeps event names; the page reads this). A chart's own sentence
    (`<chart>:<event>`) comes before the event's. */
export const LINES: Record<string, string> = {
  "item:sova/started": "The overseer filed this gap.",
  "baton:sova/started": "The gathering session opened.",
  "build:sova/started": "The coding session opened.",
  "decision:sova/started": "A decision was recorded.",
  "gap/file": "The gap was filed.",
  "gap/drop": "The gap was dropped.",
  "gather/start": "A gathering started.",
  "gather/plan": "A gathering was planned.",
  "build/start": "A coding session started.",
  "item/hold": "The operator put it on hold.",
  "item/resume": "The operator resumed it.",
  "item/stalled": "It stalled.",
  "item/adopt": "A session joined it.",
  "hold/cancel": "A held act was cancelled.",
  "hold/approve": "A held act was approved early.",
  "hold/released": "A held act went ahead.",
  "hold/waiting": "A held act waits for the overseer's review.",
  "correct/reopen": "It was reopened.",
  "correct/skip-stall": "A stalled step was skipped.",
  "correct/relink": "A session was moved to another gap.",
  "correct/merged": "Its branch was marked merged by hand.",
  "session/retire": "The session was retired: the project keeps the 200 sessions it started most recently, and this one was finished.",
  "sova/set-state": "Its state was set by hand.",
  "reconcile/request": "The decisions were reconciled.",
  "decision/promote": "Decisions were promoted.",
  // a gathering
  "baton/abilities": "The gathering's abilities were changed.",
  "baton/close": "The gathering was closed.",
  "baton/extend": "The gathering's message limit was raised.",
  "baton/goal-done": "The gathering's goal was met.",
  "baton/hand-to": "The gathering was handed on.",
  "baton/handoff": "The gathering was handed on.",
  "baton/hide": "The gathering was hidden from the owner.",
  "baton/message": "A message was written in the gathering.",
  "baton/offer": "The gathering was offered to several people.",
  "baton/withdraw": "The offer was withdrawn.",
  "baton/propose": "Someone new was proposed in the gathering.",
  "baton/record-decision": "A decision was recorded in the gathering.",
  "baton/take-back": "The operator took the gathering back.",
  "baton/wrapup-retry": "The gathering's wrap-up was retried.",
  "lease/lapse": "The holder's turn in the gathering lapsed.",
  "person/left": "The gathering's holder left the organization.",
  "wrapup/finished": "The gathering's wrap-up finished.",
  "wrapup/overdue": "The gathering's wrap-up is overdue.",
  "wrapup/stopped": "The gathering's wrap-up stopped.",
  // a coding session
  "build/merge": "Merge Branch was pressed.",
  "build/prompt": "The coding session was sent a prompt.",
  "build/remove-worktree": "The coding session's worktree is being removed.",
  "tree/removed": "The coding session's worktree was removed.",
  "git/probe": "Git was checked for the branch.",
  "build:effect/failed": "Something the coding session tried failed.",
  // a decision
  "decision/owner-area": "A decision's owner area was changed.",
  "decision/settle-text": "A decision edited in the spec was settled.",
  "reconcile/result": "A decision was reconciled.",
  "promote/done": "A decision was promoted.",
  "decision:effect/failed": "A decision's step failed.",
};

/** A row's sentence: a refusal, a hold, the chart's or event's own, else the lane move; null for bookkeeping. */
function lineOf(r: LogRow, from?: string, to?: string, held?: string): string | null {
  if (r.refused) return `Refused: ${r.refused}`;
  if (r.held) return `${held || r.held.what || "An act"} was held.`;
  return LINES[`${r.chart ?? ""}:${r.event}`] ?? LINES[r.event] ?? (from && to ? `It moved from ${from} to ${to}.` : null);
}

/** An item's rows from the org's transition log, oldest first: its own and its sessions'. */
export function itemTimeline(orgId: string, projectId: string, itemId: string, opts: { includeQuiet?: boolean } = {}): PipelineTimeline {
  knownProject(orgId, projectId);
  const sid = itemSid(orgId, projectId, itemId);
  if (!isOrgHostOpen(orgId)) throw new OrgError("Unknown item", 404);
  const host = hostOf(orgId);
  const d = host.data(sid);
  if (!d) throw new OrgError("Unknown item", 404);
  const sessions = [sid, ...Object.keys(obj(d["batons"])), ...Object.keys(obj(d["builds"])), ...Object.keys(obj(d["decisions"])).map((id) => `decision/${orgId}/${projectId}/${id}`)];
  const names = namesOf(orgId);
  const holds = new Map(host.holds().map((h) => [h.id, h]));
  const rows: TimelineRow[] = host.log
    .rows({ sessions })
    .map((r) => {
      const from = r.session === sid ? laneOf(r.before) : "";
      const to = r.session === sid ? laneOf(r.after) : "";
      const moved = !!(from && to && from !== to);
      const h = r.held ? holds.get(r.held.id) : undefined;
      return { r, from, to, moved, line: lineOf(r, moved ? from : undefined, moved ? to : undefined, h ? heldWhat(orgId, h) : undefined) };
    })
    // Bookkeeping with no sentence (a fact mirror, a flush, an effect's answer) is quiet, never a raw event name.
    .filter(({ r, line }) => opts.includeQuiet || (line !== null && (r.feed !== "quiet" || r.session === sid)))
    .map(({ r, from, to, moved, line }) => {
      const by = r.by === "operator" || r.by === "overseer" || r.by === "chart" || !r.by ? (r.by ?? "chart") : (names[r.by] ?? r.by);
      return {
        at: iso(r.at),
        event: r.event,
        by,
        ...(r.via ? { via: r.via } : {}),
        ...(moved ? { from, to } : {}),
        line: line ?? "Sova kept its records up to date.",
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.refused ? { refused: r.refused } : {}),
        ...(r.feed === "quiet" || line === null ? { quiet: true } : {}),
      };
    });
  return { itemId, rows };
}
