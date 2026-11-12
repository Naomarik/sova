// The archive ask's running copies (§app.organizations/archive): what it lists, what its buttons
// say, and when Archive Project is available. Pure, so it runs under the test runner.

import type { ArchiveCopy } from "../../shared/projects";

/** The copies that keep the project from being archived: every listed one but an adopted main. */
export const blockingCopies = (copies: readonly ArchiveCopy[]): ArchiveCopy[] => copies.filter((c) => !c.adopted);

/** The copies Stop Running Copies stops: those Sova can stop. */
export const stoppableCopies = (copies: readonly ArchiveCopy[]): ArchiveCopy[] => copies.filter((c) => !c.adopted && c.down);

/** A listed copy's key (the shared services' entry has no instance). */
export const copyKey = (c: Pick<ArchiveCopy, "instance">): string => c.instance ?? "shared";

const copiesWord = (n: number) => (n === 1 ? "1 copy" : `${n} copies`);

/** The sentence over the list, or null when nothing blocks. */
export function copiesLead(copies: readonly ArchiveCopy[]): string | null {
  const n = blockingCopies(copies).length;
  if (!n) return null;
  return `${n === 1 ? "This still runs" : "These still run"}. Stop ${n === 1 ? "it" : "them"} to archive the project; ${n === 1 ? "its" : "their"} data stays.`;
}

/** A listed copy's state: one with a service failing and about to restart reads as Restarting. */
export function copyStateWord(c: Pick<ArchiveCopy, "services">): { word: string; tone: "success" | "warn" | "info" } {
  if (c.services.some((s) => s.state === "restarting")) return { word: "Restarting", tone: "warn" };
  if (c.services.some((s) => s.state === "starting")) return { word: "Starting", tone: "info" };
  return { word: "Running", tone: "success" };
}

/** What a listed copy runs, by service name. */
export const runsLine = (c: Pick<ArchiveCopy, "services">): string => c.services.map((s) => s.name).join(", ");

/** The line under an adopted main: listed, never stopped by Sova, and it doesn't block. */
export const ADOPTED_ARCHIVE_LINE = "Runs outside Sova; stop it yourself.";

/** Stop Running Copies, or its progress while it stops them one by one. */
export const stopLabel = (progress: { done: number; of: number } | null): string => (progress ? `Stopping ${Math.min(progress.done + 1, progress.of)} of ${progress.of}…` : "Stop Running Copies");

/** Why Archive Project is unavailable, or null when it can be pressed. */
export function archiveUnavailable(copies: readonly ArchiveCopy[] | undefined): string | null {
  if (!copies) return "Reading what runs";
  const n = blockingCopies(copies).length;
  return n ? `Stop ${n === 1 ? "the running copy" : `the ${n} running copies`} first` : null;
}

/** The archived banner's line while copies of it still run (they are left running). */
export function archivedRunningLine(copies: readonly ArchiveCopy[]): string | null {
  const left = blockingCopies(copies);
  const n = left.filter((c) => c.instance !== null).length;
  const shared = left.some((c) => c.instance === null);
  if (!n && !shared) return null;
  const what = n && shared ? `${copiesWord(n)} and its shared services still run` : n ? `${copiesWord(n)} of it still ${n === 1 ? "runs" : "run"}` : "Its shared services still run";
  return `${what}. Stop ${n === 1 && !shared ? "it" : "them"} on Branches.`;
}

/** After a stop pass: the copies still listed, each failed stop's sentence kept on its row. */
export function afterStops(listed: readonly ArchiveCopy[], errors: Readonly<Record<string, string>>): Record<string, string> {
  const keys = new Set(listed.map(copyKey));
  return Object.fromEntries(Object.entries(errors).filter(([k]) => keys.has(k)));
}
