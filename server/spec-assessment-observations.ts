import { readFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionSummary, SpecAssessmentAttribution, SpecAssessmentObservation, SpecAssessmentObservations, SpecVerificationBasis } from "../shared/protocol";
import { ASSESSMENT_TASK_ENTRY, callAssessment, type AssessmentCall } from "../pi-config/extensions/mode/spec-assessment.ts";
import { readWorkerManifests } from "../pi-config/extensions/subagents/worker-transcript.ts";
import { activeBranch, type Entry } from "./transcript";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const attrKeys = ["ownerSessionId", "sessionId", "workerId", "teamId", "taskId", "attemptId"] as const;
const emptyAttribution = (): SpecAssessmentAttribution => ({ ownerSessionId: null, sessionId: null, workerId: null, teamId: null, taskId: null, attemptId: null });
function attribution(v: unknown): SpecAssessmentAttribution | undefined {
 if (!object(v) || !attrKeys.every(k => v[k] === null || typeof v[k] === "string" && (v[k] as string).length > 0 && (v[k] as string).length <= 128)) return;
 return Object.fromEntries(attrKeys.map(k => [k, v[k]])) as unknown as SpecAssessmentAttribution;
}
interface SessionEvidence { id?: string; cwd?: string; entries: Entry[]; branch: Entry[]; partial: boolean; reason?: string }
/** Own parser only: opening a foreign SDK session would mutate its file. Torn lines remain explicit. */
async function sessionEvidence(file: string): Promise<SessionEvidence> {
 try {
  const st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 16 * 1024 * 1024) return { entries: [], branch: [], partial: true, reason: "session attribution input refused or too large" };
  const text = await readFile(file, "utf8");
  const lines = text.split("\n"); let partial = !text.endsWith("\n"), id: string | undefined, cwd: string | undefined;
  const entries: Entry[] = [];
  for (const line of lines) {
   if (!line.trim()) continue;
   try {
    const v: unknown = JSON.parse(line);
    if (!object(v)) { partial = true; continue; }
    if (v.type === "session") { if (typeof v.id === "string") id = v.id; if (typeof v.cwd === "string") cwd = v.cwd; continue; }
    if (typeof v.id !== "string" || typeof v.type !== "string") { partial = true; continue; }
    entries.push(v as unknown as Entry);
   } catch { partial = true; }
  }
  return { id, cwd, entries, branch: activeBranch(entries), partial };
 } catch { return { entries: [], branch: [], partial: true, reason: "session attribution input unavailable" }; }
}
function taskMatches(evidence: SessionEvidence, attr: SpecAssessmentAttribution, root: string): { state: "matched" | "unknown" | "conflicting"; reasons: string[] } {
 if (evidence.partial || !evidence.id) return { state: "unknown", reasons: [evidence.reason ?? "session attribution input incomplete"] };
 if (attr.sessionId !== evidence.id) return { state: "conflicting", reasons: ["receipt session does not match persisted session"] };
 const users = evidence.branch.filter(e => e.type === "message" && (e as unknown as { message?: { role?: string } }).message?.role === "user");
 const newest = users.at(-1);
 if (!attr.taskId || !attr.attemptId || !newest) return { state: "unknown", reasons: ["task or attempt attribution unavailable"] };
 if (newest.id !== attr.taskId) return { state: "conflicting", reasons: ["receipt does not name the current persisted task boundary"] };
 const saved = evidence.branch.some(e => {
  const v = e as unknown as { type?: string; customType?: string; data?: { root?: string; attemptId?: string; task?: { taskId?: string; sessionId?: string } } };
  return v.type === "custom" && v.customType === ASSESSMENT_TASK_ENTRY && v.data?.task?.taskId === attr.taskId && v.data.task.sessionId === attr.sessionId && v.data.attemptId === attr.attemptId && typeof v.data.root === "string" && resolve(v.data.root) === resolve(root);
 });
 return saved ? { state: "matched", reasons: [] } : { state: "unknown", reasons: ["attempt snapshot not found on the current persisted branch"] };
}
function bases(value: unknown): { items: SpecVerificationBasis[]; incomplete: boolean } {
 const items: SpecVerificationBasis[] = []; let incomplete = false;
 if (!object(value)) return { items, incomplete: true };
 for (const result of ["passed", "failed", "unknown"]) {
  const group = value[result];
  if (!Array.isArray(group)) { incomplete = true; continue; }
  for (const b of group) {
   if (!object(b) || !["test", "inspection", "command"].includes(String(b.kind)) || b.result !== result || typeof b.summary !== "string" || !b.summary.trim() || !(b.revision === null || typeof b.revision === "string")) { incomplete = true; continue; }
   const binding = b.revisionBinding;
   const valid = object(binding) && binding.source === "recorder-declaration" && (binding.revisionCommit === null || typeof binding.revisionCommit === "string" && /^[a-f0-9]{40,64}$/.test(binding.revisionCommit)) && ["matching", "mismatched", "unknown"].includes(String(binding.inputApplicability));
   if (!valid) incomplete = true;
   items.push({ kind: b.kind as SpecVerificationBasis["kind"], revision: b.revision as string | null, result: result as SpecVerificationBasis["result"], summary: b.summary,
    revisionBinding: valid ? binding as unknown as NonNullable<SpecVerificationBasis["revisionBinding"]> : { source: "recorder-declaration", revisionCommit: null, inputApplicability: "unknown" } });
  }
 }
 return { items, incomplete };
}
function observationError(evidence: SessionEvidence): boolean {
 const user = evidence.branch.filter(e => e.type === "message" && (e as unknown as { message?: { role?: string } }).message?.role === "user").at(-1);
 return evidence.branch.some(e => {
  const v = e as unknown as { customType?: string; data?: { taskId?: unknown } };
  return v.customType === "spec-assessment-error" && (!v.data?.taskId || v.data.taskId === user?.id);
 });
}
export interface SpecObservationDeps { core?: string; call?: AssessmentCall }

/** No policy synthesis: retains every receipt, including newer unresolved and older recorded observations. */
export async function readSpecAssessmentObservations(session: Pick<SessionSummary, "id" | "path">, roots: readonly string[], deps: SpecObservationDeps = {}): Promise<SpecAssessmentObservations | undefined> {
 const core = deps.core ?? join(getAgentDir(), "extensions/spec/core");
 const call = deps.call ?? callAssessment;
 const owner = await sessionEvidence(session.path);
 const relevant: string[] = [];
 for (const root of [...new Set(roots)]) {
  try { await lstat(join(root, ".sova/spec/manifest.json")); relevant.push(root); }
  catch (error) {
   if ((error as NodeJS.ErrnoException).code !== "ENOENT" || owner.entries.some(e => (e as unknown as { customType?: string }).customType === ASSESSMENT_TASK_ENTRY)) relevant.push(root);
  }
 }
 if (!relevant.length) return undefined;
 const out: SpecAssessmentObservations = { state: "absent", items: [], reasons: [] };
 const workerFold = readWorkerManifests(owner.entries);
 if (owner.partial || owner.id !== session.id || workerFold.refused) { out.state = "incomplete"; out.reasons.push("owner session or worker manifest attribution incomplete"); }
 if (observationError(owner)) { out.state = "incomplete"; out.reasons.push("runtime assessment observation reported unavailable"); }
 const workers = new Map<string, Promise<SessionEvidence>>();
 for (const root of relevant) {
  const reply = await call(core, root, ["status", "--owner-session", session.id]);
  if (!["observed", "absent", "incomplete"].includes(String(reply.state)) || !Array.isArray(reply.observations)) { out.state = "incomplete"; out.reasons.push("structured assessment store unavailable"); continue; }
  if (reply.state === "incomplete") out.state = "incomplete";
  out.reasons.push(...strings(reply.reasons));
  for (const raw of reply.observations) {
   if (!object(raw) || typeof raw.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.name)) { out.state = "incomplete"; out.reasons.push("malformed assessment observation"); continue; }
   const a = attribution(raw.attribution);
   const ra = raw.recordAttribution === null || raw.recordAttribution === undefined ? null : attribution(raw.recordAttribution);
   let state: SpecAssessmentObservation["attributionState"] = "unknown", reasons: string[] = [];
   let attributedEvidence: SessionEvidence | undefined;
   if (!a) reasons.push("preparation attribution malformed");
   else if (!a.ownerSessionId || !a.sessionId) reasons.push("owner or session attribution unavailable");
   else if (a.ownerSessionId !== session.id) { state = "conflicting"; reasons.push("receipt belongs to another owner"); }
   else if (a.workerId === null) {
    if (a.sessionId !== session.id || a.teamId !== null) { state = "conflicting"; reasons.push("parent attribution conflicts with owner"); }
    else { attributedEvidence = owner; ({ state, reasons } = taskMatches(owner, a, root)); }
   } else {
    const manifest = workerFold.manifests.get(a.workerId);
    if (!manifest) { state = "conflicting"; reasons.push("worker not recorded by this owner"); }
    else if (a.teamId !== (manifest.team?.teamId ?? null)) { state = "conflicting"; reasons.push("team attribution conflicts with recorded worker"); }
    else if (manifest.ref?.kind !== "pi-session-file") reasons.push("native worker task boundary cannot be verified by this reader");
    else if (!manifest.spec?.cwd || resolve(manifest.spec.cwd) !== resolve(root)) { state = "conflicting"; reasons.push("receipt root conflicts with recorded worker scope"); }
    else {
     const key = manifest.ref.locator;
     if (!workers.has(key)) workers.set(key, sessionEvidence(key));
     const evidence = await workers.get(key)!;
     attributedEvidence = evidence;
     ({ state, reasons } = taskMatches(evidence, a, root));
     if (manifest.ref.sessionId && manifest.ref.sessionId !== evidence.id || evidence.cwd && resolve(evidence.cwd) !== resolve(root)) { state = "conflicting"; reasons.push("recorded worker transcript identity conflicts with actual session"); }
     else if (!manifest.ref.sessionId || !evidence.cwd) { state = "unknown"; reasons.push("recorded worker session identity incomplete"); }
     if (observationError(evidence)) { out.state = "incomplete"; reasons.push("worker assessment observation reported unavailable"); }
    }
   }
   if (ra && a && attrKeys.some(k => ra[k] !== null && a[k] !== null && ra[k] !== a[k] && k !== "attemptId")) { state = "conflicting"; reasons.push("record attribution does not match preparation task"); }
   else if (raw.decisions !== null && raw.decisions !== undefined) {
    if (!ra || !attributedEvidence) { if (state !== "conflicting") state = "unknown"; reasons.push("record attribution unavailable"); }
    else {
     const recordTask = taskMatches(attributedEvidence, ra, root);
     if (recordTask.state !== "matched" && state !== "conflicting") state = recordTask.state;
     reasons.push(...recordTask.reasons.map(r => `record: ${r}`));
    }
   }
   const coverage = object(raw.coverage) && Array.isArray(raw.coverage.unresolvedIds) && raw.coverage.unresolvedIds.every(i => typeof i === "string" && i.startsWith("§")) && Array.isArray(raw.coverage.unresolvedFiles) && raw.coverage.unresolvedFiles.every(i => typeof i === "string") ? raw.coverage : undefined;
   const parsedVerification = bases(raw.verification);
   const verification = parsedVerification.items;
   if (parsedVerification.incomplete || !coverage || !Array.isArray(raw.unknowns)) { out.state = "incomplete"; reasons.push("assessment or verification inventory incomplete"); }
   out.items.push({ name: raw.name, worktree: root, ...(typeof raw.fingerprint === "string" ? { fingerprint: raw.fingerprint } : {}), ...(raw.capturedGitHead === null || typeof raw.capturedGitHead === "string" ? { capturedGitHead: raw.capturedGitHead } : {}), attribution: a ?? emptyAttribution(), recordAttribution: ra ?? null,
    applicability: ["current", "stale", "unknown"].includes(String(raw.applicability)) ? raw.applicability as SpecAssessmentObservation["applicability"] : "unknown",
    attributionState: state, assessmentState: ["outstanding", "recorded"].includes(String(raw.assessmentState)) ? raw.assessmentState as SpecAssessmentObservation["assessmentState"] : "unknown",
    unresolved: coverage ? (coverage.unresolvedIds as unknown[]).length + (coverage.unresolvedFiles as unknown[]).length : null,
    verification, reasons: [...reasons, ...strings(raw.reasons), ...(Array.isArray(raw.unknowns) ? raw.unknowns.map(u => object(u) && typeof u.code === "string" ? u.code : "assessment input unknown") : [])] });
  }
 }
 if (out.items.length && out.state !== "incomplete") out.state = "observed";
 out.reasons = [...new Set(out.reasons)];
 return out;
}
