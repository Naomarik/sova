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
