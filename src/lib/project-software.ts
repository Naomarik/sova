import type { ProjectRuntimeView, RuntimeMemory, RuntimeService, RuntimeStanding } from "../../shared/project-runtime";

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
export const portsWord = (s: RuntimeService): string => s.ports.map((p) => `${p.name} ${p.port}`).join(" · ");

/** The service's facts after its name: kind, scope, isolation method. */
export const serviceFacts = (s: RuntimeService): string => [s.kind, s.scope, s.isolation?.method].filter(Boolean).join(" · ");

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
  if (v.playbookState === "running") return "The Project verbs playbook is running";
  if (v.playbookState === "proposed") return `The Project verbs playbook proposes a definition on ${pb.branch ?? "its branch"}`;
  const ended: Record<string, string> = { "no-change": "finished with no change", merged: "was merged", removed: "had its worktree removed", "not-started": "could not start" };
  return `The last Project verbs run ${ended[pb.result ?? ""] ?? "ended"}`;
}
