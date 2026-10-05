import { createSignal } from "solid-js";
import { AUTO_TITLE_MAX_PATHS, SESSION_TITLE_LABEL_MAX, type AutoTitleOutcome, type AutoTitleResponse, type AutoTitleSkip, type SessionSummary } from "../../shared/protocol";

// The section heads' Name sessions button (§app.session-list/auto-titles): which rows it counts,
// and how a press reaches each host. Silent by design: no toast and no undo — the rows' titles
// changing on the next list fetch is the whole answer.

/**
 * A row the button names: no stored title at all (no `titleBy`, and no override from a server that
 * predates it), and a session somebody wrote in (a draft-only row has nothing to name it from).
 * Workers and Overseer files never reach a section's rows. Pure.
 */
export const isNameable = (s: SessionSummary): boolean =>
  s.titleBy === undefined && s.originalTitle === undefined && s.draftPreview === undefined && !s.workerSession && !s.overseer && !s.projectOverseer;

/** A section's nameable rows, each session once (a row can show in two places of one section). Pure. */
export function nameableRows(rows: readonly SessionSummary[]): SessionSummary[] {
  const seen = new Set<string>();
  const out: SessionSummary[] = [];
  for (const s of rows) {
    if (seen.has(s.path) || !isNameable(s)) continue;
    seen.add(s.path);
    out.push(s);
  }
  return out;
}

/** "Name 3 sessions" / "Name 1 session", and the in-flight "Naming 3 sessions…". Pure. */
export const nameLabel = (n: number, running = false): string =>
  `${running ? "Naming" : "Name"} ${n} ${n === 1 ? "session" : "sessions"}${running ? "…" : ""}`;

/**
 * The paths, one batch per host and at most AUTO_TITLE_MAX_PATHS per batch, in first-seen order:
 * a request names paths of one host only, so the usual routing sends it to that host. Pure.
 */
export function batchesByHost(paths: readonly string[], hostOf: (path: string) => string | null): string[][] {
  const byHost = new Map<string, string[]>();
  for (const p of paths) {
    const key = hostOf(p) ?? "";
    const list = byHost.get(key) ?? [];
    list.push(p);
    byHost.set(key, list);
  }
  const out: string[][] = [];
  for (const list of byHost.values()) for (let i = 0; i < list.length; i += AUTO_TITLE_MAX_PATHS) out.push(list.slice(i, i + AUTO_TITLE_MAX_PATHS));
  return out;
}

/**
 * Name `paths`, one request per batch, the batches one after another. A batch that fails — a peer
 * whose Sova predates the route answers 404, a host that is down — skips its paths; nothing is
 * thrown and nothing is said.
 */
export async function nameSessions(
  paths: readonly string[],
  deps: { hostOf: (path: string) => string | null; post: (paths: string[]) => Promise<AutoTitleResponse> },
): Promise<AutoTitleOutcome[]> {
  const out: AutoTitleOutcome[] = [];
  for (const batch of batchesByHost(paths, deps.hostOf)) {
    try {
      out.push(...(await deps.post(batch)).results);
    } catch {
      for (const path of batch) out.push({ path, outcome: "skipped", reason: "failed" });
    }
  }
  return out;
}

// Which sections are naming right now, by section key: module state, so a list poll that rebuilds
// the head (or a section that closes and reopens) still shows the press in flight.
const [running, setRunning] = createSignal<ReadonlySet<string>>(new Set());
export const namingIn = (key: string): boolean => running().has(key);
export function setNaming(key: string, on: boolean): void {
  setRunning((cur) => {
    const next = new Set(cur);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  });
}

// ── One open session's Regenerate title, and Settings' Shorten long titles ────────────────────

/** Why a regenerate or shorten left a title as it was, as the second sentence of its message. Pure. */
export function skipReason(reason: AutoTitleSkip): string {
  switch (reason) {
    case "explicit":
      return "The title changed while it was being named, so that one stays.";
    case "no-model":
      return "Neither title model can run right now. Check Settings → Summaries.";
    case "no-input":
      return "There's nothing in the session to name it from yet.";
    case "not-listed":
      return "Sova doesn't name this kind of session.";
    case "not-found":
      return "The session file wasn't found.";
    case "short":
      return "Its title is already short.";
    case "failed":
      return "The title models failed or gave no usable title.";
  }
}

/** A regenerate's one result: the new title, or the toast that says why the title stayed. Pure. */
export function regenerateOutcome(res: AutoTitleResponse | Error): { title: string } | { error: string } {
  if (res instanceof Error) return { error: `Couldn't regenerate the title. ${res.message.replace(/\.?$/, ".")}` };
  const r = res.results[0];
  if (r?.outcome === "named") return { title: r.title };
  return { error: `Couldn't regenerate the title. ${r?.outcome === "skipped" ? skipReason(r.reason) : "Nothing was changed."}` };
}

/** Which open sessions are regenerating, by path: module state, so a head rebuilt mid-run still shows the press. */
const [regenerating, setRegeneratingSet] = createSignal<ReadonlySet<string>>(new Set());
export const regeneratingTitle = (path: string): boolean => regenerating().has(path);
export function setRegeneratingTitle(path: string, on: boolean): void {
  setRegeneratingSet((cur) => {
    const next = new Set(cur);
    if (on) next.add(path);
    else next.delete(path);
    return next;
  });
}

const titles = (n: number) => `${n} ${n === 1 ? "title" : "titles"}`;

/** Shorten long titles' line before a press: how many a dry run found. Pure. */
export const shortenCountLine = (n: number): string =>
  n === 0
    ? `No title is longer than ${SESSION_TITLE_LABEL_MAX} characters.`
    : `${titles(n)} ${n === 1 ? "is" : "are"} longer than ${SESSION_TITLE_LABEL_MAX} characters.`;

/** The button while it runs: "Shortening 3 titles…". Pure. */
export const shorteningLabel = (n: number): string => `Shortening ${titles(n)}…`;

/** Shorten long titles' line after a press: "Shortened 4 of 5 titles. 1 couldn't be shortened." Pure. */
export function shortenDoneLine(results: readonly AutoTitleOutcome[]): string {
  const done = results.filter((r) => r.outcome === "named").length;
  const left = results.length - done;
  const head = `Shortened ${done} of ${titles(results.length)}.`;
  return left ? `${head} ${left} couldn't be shortened.` : head;
}
