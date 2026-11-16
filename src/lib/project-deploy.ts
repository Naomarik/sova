// The Deploy panel's words (§app.project-runtime/deploy-panel), pure so they run under tsx --test:
// a target's standing chip, its last deploy, and a plan's checks and deadline. The panel (src/components/ProjectDeployPanel.tsx) renders them.

import type { DeployRecordView, DeployStanding, DeployTargetView } from "../../shared/project-contract";

export const short = (commit: string) => commit.slice(0, 7);
export const hash12 = (h: string) => h.replace(/^sha256:/, "").slice(0, 12);

/** Each standing's chip: a target main declares, or one only its history names. */
export const DEPLOY_STANDING_CHIP: Record<DeployStanding, { word: string; tone?: "success" | "warn" | "info" }> = {
  declared: { word: "Declared", tone: "info" },
  none: { word: "Not declared" },
};

/** A record's state as a chip: running is the live indicator. */
export const DEPLOY_STATE_CHIP: Record<DeployRecordView["state"], { word: string; tone?: "success" | "warn" | "error" | "accent" }> = {
  running: { word: "Deploying", tone: "accent" },
  succeeded: { word: "Deployed", tone: "success" },
  failed: { word: "Failed", tone: "error" },
  "verify-failed": { word: "Verify failed", tone: "error" },
  interrupted: { word: "Interrupted", tone: "error" },
};

/** "Deployed 1a2b3c4 · steps 2 of 2" / "Rollback of 1a2b3c4 failed: steps.sync exited with 3". */
export function recordLine(r: DeployRecordView, totalSteps?: number): string {
  const what = r.kind === "rollback" ? "Rollback of" : "Deploy of";
  if (r.state === "running") return `${r.kind === "rollback" ? "Rolling back to" : "Deploying"} ${short(r.commit)}${totalSteps ? ` · step ${Math.min(r.steps.length + 1, totalSteps)} of ${totalSteps}` : ""}`;
  if (r.state === "succeeded") return `${r.kind === "rollback" ? "Rolled back to" : "Deployed"} ${short(r.commit)}${r.verify ? ` · ${r.verify.url} answered ${r.verify.status}` : ""}`;
  if (r.state === "verify-failed") return `${what} ${short(r.commit)} ran, and its verify failed: ${r.detail ?? ""}`;
  if (r.state === "interrupted") return `${what} ${short(r.commit)} was interrupted: ${r.detail ?? ""}`;
  return `${what} ${short(r.commit)} failed: ${r.detail ?? ""}`;
}

/** What Rollback does for a target, or null when it can't. */
export function rollbackWord(t: Pick<DeployTargetView, "rollback" | "verifiedCommit">): string | null {
  if (typeof t.rollback === "object") return null;
  if (t.rollback === "steps") return "Runs the target's rollback steps.";
  return "Deploys the last verified commit before this one again.";
}

/** Deploy Now's confirm: "This ships 1a2b3c4 to prod: A local folder. Everyone using it gets it." — the about ends its sentence. */
export function shipConfirmLine(commit: string, target: string, about: string): string {
  const a = about.trim();
  return `This ships ${short(commit)} to ${target}: ${a}${/[.!?]$/.test(a) ? "" : "."} Everyone using it gets it.`;
}

/** A plan's checks folded to one line: "6 checks passed" / "5 checks passed · 1 let through"; `open` when any was let through. */
export function checksLine(checks: readonly { ok: boolean }[]): { line: string; open: boolean } {
  const let_ = checks.filter((c) => !c.ok).length;
  const passed = checks.length - let_;
  const line = `${passed} check${passed === 1 ? "" : "s"} passed${let_ ? ` · ${let_} let through` : ""}`;
  return { line, open: let_ > 0 };
}

/** "Expires in 12 min" / "Expired": a plan is good for 15 minutes. */
export function planDeadline(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return "Expired: plan again";
  const min = Math.ceil(ms / 60_000);
  return `Expires in ${min} min`;
}

/** Which typed reasons a needs-override refusal asks for, read from its sentence. */
export function overridesAsked(message: string): { tests: boolean; dirty: boolean } {
  return { tests: /overrideTests/.test(message), dirty: /overrideDirty/.test(message) };
}

/** One step on the Deploy tab's progress strip. */
export interface ProgressStep {
  key: string;
  /** "Build", "Upload", "Check URL": the step's id as the recipe names it, its first letter raised. */
  label: string;
  state: "done" | "now" | "failed" | "waiting";
}

const stepLabel = (key: string): string => {
  const id = key.replace(/^(build|steps|rollback)\./, "");
  return id ? id[0]!.toUpperCase() + id.slice(1) : key;
};

/**
 * A deploy's steps as the Deploy tab draws them: each step it ran, then the one running now, then what waits, the URL
 * check last. The record names only the steps that ended; the plan (when this page planned it) names the rest, else the
 * strip ends at the running step, so it never invents a step the deploy doesn't have.
 */
export function deployProgress(r: DeployRecordView, planned?: { steps: readonly { key: string }[]; verify: unknown | null }): ProgressStep[] {
  const out: ProgressStep[] = r.steps.map((s) => ({ key: s.key, label: stepLabel(s.key), state: s.exit === 0 && !s.timedOut ? "done" : "failed" }));
  const rest = planned ? planned.steps.filter((s) => !r.steps.some((x) => x.key === s.key)) : [];
  const running = r.state === "running";
  const ranAll = planned ? rest.length === 0 : false;
  if (running && !ranAll) {
    const [now, ...after] = rest.length ? rest : [{ key: `step.${r.steps.length + 1}` }];
    out.push({ key: now!.key, label: rest.length ? stepLabel(now!.key) : `Step ${r.steps.length + 1}`, state: "now" });
    for (const s of after) out.push({ key: s.key, label: stepLabel(s.key), state: "waiting" });
  } else if (!running) for (const s of rest) out.push({ key: s.key, label: stepLabel(s.key), state: "waiting" });
  const verify = r.verify ? true : planned ? planned.verify !== null : false;
  if (verify) {
    const state: ProgressStep["state"] = r.verify ? (r.verify.ok ? "done" : "failed") : running && ranAll ? "now" : "waiting";
    out.push({ key: "verify", label: "Check URL", state });
  }
  return out;
}

/** The progress card's line: "Deploying 1a2b3c4 to site · step 2 of 4 · upload" (of N only when the strip knows N). */
export function progressLine(r: DeployRecordView, steps: readonly ProgressStep[]): string {
  const i = steps.findIndex((s) => s.state === "now");
  const known = steps.every((s) => !s.label.startsWith("Step "));
  const verb = r.kind === "rollback" ? "Rolling back" : "Deploying";
  const where = `${verb} ${short(r.commit)} to ${r.target}`;
  if (i < 0) return where;
  return `${where} · step ${i + 1}${known ? ` of ${steps.length}` : ""}${known ? ` · ${steps[i]!.label.toLowerCase()}` : ""}`;
}

/** One History row's result: the URL check when the deploy ran one, else what happened to it. */
export function historyResult(r: DeployRecordView): { chip?: { word: string; tone?: "success" | "warn" | "error" | "accent" }; text: string } {
  if (r.verify && r.verify.status !== null) return { chip: { word: String(r.verify.status), tone: r.verify.ok ? "success" : "error" }, text: `${r.verify.url.replace(/^https?:\/\//, "").replace(/\/$/, "")} answered` };
  const c = DEPLOY_STATE_CHIP[r.state];
  const broke = r.state === "failed" ? r.steps.find((s) => s.exit !== 0 || s.timedOut) : undefined;
  return { chip: { word: r.kind === "rollback" && r.state === "succeeded" ? "Rolled back" : c.word, tone: c.tone }, text: broke ? `at ${stepLabel(broke.key).toLowerCase()}` : "" };
}

/** Every target's records, newest first: what the History list shows. */
export function deployHistory(per: readonly (readonly DeployRecordView[])[]): DeployRecordView[] {
  const seen = new Set<string>();
  return per
    .flat()
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/** The Deploy tab's dot: a deploy runs, or an overseer asked for one. */
export function deployDot(targets: readonly Pick<DeployTargetView, "last" | "request">[] | undefined): "running" | "asked" | null {
  if (!targets) return null;
  if (targets.some((t) => t.last?.state === "running")) return "running";
  if (targets.some((t) => t.request)) return "asked";
  return null;
}
