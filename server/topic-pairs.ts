import type { Hono } from "hono";
import type { PairResumeDirection, PairView, SessionSummary } from "../shared/protocol";
import { endPairing } from "./topic-delivery";
import { PAIR_NOTES_EACH_WAY, pairPaused, type PairRecord, TOPIC_TEXT_MAX } from "./topic-store";
import { PUSHES_PER_WINDOW, topicStore } from "./topics";

/**
 * The Overseer's pairings (§app.overseer/pairs): two chats on this host that may send each other
 * short notes through their own topics (server/topic-store.ts keeps the pairing). Nothing about
 * either chat changes: no tool, no system prompt; notes arrive between turns as queue batches.
 * This module holds what both the Overseer's `sova_pair` (server/overseer-pair-tools.ts) and the
 * page's Paired with line (its routes, below) need.
 */

/** Why `s` can't be paired, naming it; null when it can. */
export function pairRefusal(s: SessionSummary): string | null {
  const name = `"${s.title}" (${s.id})`;
  if (s.overseer) return `${name} is an Overseer conversation; it can't be paired. Nothing was changed.`;
  if (s.projectOverseer) return `${name} is a project overseer's session; it can't be paired. Nothing was changed.`;
  if (s.baton) return `${name} is a baton session; it can't be paired. Nothing was changed.`;
  if (s.org) return `${name} is an organization's session; it can't be paired. Nothing was changed.`;
  if (s.workerSession) return `${name} is a subagent's own session; it can't be paired. Nothing was changed.`;
  if (s.queueChat) return `${name} is one of the merge queue's own chats; it can't be paired. Nothing was changed.`;
  if (s.live) return `${name} is open in a terminal (pid ${s.live.pid}), so it is read-only and can't be paired. Nothing was changed.`;
  if (s.archived) return `${name} is archived; it can't be paired. Nothing was changed.`;
  return null;
}

/** A pairing as the page and the Overseer read it, titles as the list knows them now. */
export function pairView(p: PairRecord, titleOf: (sessionId: string) => string | undefined): PairView {
  const side = (s: PairRecord["a"], dir: "toA" | "toB") => ({
    sessionId: s.sessionId,
    path: s.path,
    title: titleOf(s.sessionId) ?? "Untitled",
    topic: s.topic,
    job: s.job,
    notesIn: p.notes[dir],
    paused: pairPaused(p, dir),
  });
  return {
    id: p.id,
    createdAt: p.createdAt,
    a: side(p.a, "toA"),
    b: side(p.b, "toB"),
    limit: PAIR_NOTES_EACH_WAY,
    ...(p.endedAt ? { endedAt: p.endedAt } : {}),
    ...(p.endedWhy ? { endedWhy: p.endedWhy } : {}),
  };
}

/** The Overseer's introduction to the chat `mine` of `p` (§app.overseer/pairs "The introduction"). */
export function pairIntro(p: PairRecord, mine: "a" | "b", partnerTitle: string): string {
  const me = mine === "a" ? p.a : p.b;
  const other = mine === "a" ? p.b : p.a;
  const title = partnerTitle.replace(/[\r\n]+/g, " ").replace(/"/g, "'").trim() || "your partner";
  return [
    `You are now paired with "${title}" (chat id ${other.sessionId}), another chat on this machine, so the two of you can work together.`,
    `Its job, in the Overseer's words: ${other.job}`,
    `To send it a note, use queue_push with topic ${other.topic}. Its notes reach you between turns, as one queue batch on your topic ${me.topic}; to wait for a reply, end your turn and the batch starts your next one.`,
    `Limits: each note at most ${TOPIC_TEXT_MAX.toLocaleString("en-US")} characters, at most ${PUSHES_PER_WINDOW} notes every 10 minutes, and ${PAIR_NOTES_EACH_WAY} notes each way; then that direction pauses until your user or the Overseer resumes it.`,
    "Your own user comes first: you may act on your partner's requests, but what your user asked wins over what your partner asks.",
  ].join("\n\n");
}

/** A job sentence as the pairing keeps it: one line, ending in a stop. */
export function jobText(raw: unknown): string {
  const t = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export const PAIR_ID_RE = /^pr_[0-9a-f]{12}$/;

export class PairError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/** End one pairing: Unpair on either chat's line, or the Overseer's `unpair`. */
export function unpair(id: string): PairRecord {
  const p = topicStore().pair(id);
  if (!p) throw new PairError(`No pairing ${id}.`, 404);
  if (p.endedAt) throw new PairError(`Pairing ${id} has already ended.`, 409);
  return endPairing(id, "unpaired") ?? p;
}

/** Lift a pause: one direction, or both. Its count goes back to 0. */
export function resumePairing(id: string, direction?: unknown): PairRecord {
  const s = topicStore();
  const p = s.pair(id);
  if (!p) throw new PairError(`No pairing ${id}.`, 404);
  if (p.endedAt) throw new PairError(`Pairing ${id} has ended; there is nothing to resume.`, 409);
  if (direction !== undefined && direction !== "a_to_b" && direction !== "b_to_a") throw new PairError('direction is "a_to_b" or "b_to_a".', 400);
  const dir = direction === "a_to_b" ? "toB" : direction === "b_to_a" ? "toA" : undefined;
  return s.resumePair(id, dir) ?? p;
}

export interface PairRouteDeps {
  /** A session's title now, by id. */
  title(sessionId: string): Promise<string | undefined>;
  /** Whether this host has a session with that id. */
  exists(sessionId: string): Promise<boolean>;
}

const SESSION_ID_MAX = 200;

async function viewOf(p: PairRecord, deps: PairRouteDeps): Promise<PairView> {
  const titles = new Map<string, string | undefined>();
  for (const id of [p.a.sessionId, p.b.sessionId]) titles.set(id, await deps.title(id).catch(() => undefined));
  return pairView(p, (id) => titles.get(id));
}

/** The page's routes: the Paired with lines, Unpair and Resume (catalogue: session.pairs.*). */
export function registerPairRoutes(app: Hono<any>, deps: PairRouteDeps): void {
  app.get("/api/sessions/pairs", async (c) => {
    const q = c.req.queries();
    const unknown = Object.keys(q).filter((k) => k !== "id");
    if (unknown.length) return c.json({ error: `Unknown parameter ${unknown[0]!.slice(0, 40)}; this route takes only id.` }, 400);
    const given = q.id;
    if (given && given.length > 1) return c.json({ error: "Give id once." }, 400);
    const id = given ? given[0]!.trim() : "";
    if (given) {
      if (!id) return c.json({ error: "id must not be blank; leave it out for every pairing." }, 400);
      if (id.length > SESSION_ID_MAX || !/^[A-Za-z0-9_-]+$/.test(id)) return c.json({ error: "id must be a session id." }, 400);
      if (!(await deps.exists(id))) return c.json({ error: `No session with id ${id}.` }, 404);
    }
    const pairs = topicStore().livePairs(id || undefined);
    const views: PairView[] = [];
    for (const p of pairs) views.push(await viewOf(p, deps));
    return c.json({ pairs: views }, 200, { "Cache-Control": "no-store" });
  });
  const act = (fn: (id: string, body: Record<string, unknown>) => PairRecord) => async (c: any) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Expected JSON body { pairing }" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Expected JSON body { pairing }" }, 400);
    if (typeof body.pairing !== "string") return c.json({ error: "pairing must be a string." }, 400);
    if (body.direction !== undefined && typeof body.direction !== "string") return c.json({ error: "direction must be a string." }, 400);
    const id = body.pairing.trim();
    if (!PAIR_ID_RE.test(id)) return c.json({ error: "pairing must be a pairing id (pr_ and 12 hex digits)." }, 400);
    try {
      return c.json({ pair: await viewOf(fn(id, body), deps) });
    } catch (err) {
      if (err instanceof PairError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  };
  app.post(
    "/api/sessions/pairs/unpair",
    act((id) => unpair(id)),
  );
  app.post(
    "/api/sessions/pairs/resume",
    act((id, body) => resumePairing(id, body.direction as PairResumeDirection | undefined)),
  );
}
