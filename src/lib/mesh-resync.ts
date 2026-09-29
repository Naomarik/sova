// Mesh version resync (§mesh.peers/resync), the page's side: what the host menu says under a host
// on another version, whether it offers Resync, and the words of the confirm sheet. Pure, so node
// tests run it without a DOM. Types: shared/mesh-resync.ts.

import type { ResyncHost, ResyncJob, ResyncSelf } from "../../shared/mesh-resync";

export type { MeshResync, ResyncHost, ResyncJob, ResyncSelf } from "../../shared/mesh-resync";

/** How often the menu and the sheet re-read /api/mesh/resync while a job runs. */
export const RESYNC_POLL_MS = 2_000;

export const shortCommit = (c: string | undefined): string => (c ? c.slice(0, 7) : "unknown");

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const jobRunning = (job: ResyncJob | undefined): boolean => job?.state === "running" || job?.state === "waiting";

/**
 * What the host menu shows under a host: `line` (null: nothing), and the Resync button (null: none;
 * `reason` set: shown disabled, the reason said under the host too). Only a skewed host that is
 * behind gets a button, and a running job replaces it with its progress.
 */
export function resyncView(h: ResyncHost | undefined, self: ResyncSelf): { line: string | null; button: { reason?: string } | null } {
  if (!h) return { line: null, button: null };
  if (h.job?.state === "running") return { line: `Resyncing to ${shortCommit(h.job.commit)}…`, button: null };
  if (h.job?.state === "waiting") return { line: `Deployed; waiting for ${h.label} to come back…`, button: null };
  if (h.state !== "skewed") return { line: h.job?.state === "done" ? `Resynced to ${shortCommit(h.job.commit)}` : null, button: null };
  const failed = h.job?.state === "failed" ? "Last resync failed. " : "";
  switch (h.relation) {
    case "behind": {
      const where = h.distance !== undefined ? `${plural(h.distance, "commit")} behind ${self.label}` : `Behind ${self.label}`;
      // This host's own block is about every host: the menu says it once (resyncNote), not under each.
      if (self.blocked) return { line: `${failed}${where}`, button: { reason: self.blocked } };
      const reason = h.recipe === null ? `No resync recipe for ${h.label} on ${self.label}` : h.recipeProblem ? `Its recipe can't run: ${h.recipeProblem}` : undefined;
      return { line: `${failed}${where}${reason ? `. ${reason}` : ""}`, button: reason ? { reason } : {} };
    }
    case "ahead":
      return { line: `${failed}Newer than ${self.label}. Update ${self.label} to match it.`, button: null };
    case "same":
      return { line: `${failed}Same commit as ${self.label}`, button: null };
    case "diverged":
      return { line: `${failed}On another branch than ${self.label}`, button: null };
    default:
      return { line: `${failed}${h.commit ? `Its commit ${shortCommit(h.commit)} isn't in ${self.label}'s checkout` : "It doesn't say its commit"}`, button: null };
  }
}

/** The one sentence the menu says about resync as a whole: why none can start from this host now,
    shown only when some host is behind (else it would be noise). null: nothing to say. */
export function resyncNote(r: { self: ResyncSelf; hosts: ResyncHost[] } | null): string | null {
  if (!r?.self.blocked || !r.hosts.some((h) => h.state === "skewed" && h.relation === "behind" && !jobRunning(h.job))) return null;
  return `Resync is off: ${r.self.blocked}`;
}

/** The confirm sheet's words, before the job starts. */
export function sheetText(h: ResyncHost, self: ResyncSelf): { title: string; what: string; running: string; job: string; action: string } {
  const apart = h.distance !== undefined ? `${plural(h.distance, "commit")} ahead of its ${shortCommit(h.commit)}` : `its build is ${shortCommit(h.commit)}`;
  const turns = h.activity?.turnsRunning ?? 0;
  const workers = h.activity?.workers ?? 0;
  const busy = [turns ? `${plural(turns, "turn")} running` : "", workers ? `${plural(workers, "worker")} working` : ""].filter(Boolean).join(" and ");
  const running = !h.activity
    ? `${h.label} didn't say what runs on it now; anything running there stops when it restarts.`
    : busy
      ? `${busy} on ${h.label} ${turns + workers === 1 ? "stops" : "stop"} when it restarts.`
      : `Nothing is running on ${h.label} now.`;
  const phone = h.recipe === "termux" ? " A phone takes several minutes." : "";
  return {
    title: `Resync ${h.label}?`,
    what: `${h.label} gets ${shortCommit(self.commit)}, the build ${self.label} runs (${apart}), and restarts onto it.`,
    running,
    job: `The job runs from ${self.label}: restarting ${self.label}'s server stops it.${phone}`,
    action: `Resync ${h.label}`,
  };
}

/** The sheet once a job exists: one sentence for where it is. */
export function jobText(job: ResyncJob, label: string): string {
  switch (job.state) {
    case "running":
      return `Deploying ${shortCommit(job.commit)} to ${label}…`;
    case "waiting":
      return `Deployed. Waiting for ${label} to answer on this version…`;
    case "done":
      return `${label} runs ${shortCommit(job.commit)} now.`;
    default:
      return job.error ?? "The resync failed.";
  }
}

/** The last `n` lines of a job's output, for the sheet. */
export const tailLines = (tail: string, n = 12): string => tail.split("\n").filter((l) => l.trim()).slice(-n).join("\n");
