import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectDef } from "../../shared/project-contract";
import { SLOT_CAP_MAX } from "../../shared/project-contract";
import { copyLimitOf, type CopyLimit } from "../../shared/project-slots";
import { canonicalPath } from "../paths";
import { servicesRoot, type InstanceRecord, type Registry } from "./store";

/**
 * This machine's own copy limit per project (§app.project-services/instances): kept in Sova's state,
 * `<state root>/project-services/copy-limits.json` (`{version: 1, projects: {<project root>: n}}`),
 * never in the project's files, host.json or the definition. `limitInForce` is the server's door to
 * the one rule (`copyLimitOf`): every reader of the limit goes through it.
 */

export const copyLimitsFile = () => join(servicesRoot(), "copy-limits.json");

type LimitsFile = { version: 1; projects: Record<string, number> };

function readFile(): LimitsFile {
  try {
    const raw = JSON.parse(readFileSync(copyLimitsFile(), "utf8")) as Partial<LimitsFile>;
    if (raw?.version === 1 && raw.projects && typeof raw.projects === "object") return { version: 1, projects: raw.projects };
  } catch {
    // none yet
  }
  return { version: 1, projects: {} };
}

const keyOf = (project: string) => canonicalPath(project);

/** This machine's own limit for the project, or null: none set (the project's file applies). */
export function machineCopyLimit(project: string): number | null {
  const v = readFile().projects[keyOf(project)];
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= SLOT_CAP_MAX ? v : null;
}

/** Why `v` can't be this machine's limit, or null. null itself is fine: it removes the machine's value. */
export function copyLimitProblem(v: unknown): string | null {
  if (v === null) return null;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= SLOT_CAP_MAX ? null : `The copy limit is a whole number from 1 to ${SLOT_CAP_MAX}, or null for the project's file's value.`;
}

/** Set (or with null, remove) this machine's own limit; resolves with the value it replaced. */
export function setMachineCopyLimit(project: string, v: number | null): number | null {
  const why = copyLimitProblem(v);
  if (why) throw new Error(why);
  const f = readFile();
  const key = keyOf(project);
  const before = machineCopyLimit(project);
  if (v === null) delete f.projects[key];
  else f.projects[key] = v;
  const file = copyLimitsFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`);
  renameSync(tmp, file);
  return before;
}

/** The limit in force for the project at `project` (its main checkout), with `inUse` the definition a verb runs from. */
export function limitInForce(project: string, inUse?: Pick<ProjectDef, "slots" | "services"> | null): CopyLimit {
  return copyLimitOf(project, { inUse: inUse ?? null, machine: machineCopyLimit(project) });
}

/** A copy that counts toward the limit: not the main checkout's, not conformance's, and wanting a service running. */
export const countsAsRunning = (i: Pick<InstanceRecord, "slot" | "createdBy" | "desired">): boolean =>
  i.slot !== 0 && !i.createdBy.startsWith("conform:") && Object.values(i.desired).some((d) => d === "running");

/** The project's running copies in the registry, by slot, leaving out `except` (the copy about to start). */
export const runningCopies = (r: Registry, project: string, except?: string): InstanceRecord[] =>
  r.instances.filter((i) => i.project === project && i.id !== except && countsAsRunning(i)).sort((a, b) => a.slot - b.slot);
