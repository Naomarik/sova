import type { HBlock, HEntry } from "../shared/harness";
import { OVERSEER_BRIEF_PREFIX, type SessionReadiness } from "../shared/protocol";
import type { OpeningDetails } from "./overseer-opening";
import { CARD_TOOL, CARDS_NOTE_MESSAGE, foldCardDetails, normalizeCardDetails, openCardsOf, type CardDetails, type OverseerCard } from "../shared/overseer-card";

/**
 * The global Overseer's run note (§app.overseer/run-note): the hidden message every run a message
 * starts carries, beside the open cards. It says the time now (the system prompt keeps the time the
 * conversation opened, so its cache holds), which blockers the briefs named have cleared since,
 * and which open cards' sessions merged or were archived. Pure: the caller gathers the digest's act
 * keys and each session's state.
 */

/** Briefs older than this are not looked back at. */
export const CLEARED_WINDOW_MS = 24 * 3_600_000;
/** At most this many cleared blockers per note. */
export const CLEARED_MAX = 12;

/** A blocker a brief named: its digest key (`id:kind`, attention.ts blockerKey) and when the brief went. */
export interface BriefedBlocker {
  key: string;
  id: string;
  kind: string;
  at: number;
}

/** A session as the note needs it now; null when it is gone. */
export interface SessionNow {
  /** Its link text (summary-first, §app.overseer/session-names). */
  name: string;
  archived: boolean;
  /** Its branch merged (readiness badge merged or restart pending): when. */
  merged?: number;
  /** It waits on the user's answers to open alignment questions. */
  waitsOnAnswers: boolean;
  /** Its state now, for the sessions in play: working, idle, needs-input, error, archived. */
  state?: string;
  /** Its worktrees, each "branch <name> (<badge>)" (branchLabels). */
  branches?: string[];
}

/** The note's `details`: the blockers it listed as cleared, each `<key>@<brief ms>`, so a later note lists each once per brief. */
export interface RunNoteDetails extends OpeningDetails {
  v: 1;
  cleared?: string[];
}

const textOf = (blocks: readonly HBlock[]): string => blocks.map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");

/** A successful sova_card result's details (the card it touched), or undefined. */
export function cardDetailsOf(h: HEntry): CardDetails | undefined {
  return h.kind === "tool-result" && h.tool === CARD_TOOL && h.isError !== true ? normalizeCardDetails(h.details) : undefined;
}

/** The cards on a branch (root first): each card's newest snapshot, in the order last touched. */
export function cardsOnBranch(branch: readonly HEntry[]): OverseerCard[] {
  return foldCardDetails(branch.map(cardDetailsOf));
}

/** One blocker line of a brief, as briefText (overseer.ts) writes it: `- <kind>: [<name>](sova://s/<id>)…`. */
const BRIEF_LINE = /^- ([a-z][a-z-]*): \[[^\]\n]*\]\(sova:\/\/s\/([^)\s]+)\)/;

/** Every blocker the briefs on a branch named, the newest brief's time per key. */
export function briefedBlockers(branch: readonly HEntry[]): BriefedBlocker[] {
  const out = new Map<string, BriefedBlocker>();
  for (const e of branch) {
    if (e.kind !== "user") continue;
    const text = textOf(e.blocks);
    if (!text.startsWith(OVERSEER_BRIEF_PREFIX)) continue;
    const at = typeof e.at === "string" ? Date.parse(e.at) : NaN;
    if (!Number.isFinite(at)) continue;
    for (const line of text.split("\n")) {
      const m = BRIEF_LINE.exec(line.trim());
      if (!m) continue;
      const key = `${m[2]}:${m[1]}`;
      out.delete(key);
      out.set(key, { key, id: m[2]!, kind: m[1]!, at });
    }
  }
  return [...out.values()];
}

/** What earlier run notes on the branch already listed as cleared (`<key>@<brief ms>`). */
export function listedCleared(branch: readonly HEntry[]): Set<string> {
  const out = new Set<string>();
  for (const e of branch) {
    if (e.kind !== "note" || e.inMessage || e.noteType !== CARDS_NOTE_MESSAGE) continue;
    const d = e.details as RunNoteDetails | undefined;
    if (d?.v === 1 && Array.isArray(d.cleared)) for (const k of d.cleared) if (typeof k === "string") out.add(k);
  }
  return out;
}

/** Why a briefed blocker cleared: the first that holds. `definite`: the server knows (else it only
    stopped being listed). */
export function clearedWhy(kind: string, s: SessionNow | null): { why: string; definite: boolean } {
  if (!s) return { why: "the session is gone", definite: true };
  if (s.archived) return { why: "archived", definite: true };
  if (s.merged !== undefined) return { why: "merged", definite: true };
  if (kind === "open-questions" && !s.waitsOnAnswers) return { why: "its questions were answered in the session", definite: true };
  return { why: "no longer needs the user", definite: false };
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const linkTo = (name: string, id: string) => `[${name.replace(/[[\]]/g, "")}](sova://s/${id})`;

export interface RunNoteInput {
  now: Date;
  branch: readonly HEntry[];
  /** The digest's act-tier keys now (`id:kind`). `complete`: false when the digest's cap left act items out. */
  act: { keys: ReadonlySet<string>; complete: boolean };
  /** A session's state now, by id; null when it is gone. */
  session: (id: string) => SessionNow | null;
  /** The open-cards note (cardsNote), when a card is open. */
  cardsText?: string;
  /** Sessions the Overseer created or prompted, by id, with when (sessionsInPlay adds the briefed ones). */
  prompted?: readonly Touched[];
  /** Text from other sessions is redacted before it reaches the model. */
  redact?: (text: string) => string;
  /** The `[changed]` part (overseer-opening.ts changedText), when a part of the prompt changed. */
  changed?: string;
  /** The opening values and told fingerprints to record (overseer-opening.ts). */
  opening?: OpeningDetails;
}

/** The ids the note will ask `session` about: briefed blockers in the window, open cards' sessions,
    and the sessions in play. */
export function runNoteSessionIds(branch: readonly HEntry[], now: number, prompted: readonly Touched[] = []): string[] {
  const ids = new Set<string>(sessionsInPlay(branch, now, prompted).map((p) => p.id));
  for (const b of briefedBlockers(branch)) if (now - b.at <= CLEARED_WINDOW_MS) ids.add(b.id);
  for (const c of openCardsOf(cardsOnBranch(branch))) for (const it of c.items) if (it.kind === "session") ids.add(it.id);
  return [...ids];
}

/** The run note's first line: the time now, and that the system prompt's is when the conversation opened. */
export const nowLine = (now: Date): string =>
  `[now] It is ${now.toString()}. The time in your system prompt is when this conversation opened; read elapsed time from this line and from tool ages.`;

/** The note's text and details. */
export function runNote(input: RunNoteInput): { content: string; details: RunNoteDetails } {
  const now = input.now.getTime();
  const redact = input.redact ?? ((t: string) => t);
  const parts = [nowLine(input.now)];
  // What changed since the system prompt was written (overseer-opening.ts): already redacted.
  if (input.changed) parts.push(input.changed);

  const listed = listedCleared(input.branch);
  const cleared: string[] = [];
  const lines: string[] = [];
  const briefed = briefedBlockers(input.branch)
    .filter((b) => now - b.at <= CLEARED_WINDOW_MS && !input.act.keys.has(b.key) && !listed.has(`${b.key}@${b.at}`))
    .sort((a, b) => b.at - a.at);
  for (const b of briefed) {
    if (lines.length >= CLEARED_MAX) break;
    const s = input.session(b.id);
    const { why, definite } = clearedWhy(b.kind, s);
    // A digest cut short may have left a live blocker out: only a reason the server knows lists it then.
    if (!definite && !input.act.complete) continue;
    lines.push(`- ${b.kind}: ${linkTo(s?.name ?? b.id, b.id)} — ${why} (briefed ${ago(b.at, now)})`);
    cleared.push(`${b.key}@${b.at}`);
  }
  if (lines.length)
    parts.push(redact(["[cleared] Blockers your briefs named that no longer need the user. Don't report them as open; check with sova_session before saying more:", ...lines].join("\n")));

  const cardLines: string[] = [];
  for (const c of openCardsOf(cardsOnBranch(input.branch))) {
    const raised = Date.parse(c.createdAt);
    for (const it of c.items) {
      if (it.kind !== "session") continue;
      const s = input.session(it.id);
      if (s === null) cardLines.push(`- ${c.id} item ${it.n}: ${it.id} — the session is gone`);
      else if (s.archived) cardLines.push(`- ${c.id} item ${it.n}: ${linkTo(s.name, it.id)} — archived`);
      else if (s.merged !== undefined && Number.isFinite(raised) && s.merged > raised)
        cardLines.push(`- ${c.id} item ${it.n}: ${linkTo(s.name, it.id)} — merged ${ago(s.merged, now)}, after the card was raised`);
    }
  }
  if (cardLines.length) parts.push(redact(["[card sessions] Sessions on open cards whose state moved. Drop or replace a card they make moot:", ...cardLines].join("\n")));

  const play = sessionsInPlayText(sessionsInPlay(input.branch, now, input.prompted ?? []), input.session, now);
  if (play) parts.push(redact(play));

  if (input.cardsText) parts.push(input.cardsText);
  return { content: parts.join("\n\n"), details: { v: 1, ...(cleared.length ? { cleared } : {}), ...input.opening } };
}

// ---- sessions in play (§app.overseer/sessions-in-play) -------------------------------------------

/** At most this many sessions in play. */
export const IN_PLAY_MAX = 15;

/** A session the Overseer touched: its id and when. */
export interface Touched {
  id: string;
  at: number;
}

/** A session in play: when the Overseer last created or prompted it, and the last brief that named it. */
export interface InPlay {
  id: string;
  prompted?: number;
  brief?: { kind: string; at: number };
}

const PLAY_TOOLS = new Set(["sova_create_session", "sova_send"]);

/** The sessions the Overseer created or sent to, from its successful tool results on the branch:
    this host's only (a peer's carries `host`). Survives a restart, unlike the server's own tracking. */
export function promptedOnBranch(branch: readonly HEntry[]): Touched[] {
  const out: Touched[] = [];
  for (const e of branch) {
    if (e.kind !== "tool-result" || !PLAY_TOOLS.has(e.tool as string) || e.isError === true) continue;
    const d = e.details as { id?: unknown; host?: unknown } | undefined;
    const at = typeof e.at === "string" ? Date.parse(e.at) : NaN;
    if (typeof d?.id === "string" && d.host === undefined && Number.isFinite(at)) out.push({ id: d.id, at });
  }
  return out;
}

/**
 * The sessions in play: those the Overseer created or prompted (on the branch, and `prompted`, the
 * server's own tracking since it started) and those a brief named, in the last 24 hours (the
 * cleared window); the most recently touched first, at most IN_PLAY_MAX. Pure.
 */
export function sessionsInPlay(branch: readonly HEntry[], now: number, prompted: readonly Touched[] = []): InPlay[] {
  const by = new Map<string, InPlay>();
  const get = (id: string) => by.get(id) ?? by.set(id, { id }).get(id)!;
  for (const t of [...promptedOnBranch(branch), ...prompted]) {
    if (now - t.at > CLEARED_WINDOW_MS) continue;
    const p = get(t.id);
    p.prompted = Math.max(p.prompted ?? 0, t.at);
  }
  for (const b of briefedBlockers(branch)) {
    if (now - b.at > CLEARED_WINDOW_MS) continue;
    const p = get(b.id);
    if (!p.brief || b.at >= p.brief.at) p.brief = { kind: b.kind, at: b.at };
  }
  const touched = (p: InPlay) => Math.max(p.prompted ?? 0, p.brief?.at ?? 0);
  return [...by.values()].sort((a, b) => touched(b) - touched(a)).slice(0, IN_PLAY_MAX);
}

const BADGE_WORDS: Record<NonNullable<SessionReadiness["badge"]>, string> = { ready: "ready", waiting: "waiting for the OK", merged: "merged", restart: "merged, restart pending" };

/** Each worktree a session tracks, "branch <name> (<badge>)": the readiness badge for the worktree it
    speaks for, else that worktree's own state (in-progress, blocked, stale…). None without readiness. */
export function branchLabels(r: SessionReadiness | undefined): string[] {
  if (!r) return [];
  return r.trees.map((t) => `branch ${t.branch} (${r.badge && (r.branch === undefined || r.branch === t.branch) ? BADGE_WORDS[r.badge] : t.state})`);
}

/**
 * The sessions-in-play part of the run note, or undefined when none is in play. `followUps` is the
 * slot for the Overseer's open follow-ups (round 3 fills it); today nobody passes it.
 */
export function sessionsInPlayText(play: readonly InPlay[], session: (id: string) => SessionNow | null, now: number, followUps: readonly string[] = []): string | undefined {
  const parts: string[] = [];
  if (play.length) {
    const rows = play.map((p) => {
      const s = session(p.id);
      if (!s) return `- ${p.id} — the session is gone`;
      const bits = [linkTo(s.name, p.id), p.id, s.archived ? "archived" : (s.state ?? "idle"), ...(s.branches ?? [])];
      if (p.prompted) bits.push(`you created or prompted it ${ago(p.prompted, now)}`);
      if (p.brief) bits.push(`last brief: ${p.brief.kind} ${ago(p.brief.at, now)}`);
      return `- ${bits.join(" · ")}`;
    });
    parts.push(["[sessions in play] Sessions you created, prompted or were briefed about in the last 24 hours, as of now. Still check one with sova_session before saying what it is doing:", ...rows].join("\n"));
  }
  // Round 3's open follow-ups go here, beside the sessions they watch.
  if (followUps.length) parts.push(["[follow-ups] Your open follow-ups:", ...followUps.map((f) => `- ${f}`)].join("\n"));
  return parts.length ? parts.join("\n\n") : undefined;
}
