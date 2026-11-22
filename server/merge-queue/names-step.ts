/**
 * The run step "Private names and secrets" (step id "scan"): the publish scan (publish-scan.ts) made a real, visible
 * step of every run whose landing pushes. It reads what the landing adds (`<base>..<tip>` in the merge copy), says
 * where each thing that looks private is and what kind it is, never the matched text, and skips what the user marked
 * fine for this project (Allow, kept in the project's queue folder).
 *
 * A hit fails the step; the queue never lands a tip whose scan found anything not allowed (queue.ts landTested), and
 * the entry waits for the user: Allow, Send Back (the branch's chat removes them) or Ask the Merge Thread. No private
 * names list yet: the secrets are still scanned, it lands, and its push waits for the names interview (one click: No
 * private names).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LandHow, ScanFacts, ScanHit } from "../../shared/merge-queue";
import type { ProjectDef } from "../../shared/project-contract";
import type { Git } from "./guard";
import { NAMES_NOT_SET_UP, type ScanResult, scanPublication } from "./publish-scan";

export const SCAN_STEP_ID = "scan";
export const SCAN_STEP_LABEL = "Private names and secrets";
/** The allow list's file, in the project's queue folder (never in the repository). */
export const ALLOW_FILE = "names-allowed.json";

/** Does a run of this landing push (and so scan)? The plan reads this too, so planned and actual agree. */
export function scanPlanned(o: { def: ProjectDef | null; how: LandHow; hasRemote: boolean }): { run: true } | { run: false; why: string } {
  // A request or a pushed branch publishes the branch whatever merge.push says (that is the target's push).
  if (o.how === "local" && o.def?.merge?.push === false) return { run: false, why: "this project doesn't push from the queue" };
  if (!o.hasRemote) return { run: false, why: "no remote to push to" };
  return { run: true };
}

// ---- Allow: the matches this project marked fine ----------------------------------------------------

/** One allowed match: its key (publish-scan foundKey) and where it was when allowed (no matched text). */
export interface AllowedMatch {
  key: string;
  what: string;
  where: string;
  at: string;
  run?: string;
  entry?: string;
}

export const allowFileOf = (queueDir: string): string => join(queueDir, ALLOW_FILE);

export function readAllowed(file: string): AllowedMatch[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { v?: number; allowed?: unknown };
    return Array.isArray(raw.allowed) ? (raw.allowed as AllowedMatch[]).filter((a) => a && typeof a.key === "string") : [];
  } catch {
    return [];
  }
}

export const allowedKeys = (file: string): Set<string> => new Set(readAllowed(file).map((a) => a.key));

/** Mark `hits` fine for this project (the user's Allow): kept for good, one row per key. Returns how many were new. */
export function allowMatches(file: string, hits: readonly ScanHit[], meta: { at: string; run?: string; entry?: string }): number {
  const had = readAllowed(file);
  const known = new Set(had.map((a) => a.key));
  const add = hits.filter((h) => !known.has(h.key) && (known.add(h.key), true)).map((h): AllowedMatch => ({ key: h.key, what: h.what, where: h.where, at: meta.at, ...(meta.run ? { run: meta.run } : {}), ...(meta.entry ? { entry: meta.entry } : {}) }));
  if (!add.length) return 0;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, allowed: [...had, ...add] }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return add.length;
}

// ---- the step itself -------------------------------------------------------------------------------

/** The scan's result as the step shows it. */
export function factsOf(r: ScanResult): ScanFacts {
  const allowed = r.allowed ? { allowed: r.allowed } : {};
  const commits = r.commits !== undefined ? { commits: r.commits } : {};
  if (r.ok) return { state: r.names === false ? "unanswered" : "clean", ...commits, ...allowed };
  if (r.found?.length) return { state: "hits", ...commits, hits: r.found, ...allowed, why: r.why, ...(r.names === false ? { names: false } : {}) };
  return { state: "unreadable", why: r.why, ...commits };
}

/** One line for the step's row. */
export function scanDetail(f: ScanFacts): string {
  const n = f.commits ?? 0;
  const of = `${n} commit${n === 1 ? "" : "s"}`;
  const ok = f.allowed ? ` (${f.allowed} marked fine for this project)` : "";
  switch (f.state) {
    case "clean":
      return `nothing private in ${of}${ok}`;
    case "unanswered":
      return `no secrets in ${of}${ok}; private names not set up yet: it lands, and its push waits for your answer`;
    case "hits": {
      const h = f.hits ?? [];
      return `${h.length} thing${h.length === 1 ? "" : "s"} that look private: ${h[0]?.where ?? ""} · ${h[0]?.what ?? ""}${h.length > 1 ? ", …" : ""}`;
    }
    case "unreadable":
      return `couldn't scan (${f.why ?? "unknown"}): it lands, and nothing is pushed until a scan passes`;
  }
}

/** The step's result for its facts: only a hit fails it. */
export const scanResultOf = (f: ScanFacts): "passed" | "failed" | "skipped" => (f.state === "hits" ? "failed" : f.state === "unreadable" ? "skipped" : "passed");

/** Scan what this landing adds, in the merge copy. */
export function runScan(git: Git, o: { copy: string; base: string; tip: string; namesFile?: string; allowFile: string }): Promise<ScanResult> {
  return scanPublication(git, { repo: o.copy, range: `${o.base}..${o.tip}`, ...(o.namesFile ? { namesFile: o.namesFile } : {}), namesMissing: "secrets-only", allowed: allowedKeys(o.allowFile) });
}

/** The hits of a run's scan step not allowed since (a run that predates the step has none). */
export function openHits(steps: readonly { id: string; scan?: ScanFacts }[] | undefined, allowFile: string): ScanHit[] {
  const s = steps?.find((x) => x.id === SCAN_STEP_ID)?.scan;
  if (s?.state !== "hits" || !s.hits?.length) return [];
  const ok = existsSync(allowFile) ? allowedKeys(allowFile) : new Set<string>();
  return s.hits.filter((h) => !ok.has(h.key));
}

/** The words of a hit list, for a request, a decision or the thread: where and what, never the text. */
export function hitLines(hits: readonly ScanHit[], max = 12): string[] {
  const out = hits.slice(0, max).map((h) => `- ${h.where} · ${h.what}`);
  if (hits.length > max) out.push(`- … and ${hits.length - max} more (the run's step lists them all)`);
  return out;
}

/** The names file answers "No private names" (an empty list). */
export function namesListEmpty(file: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { privateNames?: unknown };
    return Array.isArray(raw.privateNames) && !raw.privateNames.some((x) => typeof x === "string" && x.trim());
  } catch {
    return false;
  }
}

export { NAMES_NOT_SET_UP };
