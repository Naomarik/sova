import { createSignal } from "solid-js";
import { AUTO_TITLE_MAX_PATHS, type AutoTitleOutcome, type AutoTitleResponse, type SessionSummary } from "../../shared/protocol";

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
