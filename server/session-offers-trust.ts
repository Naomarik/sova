import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runButtonsOf, type ParsedOffersFile } from "../shared/session-offers";
import { stateRoot } from "./state-root";

/**
 * Approvals of an offers file's run buttons (§chat.offers/approval), `<state root>/session-offers-trust.json`
 * `{version: 1, approved: {<project root>: {fingerprint, at}}}`: outside every repository, so no branch,
 * clone or chat approves itself. The fingerprint covers each run button's offer, label and id, so any
 * change to them asks again and a change to other text does not.
 */

export const offersTrustFile = () => join(stateRoot(), "session-offers-trust.json");

/** The fingerprint of a file's run buttons; null when it has none (nothing to approve). */
export function runFingerprint(file: ParsedOffersFile): string | null {
  const runs = runButtonsOf(file);
  if (!runs.length) return null;
  return createHash("sha256").update(JSON.stringify(runs.map((r) => [r.offer, r.label, r.run]))).digest("hex").slice(0, 16);
}

function readAll(file: string): Record<string, { fingerprint: string; at: string }> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; approved?: unknown };
    if (raw?.version !== 1 || !raw.approved || typeof raw.approved !== "object") return {};
    const out: Record<string, { fingerprint: string; at: string }> = {};
    for (const [k, v] of Object.entries(raw.approved as Record<string, Record<string, unknown>>))
      if (v && typeof v.fingerprint === "string") out[k] = { fingerprint: v.fingerprint, at: typeof v.at === "string" ? v.at : "" };
    return out;
  } catch {
    return {};
  }
}

/** Whether the run buttons of `root`'s file, as they are now, are approved (true when it has none). */
export function runsApproved(root: string, file: ParsedOffersFile, trust = offersTrustFile()): boolean {
  const fp = runFingerprint(file);
  return fp === null || readAll(trust)[root]?.fingerprint === fp;
}

/** Record `seen` as approved for `root`; refused when the file's run buttons are no longer what was seen. */
export function approveRuns(root: string, file: ParsedOffersFile, seen: unknown, trust = offersTrustFile()): void {
  const fp = runFingerprint(file);
  if (fp === null) throw new Error("This offers file has no run buttons: there is nothing to approve.");
  if (seen !== fp) throw new Error("The offers file's run buttons changed since they were shown. Look at them again, then approve.");
  const all = readAll(trust);
  all[root] = { fingerprint: fp, at: new Date().toISOString() };
  mkdirSync(dirname(trust), { recursive: true });
  const tmp = `${trust}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, approved: all }, null, 2)}\n`);
  renameSync(tmp, trust);
}
