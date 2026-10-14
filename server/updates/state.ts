import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UpdateCheck, UpdateJob, UpdateSource, UpdatesSettings } from "../../shared/protocol";

/**
 * `<stateRoot>/updates.json`: the Updates form, when the last check ran and what it
 * found, and the last finished upgrade. Read and written whole; a missing or unreadable file is the
 * defaults, and an unreadable field is that field's default.
 */
export interface UpdatesFile {
  source: UpdateSource;
  autoCheck: boolean;
  autoUpgrade: boolean;
  lastCheck: UpdateCheck | null;
  lastUpgrade: { id: string; from: string | null; to: string; at: string; outcome: UpdateJob["state"]; logPath: string } | null;
}

export const DEFAULT_SETTINGS: UpdatesSettings = { source: { kind: "stable" }, autoCheck: true, autoUpgrade: false };

/** A day: the automatic check's cadence. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** After a check that couldn't reach the repository. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;

/** A branch name git would take as a branch of the repository (a cheap `git check-ref-format --branch`). */
export function validBranchName(name: string): boolean {
  if (!name || name.length > 200 || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name) || name.includes("..") || name.includes("//") || name.includes("@{") || name === "@") return false;
  return name.split("/").every((part) => part.length > 0 && !part.startsWith("."));
}

/** A source as stored, or null when it isn't one. */
export function parseSource(v: unknown): UpdateSource | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (s.kind === "stable" || s.kind === "master") return { kind: s.kind };
  if (s.kind === "branch" && typeof s.branch === "string" && validBranchName(s.branch.trim())) return { kind: "branch", branch: s.branch.trim() };
  return null;
}

export const sameSource = (a: UpdateSource, b: UpdateSource): boolean => a.kind === b.kind && (a.kind !== "branch" || a.branch === (b as { branch: string }).branch);

/** The source as the section names it. */
export const sourceLabel = (s: UpdateSource): string => (s.kind === "stable" ? "Stable" : s.kind === "master" ? "master" : s.branch);

export function readUpdatesFile(path: string): UpdatesFile {
  let raw: Record<string, unknown> = {};
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) raw = v as Record<string, unknown>;
  } catch {
    // missing or unreadable: the defaults
  }
  const check = raw.lastCheck as UpdateCheck | undefined;
  const up = raw.lastUpgrade as UpdatesFile["lastUpgrade"] | undefined;
  return {
    source: parseSource(raw.source) ?? DEFAULT_SETTINGS.source,
    autoCheck: typeof raw.autoCheck === "boolean" ? raw.autoCheck : DEFAULT_SETTINGS.autoCheck,
    autoUpgrade: typeof raw.autoUpgrade === "boolean" ? raw.autoUpgrade : DEFAULT_SETTINGS.autoUpgrade,
    lastCheck: check && typeof check === "object" && typeof check.at === "string" && !Number.isNaN(Date.parse(check.at)) ? check : null,
    lastUpgrade: up && typeof up === "object" && typeof up.id === "string" ? up : null,
  };
}

export function writeUpdatesFile(path: string, file: UpdatesFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * When the next automatic check is due (ms since the epoch), or null when none is: the checkbox is
 * off, or checks are off on this server. A day after the last check, an hour after one that failed,
 * and at once when there was none. Pure.
 */
export function nextCheckDue(file: Pick<UpdatesFile, "autoCheck" | "lastCheck">, checksOff: boolean, now: number): number | null {
  if (checksOff || !file.autoCheck) return null;
  if (!file.lastCheck) return now;
  const at = Date.parse(file.lastCheck.at);
  // A last check in the future (a clock set back) counts from now, never waits for that day.
  const from = Number.isNaN(at) || at > now ? now : at;
  return from + (file.lastCheck.ok ? CHECK_EVERY_MS : RETRY_AFTER_MS);
}

/** SOVA_UPDATES_CHECK: off|0|false never checks, on|1|true always may; unset, a test process never checks. */
export function checksOffIn(env: NodeJS.ProcessEnv): boolean {
  const v = (env.SOVA_UPDATES_CHECK ?? "").toLowerCase();
  if (["off", "0", "false", "no"].includes(v)) return true;
  if (["on", "1", "true", "yes"].includes(v)) return false;
  return !!env.NODE_TEST_CONTEXT || env.NODE_ENV === "test";
}
