// The one count of work running right now (§app.session-list/working-now): sessions whose own turn
// is running, plus subagents working, on this host and every connected host. The toolbar's
// breakdown line, the foot's Agents row, the phone bar and the spine tally all read `workNowView`,
// so no two can disagree. Pure: no Solid here, so the tests run it bare.

import type { AgentsInsight, MeshSessions, PeerStatus, SessionSummary } from "../../shared/protocol";
import { isHostSession, sessionWorking } from "./workers";

/** A connected host's part: its session list, or null while it has no current one (down, stale,
    or not answered yet), which makes the count a floor. */
export interface WorkPeer {
  label: string;
  rows: readonly Pick<SessionSummary, "path" | "activity" | "live" | "busy" | "workers" | "workerSession">[] | null;
}

/** The open chat's socket values, by session path: its own run state and its working subagents.
    A path's key is present only once its socket has said it. */
export interface WorkOpen {
  running: Readonly<Record<string, boolean>>;
  working: Readonly<Record<string, number>>;
}

/** The peers whose session list in this GET /api/mesh/sessions answer is a current one: sent, not
    the last good list of a peer that isn't answering now. */
export function answeredPeers(answer: MeshSessions): Set<string> {
  return new Set(answer.peers.filter((p) => p.sessions && !p.stale && (p.state === "up" || p.state === "skewed")).map((p) => p.id));
}

/** Every connected host's part, in the mesh's order: its kept list while its last answer was a
    current one, else null (down, stale, or no answer yet). */
export function workPeers(
  peers: readonly Pick<PeerStatus, "id" | "label">[],
  lists: ReadonlyMap<string, readonly SessionSummary[]>,
  answered: ReadonlySet<string>,
): WorkPeer[] {
  return peers.map((p) => ({ label: p.label || p.id, rows: answered.has(p.id) ? (lists.get(p.id) ?? null) : null }));
}

export type WorkNowState = "complete" | "partial" | "unknown";

export interface WorkNow {
  state: WorkNowState;
  /** Main threads whose own turn is running. */
  sessions: number;
  /** Workers working (team members included: they are workers). */
  subagents: number;
  /** Labels of the connected hosts that aren't counted, in the peers' order. */
  missing: string[];
}

const NO_OPEN: WorkOpen = { running: {}, working: {} };

/** The count. `agents` undefined is unknown: the Agents poll hasn't answered. */
export function workNow(agents: AgentsInsight | undefined, peers: readonly WorkPeer[] = [], open: WorkOpen = NO_OPEN): WorkNow {
  if (!agents) return { state: "unknown", sessions: 0, subagents: 0, missing: [] };
  let sessions = 0;
  let subagents = 0;
  const seen = new Set<string>();
  /** One session's part, its socket's word over the list's. */
  const add = (path: string | null, turn: boolean, working: number) => {
    if (path !== null) {
      seen.add(path);
      if (path in open.running) turn = open.running[path]!;
      if (path in open.working) working = open.working[path]!;
    }
    if (turn) sessions++;
    subagents += Math.max(0, working);
  };
  for (const s of agents.sessions) {
    if (!s.fresh || !isHostSession(s)) continue;
    // From the counts, not `workers`: the array drops evicted workers, the counts never do.
    add(s.path, s.state === "working", s.workerCounts.working);
  }
  const missing: string[] = [];
  for (const p of peers) {
    if (!p.rows) {
      missing.push(p.label);
      continue;
    }
    for (const r of p.rows) {
      // A worker's own session is counted by its parent's workers already.
      if (r.workerSession || seen.has(r.path)) continue;
      add(r.path, r.activity?.state === "working" || (!r.live && r.busy), sessionWorking(r));
    }
  }
  // The open chat before any list has it (a new chat's first turn): its socket alone.
  for (const path of new Set([...Object.keys(open.running), ...Object.keys(open.working)])) {
    if (!seen.has(path)) add(path, false, 0);
  }
  return { state: missing.length > 0 ? "partial" : "complete", sessions, subagents, missing };
}

export interface WorkNowView {
  state: WorkNowState;
  /** sessions + subagents; null while unknown. */
  total: number | null;
  /** The bare figure for the phone bar and the spine tally: the number alone whenever known, `–` unknown. */
  figure: string;
  /** The Agents row's word after the figure ("agents", "agent"); null while unknown, when the
      row reads the plain word "Agents". */
  rowWord: string | null;
  /** The toolbar line's parts, 0s left out: each an icon and its figure. Empty: the line is omitted. */
  parts: { kind: "sessions" | "subagents"; n: number; word: string }[];
  /** The toolbar line's words, its title and aria-label: "2 sessions · 5 subagents working", a
      floor's "At least …" and missing hosts included; "" with no parts. */
  lineLabel: string;
  /** The count's sentence: the toolbar line's name, the start of the row's and the tally's. */
  sentence: string;
  /** The spine tally shows unless the count is a complete 0. */
  showTally: boolean;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const andList = (xs: readonly string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Why a floor is one: the hosts it leaves out, named by label. */
export function workMissing(labels: readonly string[]): string {
  if (labels.length === 0) return "";
  return `Work on ${andList(labels)} isn't counted: ${labels.length === 1 ? "it isn't" : "they aren't"} answering.`;
}

export function workNowView(w: WorkNow): WorkNowView {
  if (w.state === "unknown") {
    return { state: "unknown", total: null, figure: "–", rowWord: null, parts: [], sentence: "Agents working now: not known yet", lineLabel: "", showTally: true };
  }
  const total = w.sessions + w.subagents;
  const parts: WorkNowView["parts"] = [];
  if (w.sessions > 0) parts.push({ kind: "sessions", n: w.sessions, word: plural(w.sessions, "session", "sessions") });
  if (w.subagents > 0) parts.push({ kind: "subagents", n: w.subagents, word: plural(w.subagents, "subagent", "subagents") });
  const floor = w.state === "partial";
  const head =
    total === 0
      ? floor
        ? "No agents seen working now"
        : "No agents working now"
      : `${floor ? "At least " : ""}${total} ${plural(total, "agent", "agents")} working now: ${parts.map((p) => `${p.n} ${p.word}`).join(" and ")}`;
  const sentence = floor ? `${head}. ${workMissing(w.missing)}` : head;
  const breakdown = parts.length ? `${floor ? "At least " : ""}${parts.map((p) => `${p.n} ${p.word}`).join(" · ")} working` : "";
  const lineLabel = floor && breakdown ? `${breakdown}. ${workMissing(w.missing)}` : breakdown;
  return { state: w.state, total, figure: `${total}`, rowWord: plural(total, "agent", "agents"), parts, sentence, lineLabel, showTally: floor || total > 0 };
}

/** Sentences joined so each ends in exactly one full stop. */
export function sentences(...xs: string[]): string {
  return xs
    .filter((x) => x !== "")
    .map((x) => (x.endsWith(".") ? x : `${x}.`))
    .join(" ");
}
