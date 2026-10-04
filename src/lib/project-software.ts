import type { DeployReview } from "../../shared/project-contract";
import { tickProgress } from "./project-deploy";
import type { ProjectRuntimeView, RuntimeMemory, RuntimeRunReview, RuntimeService, RuntimeStanding } from "../../shared/project-runtime";

/**
 * The Software card's words (§app.project-runtime/software-card), from the registry the page reads: the
 * standing's chip, the proof line, each service's facts and memory, and which actions show. Pure.
 */

export type ChipTone = "success" | "warn" | "error" | "info" | "accent";

export const STANDING_CHIP: Record<RuntimeStanding, { word: string; tone?: ChipTone }> = {
  unregistered: { word: "Unregistered" },
  "awaiting-approval": { word: "Awaiting approval", tone: "warn" },
  conforming: { word: "Checking", tone: "info" },
  registered: { word: "Registered", tone: "success" },
  stale: { word: "Out of date", tone: "warn" },
  failed: { word: "Failed", tone: "error" },
};

export const hash12 = (h: string): string => h.replace(/^sha256:/, "").slice(0, 12);

/** "512 MB", "1.4 GB" (decimal units, as the memory figures elsewhere). */
export function bytesWord(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} kB`;
}

/** A service's measured memory: "peak 512 MB · steady 380 MB", or null when nothing was read. */
export function memoryWord(m: RuntimeMemory | undefined): string | null {
  if (!m) return null;
  const parts = [m.peakBytes !== null ? `peak ${bytesWord(m.peakBytes)}` : null, m.steadyBytes !== null ? `steady ${bytesWord(m.steadyBytes)}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** "web 4000 · nrepl 7850". */
export const portsWord = (s: Pick<RuntimeService, "ports">): string => s.ports.map((p) => `${p.name} ${p.port}`).join(" · ");

/** The service's facts after its name: kind, scope, isolation method. */
export const serviceFacts = (s: Pick<RuntimeService, "kind" | "scope" | "isolation">): string => [s.kind, s.scope, s.isolation?.method].filter(Boolean).join(" · ");

/** Where it runs now: "main ready · feat-x starting", or null when no copy runs. */
export function liveWord(s: RuntimeService): string | null {
  return s.live.length ? s.live.map((l) => `${l.label} ${l.state}`).join(" · ") : null;
}

/** "Proven {time} at {hash12} (suite v{n})" without the time, which the card renders relative. */
export function provenTail(v: ProjectRuntimeView): string | null {
  const p = v.proof;
  if (!p || !p.pass) return null;
  return `at ${hash12(p.hash)} (suite v${p.suite})`;
}

/** The failure in words while failed. */
export function failedLine(v: ProjectRuntimeView): string | null {
  if (v.standing !== "failed") return null;
  if (v.def?.state === "invalid") return `The definition on main is invalid: ${v.def.error ?? ""}`;
  const f = v.proof?.failed;
  return f ? `Failed at ${f.check}: ${f.detail}` : null;
}

/** Run Playbook, or Run Again once something is registered. */
export const playbookLabel = (v: ProjectRuntimeView): string => (v.registered ? "Run Again" : "Run Playbook");

/** The approval button's label, or null when nothing waits. */
export const approveLabel = (v: ProjectRuntimeView): string | null => (v.can.approve ? `Approve ${hash12(v.can.approve)}` : null);

/** What the approval approves, in one line (main's definition, or the branch the playbook proposes). */
export function approveWhat(v: ProjectRuntimeView): string | null {
  if (!v.can.approve) return null;
  return v.can.approveBranch ? `The definition the playbook proposes on ${v.can.approveBranch}. Merge the branch after.` : "Main's definition runs on this host once approved; conformance then runs by itself.";
}

/** The playbook's run in a few words, for the link under the services. */
export function runWord(v: ProjectRuntimeView): string | null {
  const pb = v.playbook;
  if (!pb) return null;
  if (v.playbookState === "running") return `The ${pb.label} playbook is running`;
  if (v.playbookState === "proposed") return `The ${pb.label} playbook proposes ${pb.approves === "deploy" ? "a deploy recipe" : "a definition"} on ${pb.branch ?? "its branch"}`;
  if (v.playbookState === "waiting") return `The ${pb.label} playbook waits on your answers`;
  const ended: Record<string, string> = { "no-change": "finished with no change", merged: "was merged", removed: "had its worktree removed", "not-started": "could not start" };
  return `The last ${pb.label} run ${ended[pb.result ?? ""] ?? "ended"}`;
}

/** A sensitive data resource's chip title. */
export const SENSITIVE_TITLE = "Derived from production: copies of it are never shared.";

// ---- a live run's strip (§app.project-runtime/run-progress) and a proposed run's review (/run-report) ----

/** How long a run has gone: "under 1 min", "12 min", "2 h 5 min". */
export function elapsedWord(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "under 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** The strip of a live run, or null when no run is live: its state word, the session's "now" line, how long. */
export function runStrip(v: ProjectRuntimeView, nowMs: number): { state: string; now: string | null; questions: string | null; elapsed: string | null } | null {
  const pb = v.playbook;
  if (!pb || v.playbookState === "idle") return null;
  const started = Date.parse(pb.startedAt);
  const elapsed = Number.isFinite(started) ? elapsedWord(nowMs - started) : null;
  const n = pb.questions ?? pb.live?.questions ?? 0;
  const waiting = v.playbookState === "waiting";
  return {
    state: waiting ? "Waiting for your answers" : pb.live?.working ? "Working" : v.playbookState === "proposed" ? "Proposed" : "Idle",
    now: pb.live?.now ?? null,
    questions: waiting && n > 0 ? `${n} open question${n === 1 ? "" : "s"} in its session` : null,
    elapsed,
  };
}

/** Whether copies of the proposed definition can be shared, in words. */
export function shareWord(r: RuntimeRunReview): string {
  if (!r.share || (r.share.allow && !r.share.endpoints.length)) return "Shares nothing";
  if (!r.share.allow) return "Never shared";
  return `Shares ${r.share.endpoints.join(", ")}`;
}

/** Where a person opens the app, in words. */
export const openWord = (r: RuntimeRunReview): string => (r.open ? `Opens at ${r.open.endpoint}${r.open.path}` : "No entry point");

/** The proposed definition's conformance, in words. */
export function reviewProofWord(r: RuntimeRunReview): string {
  const p = r.proof;
  if (!p) return "No conformance of this definition yet";
  if (!p.pass) return `Conformance failed at ${p.failed?.check ?? "run"}: ${p.failed?.detail ?? ""}`;
  return `Conformance passed (${p.confined ? "confined" : "unconfined"}, suite v${p.suite})`;
}

/** Why the branch proposes nothing to approve, or null when it has a valid definition. */
export function reviewDefProblem(r: RuntimeRunReview): string | null {
  if (r.def.state === "absent") return "Its branch has no .sova/project.json.";
  if (r.def.state === "invalid") return `The definition on its branch is invalid: ${r.def.error ?? ""}`;
  return null;
}

/** Why a deploy-setup run's Approve & Merge can't go yet: steps of its recipe not ticked; null once every one is. */
export function deployTickBlock(review: Pick<DeployReview, "keys">, ticked: ReadonlySet<string>): string | null {
  const p = tickProgress(review, ticked);
  return p.left ? `Tick every step first: ${p.line}.` : null;
}
