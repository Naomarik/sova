// `statecharts rebuild --verify <org>` (operator ruling r9): every session's transition log replayed
// from its start on the current statecharts, compared with its snapshot (states, running, links, watchers,
// its own timers, holds). A diagnostic: it reads the snapshot files and the log, opens no host,
// restores nothing and writes nothing. The log is scrubbed (design §5.5), so a guard that read a
// message, a contact value or About text may replay another way: that is listed, never repaired.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { EngineOptions, JsonObject, SessionVerdict } from "../statecharts";
import { verifySession } from "../statecharts";
import { readRows, type LogProblem, type LogRow } from "./log";
import { hostPaths, scanSnapshots } from "./store";

export interface VerifyOptions {
  orgId: string;
  workspaceDir: string;
  stateDir: string;
  /** Runtime JS statecharts (tests), as `createStatecharts`. */
  statecharts?: EngineOptions["statecharts"];
}

export interface VerifyReport {
  orgId: string;
  sessions: number;
  /** Every session that differs (or can't be compared), in id order. */
  differing: SessionVerdict[];
  /** Log lines that don't parse, snapshots that don't load. */
  problems: LogProblem[];
  /** A journal is waiting: the org's host hasn't applied its last step yet (open it first). */
  pendingJournal: boolean;
}

/** Only what a statechart step wrote is replayed (a `logAct` row, marked `plain`, has no step). */
function replayable(row: LogRow): boolean {
  return row.plain !== true && Array.isArray(row.after) && typeof row.session === "string";
}

export function verifyOrg(opts: VerifyOptions): VerifyReport {
  const paths = hostPaths(opts.orgId, opts.workspaceDir, opts.stateDir);
  const problems: LogProblem[] = [];
  const bySession = new Map<string, LogRow[]>();
  for (const row of readRows([paths.portableLog, paths.localLog], {}, problems))
    if (replayable(row)) bySession.set(row.session!, [...(bySession.get(row.session!) ?? []), row]);
  const files = new Map<string, string>();
  for (const s of [...scanSnapshots(paths.portable), ...scanSnapshots(paths.local)]) files.set(s.sid, s.file);
  const sids = [...new Set([...files.keys(), ...bySession.keys()])].sort();
  const differing: SessionVerdict[] = [];
  for (const sid of sids) {
    const rows = bySession.get(sid) ?? [];
    const file = files.get(sid);
    let verdict: SessionVerdict;
    try {
      verdict = rows.length
        ? verifySession(sid, rows as unknown as JsonObject[], file ? readFileSync(file, "utf8") : null, { statecharts: opts.statecharts })
        : { session: sid, statechart: null, rows: 0, same: false, differences: [{ what: "log", why: "It has a snapshot but no log rows." }], divergence: null };
    } catch (err) {
      problems.push({ file: file ?? sid, why: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!verdict.same) differing.push(verdict);
  }
  const pendingJournal = existsSync(paths.journal) && readdirSync(paths.journal).some((f) => f.endsWith(".json"));
  return { orgId: opts.orgId, sessions: sids.length, differing, problems, pendingJournal };
}

/** The report as lines for a terminal. */
export function formatReport(r: VerifyReport): string {
  const out = [`${r.orgId}: ${r.sessions} session(s) replayed from the log; ${r.differing.length} differ from their snapshot.`];
  if (r.pendingJournal) out.push("A journal is waiting to be applied: open the organization once, then check again.");
  for (const v of r.differing) {
    out.push(`- ${v.session}${v.statechart ? ` (${v.statechart})` : ""}, ${v.rows} row(s):`);
    for (const d of v.differences)
      out.push(d.why ? `    ${d.what}: ${d.why}` : `    ${d.what}: replayed ${JSON.stringify(d.replayed)}, snapshot ${JSON.stringify(d.snapshot)}`);
    const g = v.divergence;
    if (g) {
      const where = g.at != null ? ` at ${g.at} (${g.event})` : " after its last row";
      const what = g.error ?? (g.why ? `${g.why}${g.replayedEvent ? ` (replayed ${g.replayedEvent})` : ""}` : `logged ${JSON.stringify(g.logged)}, replayed ${JSON.stringify(g.replayed)}`);
      out.push(`    first divergence${where}: ${what}`);
    }
  }
  for (const p of r.problems) out.push(`! ${p.file}: ${p.why}`);
  return out.join("\n");
}
