// The sidebar's one live figure: the logical LLM calls in flight across this host and every
// connected host, as the session feed pushes it (`llm_inflight`).
// Pure presentation: the expanded foot's Agents row, the phone bar and the spine all read
// `llmInflightView`, so the three can't disagree. No Solid here, so the tests run it bare.

import type { LlmInflight, LlmInflightGap } from "../../shared/protocol";

export type LlmInflightState = "complete" | "partial" | "unknown";

export interface LlmInflightView {
  state: LlmInflightState;
  /** Some of the count are one-shots timed from spawn to exit: estimates, shown with a leading `~`.
      Independent of `partial`: a `~` never stands for a gap, a `+` never for an estimate. */
  approximate: boolean;
  /** The bare figure for the phone bar and the spine tally: `3`, `3+` while partial, `~3` / `~3+`
      with one-shots in it, `–` unknown. */
  figure: string;
  /** The calls in flight, seen ones and one-shots alike; null while unknown. */
  count: number | null;
  /** The Agents row's words after the figure, the calls printed short as agents ("agents",
      "agent"); null while unknown, when the row reads the plain word "Agents" and shows no figure. */
  rowWord: string | null;
  /** The count's sentence: the phone bar's clause and the spine tally's name. */
  sentence: string;
  /** "Agents: {sentence}", the start of the row's full label (`agentsRow`). */
  agentsLabel: string;
  /** The spine tally shows unless the count is a complete 0. */
  showTally: boolean;
}

const calls = (n: number) => (n === 1 ? "LLM call" : "LLM calls");
const agents = (n: number) => (n === 1 ? "agent" : "agents");

/** The sentence's opening: the exact calls, then the one-shots apart, never "at least" over an
    estimate. `floor` is a partial count's "At least". */
function callsClause(n: number, a: number, floor: boolean): string {
  if (a === 0) return floor ? `At least ${n} ${calls(n)} running now` : n === 0 ? "No LLM calls running now" : `${n} ${calls(n)} running now`;
  const exact = n - a;
  // A floor can't vouch for none: with no exact call it says none was seen.
  const head = exact === 0 ? (floor ? "No exact LLM calls seen" : "No exact LLM calls running now") :`${floor ? "At least " : ""}${exact} ${calls(exact)} running now`;
  return `${head}, and ${a} ${a === 1 ? "one-shot" : "one-shots"} that may be calling`;
}

/** One gap's reason, in words. `host` absent is this host; a peer is named by its label. */
function gapWhy(g: LlmInflightGap, label: (id: string) => string): string {
  const host = (id: string | undefined) => (id === undefined ? "this host" : label(id));
  switch (g.reason) {
    case "claude-internal":
      return "Claude Code's own internal calls aren't visible.";
    case "unreported":
      return g.processes === 1 ? `1 process on ${host(g.host)} doesn't report.` : `${g.processes} processes on ${host(g.host)} don't report.`;
    case "peer-connecting":
      return `${host(g.host)} hasn't reported yet.`;
    case "peer-unreachable":
      return `${host(g.host)} can't be reached.`;
    case "peer-unsupported":
      return `${host(g.host)} runs an older Sova.`;
  }
}

/** Why a partial count is only a floor: each reason that applies, once, in the gaps' order. */
export function inflightWhy(gaps: readonly LlmInflightGap[], label: (id: string) => string = (id) => id): string {
  return [...new Set(gaps.map((g) => gapWhy(g, label)))].join(" ");
}

/** The count as the sidebar shows it. `null` is unknown: no snapshot on the current connection. */
export function llmInflightView(inflight: LlmInflight | null, label: (id: string) => string = (id) => id): LlmInflightView {
  if (!inflight) {
    const sentence = "LLM calls running now: not known yet";
    return { state: "unknown", approximate: false, count: null, figure: "–", rowWord: null, sentence, agentsLabel: `Agents: ${sentence}`, showTally: true };
  }
  const n = inflight.count;
  // One-shots are part of the count; a malformed frame can't claim more of them than calls.
  const a = Math.min(Math.max(inflight.approximate, 0), n);
  const tilde = a > 0 ? "~" : "";
  // A count with a gap is a floor, whatever `partial` says: never shown as an exact number.
  if (inflight.partial || inflight.gaps.length > 0) {
    const why = inflightWhy(inflight.gaps, label);
    const sentence = `${callsClause(n, a, true)}.${why ? ` ${why}` : ""}`;
    return { state: "partial", approximate: a > 0, count: n, figure: `${tilde}${n}+`, rowWord: "agents", sentence, agentsLabel: `Agents: ${sentence}`, showTally: true };
  }
  const sentence = callsClause(n, a, false);
  return { state: "complete", approximate: a > 0, count: n, figure: `${tilde}${n}`, rowWord: agents(n), sentence, agentsLabel: `Agents: ${sentence}`, showTally: n > 0 };
}

/** This host's figures the Agents row keeps after the call count: fresh host sessions holding a
    working subagent, and teams with a member working (`activeAgentCounts(…).sessions`,
    `activeTeamCount`, from the Agents poll). */
export interface LocalAgents {
  sessions: number;
  teams: number;
}

export interface AgentsRow {
  /** After the first segment, each joined by " · ": `2 sessions`, `1 team`; a 0 is left out. */
  secondary: { n: number; word: string }[];
  /** The row's and the spine doorway's `title` and `aria-label`. */
  label: string;
}

/** What the row's figure means, said whenever it shows one above 0. */
export const AGENTS_DEFINITION = "Each agent counted is one model call in flight, background work included.";

/** The Agents row: the call count first (every host), then this host's sessions and teams. */
export function agentsRow(view: LlmInflightView, local: LocalAgents): AgentsRow {
  const secondary: { n: number; word: string }[] = [];
  if (local.sessions > 0) secondary.push({ n: local.sessions, word: local.sessions === 1 ? "session" : "sessions" });
  if (local.teams > 0) secondary.push({ n: local.teams, word: local.teams === 1 ? "team" : "teams" });
  const more: string[] = [];
  if (view.count !== null && view.count > 0) more.push(AGENTS_DEFINITION);
  if (secondary.length > 0) more.push(`On this host, subagents are working in ${secondary.map((p) => `${p.n} ${p.word}`).join(" and ")}.`);
  // Alone, the count's sentence reads as before; followed by another, it gets exactly one full stop
  // (a partial count's sentence already ends with one).
  let label = view.agentsLabel;
  for (const next of more) label += `${label.endsWith(".") ? " " : ". "}${next}`;
  return { secondary, label };
}

/** Whether two pushed counts read the same, so an unchanged frame doesn't wake the sidebar. */
export function sameInflight(a: LlmInflight | null, b: LlmInflight | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.count === b.count && a.approximate === b.approximate && a.partial === b.partial && JSON.stringify(a.gaps) === JSON.stringify(b.gaps);
}
