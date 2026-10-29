// incumbent: the Overseer's search, imported from server/overseer-roundup.ts and replayed over the
// frozen copy as of a query's own time (plan.md, The two systems). Only the scope is built here, the
// way sova_search_sessions builds it; the search itself is Sova's code, untouched.
import { join } from "node:path";
import type { SessionSummary } from "../../shared/protocol";
import { byRecency, cursorStart, DEFAULT_WINDOW_DAYS, parseSince, projectFilter, searchSessions, searchWords, skippedFromOverview } from "../../server/overseer-roundup";
import { asOf, type Session, truncatedCopy } from "./corpus";

export interface Project {
  id: string;
  name: string;
  root: string;
}

/** The flag a row's skip reason stands for, so Sova's own skippedFromOverview decides. */
const FLAG: Record<string, Partial<SessionSummary>> = {
  overseer: { overseer: true },
  "project-overseer": { projectOverseer: { projectId: "" } } as Partial<SessionSummary>,
  "project-chat": { projectOverseer: { projectId: "" } } as Partial<SessionSummary>,
  org: { org: {} } as Partial<SessionSummary>,
  "org-chat": { org: {} } as Partial<SessionSummary>,
  "org-build": { org: {} } as Partial<SessionSummary>,
  baton: { baton: {} } as Partial<SessionSummary>,
  worker: { workerSession: true },
};

export interface ScopeRow {
  s: SessionSummary;
  session: Session;
  /** The bytes of its file written by the query's time. */
  bytes: number;
}

/** host.sessions() as of `t`, minus skippedFromOverview, in the window, in the project, newest first. */
export function scopeAsOf(corpus: readonly Session[], t: number, opts: { since?: string; project?: string; projects: readonly Project[]; allTime?: boolean }): { rows: ScopeRow[]; since: number } {
  const given = parseSince(opts.since, t);
  const since = opts.allTime ? -Infinity : (given ?? t - DEFAULT_WINDOW_DAYS * 86_400_000);
  const project = projectFilter(opts.project, () => opts.projects.map((p) => ({ ...p, createdAt: "" }) as never));
  const rows: ScopeRow[] = [];
  for (const session of corpus) {
    if (!session.row.listed) continue;
    const v = asOf(session, t);
    if (!v.present) continue;
    const s = {
      id: session.row.id,
      path: session.path,
      cwd: session.row.cwd,
      ...(session.row.project ? { project: { projectId: session.row.project } } : {}),
      title: session.row.title ?? "Untitled",
      lastActiveAt: new Date(v.activeAt).toISOString(),
      ...(session.row.skipped ? FLAG[session.row.skipped] : {}),
    } as SessionSummary;
    if (skippedFromOverview(s) || v.activeAt < since || (project && !project(s))) continue;
    rows.push({ s, session, bytes: v.bytes });
  }
  const order = byRecency(rows.map((r) => r.s));
  const byId = new Map(rows.map((r) => [r.s.id, r]));
  return { rows: order.map((s) => byId.get(s.id)!), since };
}

export interface IncumbentRun {
  hits: { id: string; snippets: { who: string; at: number; text: string }[]; matches: number }[];
  searched: number;
  total: number;
  stoppedShort: boolean;
  ms: number;
}

/** One call of the incumbent over `rows`, each file as it stood then (a reflinked, truncated copy
    under `asofDir` when it has grown since). `limitMs` Infinity: no time limit. */
export async function runIncumbent(rows: readonly ScopeRow[], words: string, opts: { limitMs: number; asofDir: string; cursor?: string }): Promise<IncumbentRun> {
  const ws = searchWords(words);
  const scope = rows.map((r) => r.s);
  const pathOf = new Map(rows.map((r) => [r.s.id, truncatedCopy(r.session.path, r.session.size, r.bytes, join(opts.asofDir))]));
  const start = cursorStart(scope, opts.cursor);
  const t0 = performance.now();
  const r = await searchSessions(scope, start, ws, { limitMs: opts.limitMs, file: (s) => pathOf.get(s.id)! });
  const ms = performance.now() - t0;
  return { hits: r.hits.map((h) => ({ id: h.s.id, snippets: h.snippets, matches: h.matches })), searched: r.searched, total: r.total, stoppedShort: r.stoppedShort, ms };
}
