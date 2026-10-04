import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectDef } from "../../shared/project-contract";
import { approvalsFile, hostVarsFile } from "./store";

/**
 * Approval of a definition (§app.project-services/trust), shaped like server/profile-trust.ts:
 * `<state root>/project-services/approvals.json` `{version: 1, approved: {<project root>:
 * {<defHash>: {at}}}}`, outside every repo, so no branch or clone can approve itself.
 */

/** Drop what tuning may change without approval: every `timeout`, readiness paths, a service's `about` and
    `isolation` (words for builders and readers), the top-level `sources` (what drift reads), `open` (the entry
    point, which exposes nothing) and `deploy` (approved under its own hash, deploy-trust.ts); the default
    `start: "up"` too, so a definition hashes as it did before `start` existed. */
export function hashed(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => hashed(x, key));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    if (k === "timeout") continue;
    if (key === "" && (k === "sources" || k === "open" || k === "deploy")) continue;
    if (key === "ready" && k === "path") continue;
    if (key === "services" && (k === "about" || k === "isolation" || (k === "start" && (v as Record<string, unknown>)[k] === "up"))) continue;
    out[k] = hashed((v as Record<string, unknown>)[k], k);
  }
  return out;
}

/** The definition's hash: `sha256:<hex>` of its canonical JSON minus what `hashed` drops. */
export function defHashOf(def: ProjectDef): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(hashed(def))).digest("hex")}`;
}

type Approvals = Record<string, Record<string, { at: string }>>;

export function readApprovals(file = approvalsFile()): Approvals {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; approved?: unknown };
    if (raw?.version !== 1 || !raw.approved || typeof raw.approved !== "object") return {};
    return raw.approved as Approvals;
  } catch {
    return {};
  }
}

export const isApproved = (project: string, defHash: string, file = approvalsFile()): boolean => !!readApprovals(file)[project]?.[defHash];

/**
 * Approve `seen` for `project`: refused unless it is still the hash of `current` (the definition as
 * it reads now), so what is approved is what was shown.
 */
export function approve(project: string, seen: string, current: string, file = approvalsFile()): void {
  if (seen !== current) throw new Error(`The definition changed since it was shown: it is ${current} now, not ${seen}. Look at it again, then approve.`);
  const all = readApprovals(file);
  all[project] = { ...(all[project] ?? {}), [seen]: { at: new Date().toISOString() } };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, approved: all }, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Host variables (`host` names) per project root: `{version: 1, projects: {<root>: {NAME: value}}}`, set by the operator by hand. */
export function hostVars(project: string, file = hostVarsFile()): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; projects?: Record<string, Record<string, unknown>> };
    if (raw?.version !== 1) return {};
    const vars = raw.projects?.[project] ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}
