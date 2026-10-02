/** Observation-only assessment transport and task snapshots. Node builtins only: also used by native worker hooks. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const ASSESSMENT_TASK_ENTRY = "spec-assessment-task-v1";
export const ASSESSMENT_OWNER_ENV = "SOVA_SPEC_OWNER_SESSION";
export const ASSESSMENT_WORKER_ENV = "SOVA_SPEC_WORKER_ID";
export const ASSESSMENT_TEAM_ENV = "SOVA_SPEC_TEAM_ID";
export interface AssessmentAttribution {
 ownerSessionId: string | null; sessionId: string | null; workerId: string | null;
 teamId: string | null; taskId: string | null; attemptId: string | null;
}
export interface AssessmentInput {
 path: string; state: "present" | "absent" | "refused"; sha256?: string; bytes?: number; why?: string;
}
export interface AssessmentTask {
 v: 1; sessionId: string | null; taskId: string | null; base: string | null;
 baseline: { inputs: AssessmentInput[] }; paths: string[]; fingerprint?: string;
 receipt?: string; unknowns: string[];
}
export type AssessmentReply = Record<string, unknown>;
export type AssessmentCall = (core: string, cwd: string, args: string[], signal?: AbortSignal) => Promise<AssessmentReply>;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\x00-\x1f\x7f]/.test(v);
export function assessmentAttribution(sessionId: string | undefined, taskId: string | null, attemptId: string | null, worker: boolean, env: NodeJS.ProcessEnv = process.env): AssessmentAttribution {
 return { sessionId: text(sessionId) ? sessionId : null, taskId, attemptId,
  ownerSessionId: worker ? text(env[ASSESSMENT_OWNER_ENV]) ? env[ASSESSMENT_OWNER_ENV]! : null : text(sessionId) ? sessionId : null,
  workerId: worker && text(env[ASSESSMENT_WORKER_ENV]) ? env[ASSESSMENT_WORKER_ENV]! : null,
  teamId: worker && text(env[ASSESSMENT_TEAM_ENV]) ? env[ASSESSMENT_TEAM_ENV]! : null };
}

/** Bounded, no-shell subprocess; a truncated/failed transport is explicitly unavailable, never an empty success. */
export const callAssessment: AssessmentCall = (core, cwd, args, signal) => new Promise((resolve) => {
 let stdout = "", stderr = "", bytes = 0, finished = false;
 const decoder = new StringDecoder("utf8");
 const done = (value: AssessmentReply) => { if (!finished) { finished = true; resolve(value); } };
 const child = spawn(process.execPath, [join(core, "sova-spec-assess.mjs"), ...args, "--root", cwd, "--json"], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, signal });
 child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { child.kill(); done({ exit: 2, unavailable: "assessment output exceeded transport limit" }); } else stdout += decoder.write(chunk); });
 child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 1000); });
 child.on("error", () => done({ exit: 2, unavailable: "assessment subprocess unavailable" }));
 child.on("close", (code, signal) => {
  try { const value = JSON.parse(stdout + decoder.end()); if (!value || typeof value !== "object" || Array.isArray(value) || signal || !Number.isInteger(value.exit) || value.exit !== code) throw new Error(); done(value); }
  catch { done({ exit: 2, unavailable: stderr ? "assessment subprocess returned no structured result" : "assessment result missing or unreadable" }); }
 });
});

export function decodeAssessmentTask(value: unknown): AssessmentTask | undefined {
 const v = value as AssessmentTask | undefined;
 if (!v || v.v !== 1 || !(v.sessionId === null || text(v.sessionId)) || !(v.taskId === null || text(v.taskId)) || !(v.base === null || text(v.base)) || !Array.isArray(v.baseline?.inputs) || !Array.isArray(v.paths) || !Array.isArray(v.unknowns)) return;
 if (!v.paths.every(p => typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..")) || !v.unknowns.every(p => typeof p === "string")) return;
 if (v.fingerprint !== undefined && (typeof v.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(v.fingerprint))) return;
 if (v.receipt !== undefined && (typeof v.receipt !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v.receipt))) return;
 if (!v.baseline.inputs.every(i => i && typeof i.path === "string" && ["present", "absent", "refused"].includes(i.state) && (i.state !== "present" || typeof i.sha256 === "string" && /^[a-f0-9]{64}$/.test(i.sha256) && Number.isSafeInteger(i.bytes)))) return;
 return structuredClone(v);
}

/** Capture BEFORE the first tool. Pre-dirty bytes are separate declared snapshots, never called HEAD bytes. */
export async function startAssessmentTask(core: string, cwd: string, sessionId: string | null, taskId: string | null, call: AssessmentCall = callAssessment, signal?: AbortSignal): Promise<AssessmentTask> {
 const preview = await call(core, cwd, ["prepare", `initial-${randomUUID()}`], signal);
 const query = preview.query as { base?: unknown } | undefined;
 const base = typeof query?.base === "string" && /^[a-f0-9]{40,64}$/.test(query.base) ? query.base : null;
 const paths = Array.isArray(preview.changedFiles) ? preview.changedFiles.filter((p): p is string => typeof p === "string") : [];
 const task: AssessmentTask = { v: 1, sessionId, taskId, base, baseline: { inputs: [] }, paths: [], unknowns: [] };
 const second = await call(core, cwd, ["prepare", `initial-${randomUUID()}`, ...(base ? ["--base", base] : [])], signal);
 if (typeof preview.fingerprint !== "string" || second.fingerprint !== preview.fingerprint) task.unknowns.push("initial input capture unavailable");
 if (!base) task.unknowns.push("initial Git inventory unavailable");
 if (!Array.isArray(preview.inputs)) task.unknowns.push("initial input capture unavailable");
 if (paths.length) {
  const inputs = Array.isArray(preview.inputs) ? preview.inputs as AssessmentInput[] : [];
  task.baseline.inputs = paths.map(path => {
   const input = inputs.find(i => i.path === path);
   return input && ["present", "absent", "refused"].includes(input.state) ? { path, state: input.state, ...(input.sha256 ? { sha256: input.sha256 } : {}), ...(typeof input.bytes === "number" ? { bytes: input.bytes } : {}), ...(input.why ? { why: input.why } : {}) } : { path, state: "refused", why: "initial dirty input capture unavailable" };
  });
  if (task.baseline.inputs.some(i => i.state === "refused")) task.unknowns.push("initial dirty inputs incomplete");
 }
 return task;
}

export function assessmentPrepareArgs(task: AssessmentTask, name: string, attribution: AssessmentAttribution, paths: readonly string[] = []): string[] {
 return ["prepare", name, ...(task.base ? ["--base", task.base] : []), "--baseline-json", JSON.stringify(task.baseline), ...paths.flatMap(p => ["--path", p]), "--attribution-json", JSON.stringify(attribution)];
}

/** Each changed exact capture gets a fresh immutable receipt. No disposition is synthesized. */
export async function observeAssessment(core: string, cwd: string, task: AssessmentTask, attribution: AssessmentAttribution, call: AssessmentCall = callAssessment, signal?: AbortSignal): Promise<{ receipt?: AssessmentReply; failure?: string }> {
 if (task.unknowns.includes("initial input capture unavailable")) return { failure: "task initial inputs unavailable; cannot reconstruct its baseline" };
 const name = `task-${randomUUID()}`;
 const args = assessmentPrepareArgs(task, name, attribution, task.base ? [] : task.paths);
 const preview = await call(core, cwd, args, signal);
 if (!Array.isArray(preview.changedFiles) || typeof preview.fingerprint !== "string") return { failure: String(preview.unavailable ?? "assessment preview incomplete") };
 if (task.base === null && (preview.query as { base?: unknown } | undefined)?.base !== null) return { failure: "task began without a Git base; a later HEAD cannot replace it" };
 if ((!preview.changedFiles.length && (!Array.isArray(preview.unknowns) || !preview.unknowns.length)) || task.fingerprint === preview.fingerprint) return {};
 const written = await call(core, cwd, [...args, "--write"], signal);
 if (written.written !== true || typeof written.fingerprint !== "string") return { failure: String(written.unavailable ?? "assessment receipt was not persisted") };
 task.fingerprint = written.fingerprint; task.receipt = name;
 return { receipt: written };
}
