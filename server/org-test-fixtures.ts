/**
 * Test fixtures for the org statecharts (tests only; nothing in the server imports this): states the
 * statecharts reach through runs and acts, started directly so a test can begin from them.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { BATON_DECISION_ENTRY } from "../shared/baton";
import type { Conflict } from "../shared/decisions";
import { batonById, batonOfPath } from "./baton";
import { areaKeyOf, conflictSid, ownerAreaChoices } from "./decisions";
import { buildSetupEnded, buildSid, seedBuildEffectsForTest, type BuildKind } from "./build-loadout";
import { envelopeFor, hostOf, setOrgClockForTest } from "./org-engine";
import { operatorName, readRoster } from "./orgs";
import { projectSid, watchSid } from "./projects/sids";

/**
 * Conflicts as today's rows said them: open with a settle session (`batonSessionId`: its baton is
 * started, as the conflict statechart does), open with none (unrouted: nobody is asked), or resolved.
 */
export async function seedConflicts(orgId: string, projectId: string, conflicts: Conflict[], opts: { owner?: "operator" | { overseerOf: string } } = {}): Promise<Record<string, string | undefined>> {
  const sessions: Record<string, string | undefined> = {};
  const host = hostOf(orgId);
  const names = new Map(readRoster(orgId).map((p) => [p.id, p.name]));
  for (const c of conflicts) {
    const side = (id: string) => ({ id, by: "operator", name: operatorName(), statement: id, quote: id, at: Date.parse(c.createdAt) });
    const asked = c.state === "open" && !!c.batonSessionId;
    // The conflict statechart starts its own settle session: an id another session has already gets a fresh one.
    const batonSessionId = asked ? (c.batonSessionId && !batonById(c.batonSessionId) ? c.batonSessionId : randomUUID()) : undefined;
    sessions[c.id] = batonSessionId;
    const r = await host.start(
      conflictSid(orgId, projectId, c.id),
      "conflict",
      {
        orgId,
        projectId,
        id: c.id,
        area: c.areaKey,
        areaKey: c.areaKey,
        ...(c.ownerArea ? { ownerArea: c.ownerArea } : {}),
        a: side(c.a),
        b: side(c.b),
        p: c.p,
        routedTo: c.routedTo,
        routedToName: names.get(c.routedTo) ?? operatorName(),
        routeReason: c.routeReason,
        ...(c.selfAsserted ? { selfAsserted: true } : {}),
        ...(batonSessionId ? { batonSessionId } : { routeError: "not routed" }),
        owner: opts.owner ?? "operator",
        operatorName: operatorName(),
        createdAt: Date.parse(c.createdAt),
      },
      { by: "system" },
    );
    await host.settle(r);
    // What a run tells its sides: each is in the conflict while it is open.
    if (c.state === "open")
      for (const id of [c.a, c.b])
        if (host.data(`decision/${orgId}/${projectId}/${id}`)) await host.act(`decision/${orgId}/${projectId}/${id}`, "reconcile/result", { state: "conflict" }, { by: "system" }, { settle: true });
    if (c.state === "resolved")
      await host.act(conflictSid(orgId, projectId, c.id), "conflict/resolved", { outcome: c.outcome ?? "a", resolvedBy: c.resolvedBy ?? c.a }, { by: "system" }, { settle: true });
  }
  return sessions;
}

/**
 * A decision as record_decision makes it (§app.requirements/decisions): its transcript entry, then the
 * gathering session's `baton/record-decision` (by its model, for whoever holds the session), at `at`
 * when given (the org hosts' clock is set for the act). Returns the decision's id.
 */
export async function recordDecision(path: string, d: { area: string; ownerArea?: string; statement: string; quote: string }, at?: string): Promise<string> {
  const hit = batonOfPath(path);
  if (!hit) throw new Error(`No gathering session at ${path}`);
  const { orgId, projectId, sessionId } = hit.row;
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id?: string; type?: string; message?: { role?: string } });
  const parentId = lines.at(-1)!.id!;
  // The quote's location: the nearest user message before it (quoteEntryOf).
  const quoteEntry = [...lines].reverse().find((e) => e.type === "message" && e.message?.role === "user")?.id ?? parentId;
  const markerId = `d${(++decisionSeq).toString(16).padStart(7, "0")}`;
  const ts = at ?? new Date().toISOString();
  appendFileSync(path, `${JSON.stringify({ type: "custom", id: markerId, parentId, timestamp: ts, customType: BATON_DECISION_ENTRY, data: { v: 1, ...d, by: hit.row.holder ?? "operator" } })}\n`);
  if (at) setOrgClockForTest(() => Date.parse(at));
  try {
    const out = await hostOf(orgId).act(
      `baton/${orgId}/${sessionId}`,
      "baton/record-decision",
      { decisionId: `${sessionId}:${markerId}`, area: d.area, areaKey: areaKeyOf(d.area), ownerArea: d.ownerArea ?? "none", statement: d.statement, quote: d.quote, entryId: quoteEntry, markerId, ownerAreas: ownerAreaChoices(readRoster(orgId)) },
      envelopeFor(orgId, projectId, { by: "model", attended: false }),
      { settle: true },
    );
    if (!out.taken) throw new Error(out.refusal?.sentence ?? "refused");
  } finally {
    if (at) setOrgClockForTest(null);
  }
  return `${sessionId}:${markerId}`;
}
let decisionSeq = 0;

/**
 * A coding session of the project (a build), as its setup left it: in its worktree (`worktree`, its
 * folder where the test says) or in the root (`inRoot`), its session file at `path` (or on another
 * host), then merged or its worktree removed when asked. Its effects touch no git and write no file.
 */
export async function seedBuild(
  orgId: string,
  projectId: string,
  b: {
    sessionId: string;
    kind: BuildKind;
    path?: string;
    title?: string;
    via?: "overseer";
    createdAt?: string | number;
    worktree?: { path?: string; branch: string; base: string; target: string };
    inRoot?: string;
    merged?: { commit: string; at?: string };
    removed?: { branchDeleted?: boolean; at?: string };
  },
): Promise<void> {
  const { worktree } = b;
  seedBuildEffectsForTest(b.sessionId, {
    ...(b.path ? { path: b.path } : {}),
    ...(worktree?.path ? { worktreePath: worktree.path } : {}),
    made: worktree ? { branch: worktree.branch, base: worktree.base, target: worktree.target } : { inRoot: b.inRoot ?? "it isn't a Git repository." },
    ...(b.merged ? { merge: { commit: b.merged.commit } } : {}),
    ...(b.removed ? { remove: { branchDeleted: !!b.removed.branchDeleted } } : {}),
  });
  const host = hostOf(orgId);
  const sid = buildSid(projectId, b.sessionId);
  const createdAt = typeof b.createdAt === "string" ? Date.parse(b.createdAt) : (b.createdAt ?? Date.now());
  setOrgClockForTest(() => createdAt);
  try {
    await host.start(
      sid,
      "build",
      {
        projectId,
        sessionId: b.sessionId,
        kind: b.kind,
        startedBy: b.kind === "coding" ? "overseer" : "operator",
        ...(b.title ? { title: b.title } : {}),
        ...(b.via ? { via: b.via } : {}),
        gap: "none",
        decisions: [],
        mode: { mode: "normal", minorModes: [] },
        createdAt,
      },
      { by: "system" },
    );
    await buildSetupEnded(projectId, sid);
  } finally {
    setOrgClockForTest(null);
  }
  const at = (iso: string | undefined) => (iso ? () => Date.parse(iso) : null);
  if (b.merged) {
    setOrgClockForTest(at(b.merged.at));
    try {
      await host.act(sid, "build/merge", { elsewhere: false }, envelopeFor(orgId, projectId, { by: "operator", attended: true }), { settle: true });
    } finally {
      setOrgClockForTest(null);
    }
  }
  if (b.removed) {
    setOrgClockForTest(at(b.removed.at));
    try {
      await host.act(sid, "build/remove-worktree", { elsewhere: false }, envelopeFor(orgId, projectId, { by: "operator", attended: true }), { settle: true });
    } finally {
      setOrgClockForTest(null);
    }
  }
}

/**
 * The project overseer's conversations as its project statechart keeps them: `history` (oldest first here)
 * started one after another, then `current`; each a conversation id whose file the test writes itself.
 */
export async function seedPoState(orgId: string, projectId: string, s: { current: string; history: string[] }): Promise<void> {
  const host = hostOf(orgId);
  const sid = projectSid(projectId);
  const ids = [...s.history, s.current];
  for (const [i, conversationId] of ids.entries()) {
    const has = i > 0 || !!host.configuration(sid)?.includes("has-overseer");
    const out = await host.act(sid, has ? "overseer/clear" : "overseer/start", { conversationId }, envelopeFor(orgId, projectId, { by: "operator", attended: true }), { settle: true });
    if (!out.taken) throw new Error(out.refusal?.sentence ?? "refused");
  }
}

/** A reason for the project's watch, as a statechart sends it (`reason/noted {kind, params, key, by}`). */
export async function noteWatchReason(orgId: string, projectId: string, reason: { kind: string; params?: Record<string, unknown>; key?: string; by?: string }): Promise<void> {
  const { by = "system", ...rest } = reason;
  // The reason's `by` is the envelope's (a payload may not shadow it).
  await hostOf(orgId).act(watchSid(projectId), "reason/noted", { params: {}, ...rest }, { by }, { settle: true });
}

/**
 * Looks that run nothing: each `:sova/look` the org's watches start is recorded and finishes at once
 * (`finish: false` leaves it running until the test calls `end`).
 */
export function fakeLooks(orgId: string, opts: { finish?: boolean } = {}): { looks: { projectId: string; text: string; reasons: string[] }[]; end: (outcome?: "finished" | "stopped", detail?: string) => void } {
  const looks: { projectId: string; text: string; reasons: string[] }[] = [];
  const open: ((outcome: "finished" | "stopped", detail?: string) => void)[] = [];
  hostOf(orgId).invocations.register("sova/look", {
    start(inv, report) {
      const p = (inv.params ?? {}) as { projectId?: string; text?: string; reasons?: string[] };
      looks.push({ projectId: String(p.projectId ?? ""), text: String(p.text ?? ""), reasons: p.reasons ?? [] });
      if (opts.finish === false) open.push((outcome, detail) => report(outcome, detail));
      else report("finished");
    },
    stop() {},
  });
  return { looks, end: (outcome = "finished", detail) => open.shift()?.(outcome, detail) };
}

/**
 * The reply to the last message ended (the chat layer's `reply/ended`): an accepted message starts its
 * reply in the same step, and a move, the budget stop, a lease lapse or the wrap-up waits for its end.
 */
export async function replyEnded(sessionId: string): Promise<void> {
  const hit = batonById(sessionId);
  if (!hit) throw new Error(`No gathering session ${sessionId}`);
  await hostOf(hit.row.orgId).act(`baton/${hit.row.orgId}/${sessionId}`, "reply/ended", {}, { by: "system" }, { settle: true });
}
