import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORKER_REPORT_OUTCOMES, type DecisionProviderId, type DecisionSettings, type SessionSummary, type WorkerChecks, type WorkerReportOutcome } from "../shared/protocol";
import { withUsageContext } from "../pi-config/extensions/llm-inflight/attribution.ts";
import type { HEntry } from "../shared/harness";
import { contentText } from "../src/lib/message";
import { exclusionReason } from "./attention-signals";
import { DecisionError, type DecisionProvider, type JsonObject, type Question } from "./decide";
import { parseReport, parseTeamMessage, TEAM_REPORT_TYPE } from "./reports";
import { stateRoot } from "./state-root";
import { COMPLETION_TYPE } from "./worker-sessions";

/**
 * A worker's report check (§app.decisions/worker-report): when a subagent or team member reports
 * done, ONE decision over the report's text asks whether it finished and whether it says it is
 * done without saying it ran the tests or checks. Stored per session, worker and report in
 * `<stateRoot>/worker-checks.json`, so a report is asked once. Only with attention signals on and
 * through the parent's exclusions; the request goes through the redacting provider.
 */

/** The report body the request carries, at most. */
export const REPORT_CHARS = 4000;
/** `claims_unverified` at or above this, on a finished report, is the row's Untested chip. */
export const UNVERIFIED_MIN = 0.8;

export const QUESTIONS: Record<string, Question> = {
  report_outcome: {
    type: "choice",
    instructions: "How does this worker's report say its task ended? Judge from the report's `body` only.",
    options: {
      finished: "It says the task is done.",
      partial: "It did part of the task and says what is left.",
      blocked: "It stopped waiting on something or someone (a question, an access, a decision).",
      failed: "It says the task failed or could not be done.",
    },
  },
  claims_unverified: {
    type: "boolean",
    instructions:
      "Does the report say the work is done but NOT say that it ran the tests or checks (or say that it skipped them, or name something not run, tested or checked)? A report that says which tests or checks it ran and that they passed is no.",
  },
};

export const checksFile = () => join(stateRoot(), "worker-checks.json");

interface CheckRecord {
  report: string;
  at: number;
  provider: DecisionProviderId;
  model: string;
  outcome: WorkerReportOutcome;
  unverified: number;
}

/** One worker's newest report on the branch: who, its entry id and the parts the request carries. */
export interface WorkerReport {
  workerId: string;
  entry: string;
  name: string;
  status: string;
  outcome?: string;
  body: string;
}

const isRec = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function load(file: string): Record<string, CheckRecord> {
  const out: Record<string, CheckRecord> = Object.create(null);
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    if (!isRec(v) || !isRec(v.checks)) return out;
    for (const [k, r] of Object.entries(v.checks)) {
      if (!isRec(r) || typeof r.report !== "string" || !(WORKER_REPORT_OUTCOMES as readonly string[]).includes(r.outcome)) continue;
      const p = Number(r.unverified);
      out[k] = { report: r.report, at: Number(r.at) || 0, provider: r.provider, model: String(r.model ?? ""), outcome: r.outcome, unverified: Number.isFinite(p) ? p : 0 };
    }
  } catch {
    // missing or corrupt: empty
  }
  return out;
}

function save(file: string, checks: Record<string, CheckRecord>): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, checks }));
    renameSync(tmp, file);
  } catch (err) {
    console.warn("[worker-checks] write failed:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Each worker's newest done report on the branch: a `subagent-complete` whose task outcome is
 * success (the older "finished its task." header too), or a coordinator's team report. Reports of
 * other endings (error, aborted, killed) are no claim of done and are skipped. Pure.
 */
export function workerReports(branch: readonly HEntry[]): WorkerReport[] {
  const out = new Map<string, WorkerReport>();
  for (const h of branch) {
    if (h.kind !== "note" || !h.id) continue;
    const text = contentText(h.content);
    if (h.noteType === COMPLETION_TYPE) {
      const r = parseReport(COMPLETION_TYPE, text);
      const a = r.agent;
      if (!a) continue;
      const done = a.outcome ? a.outcome === "success" : a.status === "done";
      if (!done) {
        out.delete(a.id);
        continue;
      }
      out.set(a.id, { workerId: a.id, entry: h.id, name: a.name, status: a.status, ...(a.outcome ? { outcome: a.outcome } : {}), body: r.body });
    } else if (h.noteType === TEAM_REPORT_TYPE) {
      const m = parseTeamMessage(TEAM_REPORT_TYPE, text);
      if (!m) continue;
      out.set(m.team.workerId, { workerId: m.team.workerId, entry: h.id, name: m.team.role, status: m.team.label ?? "report", body: m.body });
    }
  }
  return [...out.values()];
}

/** The state of one report: the worker's name, status and task outcome, and the capped body. Pure. */
export function reportState(r: WorkerReport): JsonObject {
  const body = r.body.length > REPORT_CHARS ? `${r.body.slice(0, REPORT_CHARS)}…` : r.body;
  return { worker: r.name, status: r.status, ...(r.outcome ? { task_outcome: r.outcome } : {}), body };
}

export interface ChecksDeps {
  settings: () => DecisionSettings;
  provider: () => DecisionProvider | null;
  held: (path: string) => boolean;
  file?: string;
  now?: () => number;
  home?: string;
}

/**
 * The checks of a session's workers' newest reports, asking for any report not answered yet.
 * Never throws: a refused or failed request leaves that worker without a check.
 */
export async function workerChecks(s: SessionSummary, branch: readonly HEntry[], deps: ChecksDeps): Promise<WorkerChecks> {
  const file = deps.file ?? checksFile();
  const out: WorkerChecks = { workers: {} };
  const reports = workerReports(branch);
  if (!reports.length) return out;
  const settings = deps.settings();
  const allowed = settings.features.attention && !exclusionReason(s, settings, deps.held(s.path), deps.home);
  let checks = load(file);
  for (const r of reports) {
    const key = `${s.id}:${r.workerId}`;
    let rec = checks[key]?.report === r.entry ? checks[key] : undefined;
    if (!rec && allowed) {
      const provider = deps.provider();
      if (!provider) continue;
      try {
        const res = await withUsageContext({ owner: s.id, cwd: s.cwd, kind: "oneshot" }, () =>
          provider.decide({ purpose: "worker-report", state: reportState(r), questions: QUESTIONS, dedupeKey: `worker-report:${key}:${r.entry}` }),
        );
        const o = res.answers.report_outcome;
        const u = res.answers.claims_unverified;
        if (o?.type !== "choice" || !(WORKER_REPORT_OUTCOMES as readonly string[]).includes(o.choice) || u?.type !== "boolean") continue;
        rec = { report: r.entry, at: (deps.now ?? Date.now)(), provider: res.provider, model: res.model, outcome: o.choice as WorkerReportOutcome, unverified: u.p };
        checks = load(file);
        checks[key] = rec;
        save(file, checks);
      } catch (err) {
        if (err instanceof DecisionError && err.failure === "bad-request") console.error("[worker-checks] question rejected:", err.message);
        continue;
      }
    }
    if (rec)
      out.workers[r.workerId] = {
        report: rec.report,
        provider: rec.provider,
        model: rec.model,
        outcome: rec.outcome,
        unverified: rec.outcome === "finished" && rec.unverified >= UNVERIFIED_MIN,
      };
  }
  return out;
}
