import { basename } from "node:path";
import type { InstanceSummary, ServiceView, VerbResult } from "../../shared/project-contract";
import type { ProjectRuntimeView, RuntimeOrphan, RuntimePlaybook, RuntimeProof, RuntimeService, RuntimeStanding } from "../../shared/project-runtime";
import { buildSessionPath, readBuild, probeBuild, withWorktreePath } from "../build-loadout";
import type { Envelope } from "../org-envelope";
import { hostOf, isOrgHostOpen, onOrgChange, onOrgHostOpened, type Effect, type OrgHostApi } from "../org-engine";
import { OrgError } from "../org-error";
import { approveAtRef, branchFacts, observeRuntime, type BranchFacts, type ProofFact, type RuntimeFacts } from "../project-services/observe";
import { projectEngine } from "../project-services/routes";
import { startOnboardSession, type StartedCoding } from "../project-overseer";
import { projectRootOf } from "../project-root";
import { readWorktree } from "../project-worktrees";
import { onboardStart } from "./onboard";
import { runtimeFeed, type FeedRow } from "./runtime-feed";
import { engineOf, engineOrThrow, listProjects, operatorEnvelopeOf, projectArchived, readProject, runtimeSid, type OperatorBy } from "./spaces";

/**
 * The host side of the software registry (§app/project-runtime): `runtime/<p>`, a host-local project-layer
 * statechart. Here: starting it for every project as its engine opens, the facts it is told
 * (`runtime/observed`, from the engine's read of main's HEAD, sent only when they changed), its effects
 * (`approve`, `conform`), the page's read (the registry joined with the engine's live status and the feed),
 * the operator's approval and the Project verbs playbook's start (`verbs/onboard` on the project).
 */

const SYSTEM = { by: "system" } as unknown as Envelope;
const OBSERVE_EVERY_MS = 5 * 60_000;
const SETTLE_MS = 500;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ms = (iso: string | number | undefined | null): number | null => (typeof iso === "number" ? iso : iso ? Date.parse(iso) || null : null);
const iso = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : typeof v === "string" ? v : "");

// ---- the facts ------------------------------------------------------------------------------------------

/** A proof as the statechart keeps it: its time in ms (the standing rule compares it with a re-approval's). */
function proofFact(p: ProofFact | null): Record<string, unknown> | null {
  if (!p) return null;
  return { hash: p.hash, suite: p.suite, pass: p.pass, confined: p.confined, at: ms(p.at), ...(p.failed ? { failed: p.failed } : {}), ...(p.memory ? { memory: p.memory } : {}) };
}

/** `runtime/observed`'s payload from the engine's read: lists, never path-keyed maps (keys are case-converted on the way in). */
export function observedPayload(f: RuntimeFacts): Record<string, unknown> {
  return {
    commit: f.commit,
    def: f.def,
    software: f.software.map((s) => ({ name: s.name, kind: s.kind, scope: s.scope, ports: s.ports, requires: s.requires, ...(s.isolation ? { isolation: s.isolation } : {}) })),
    data: f.data.map((r) => ({ name: r.name, kind: r.kind, sensitive: r.sensitive })),
    sources: { paths: f.sources.paths, files: f.sources.paths.map((path) => ({ path, sha: f.sources.files[path] ?? null })), fingerprint: f.sources.fingerprint },
    approved: f.approved ? { hash: f.approved.hash, at: ms(f.approved.at) } : null,
    proof: proofFact(f.proof),
    confinedProof: proofFact(f.confinedProof),
    suite: f.suite,
  };
}

export function branchPayload(b: BranchFacts): Record<string, unknown> {
  return { ref: b.ref, commit: b.commit, def: b.def, approved: b.approved, proof: proofFact(b.proof) };
}

/** The payload last sent per project (only a change is sent). */
const sent = new Map<string, string>();

/** The registry's session of the project, when its engine is open and the session exists. */
function runtimeOf(projectId: string): { host: OrgHostApi; sid: string } | null {
  const engine = engineOf(projectId);
  if (!engine || !isOrgHostOpen(engine)) return null;
  const host = hostOf(engine);
  const sid = runtimeSid(projectId);
  return host.configuration(sid) ? { host, sid } : null;
}

/** The playbook's build, probed by git so its branch state reaches it (as the project page's read does). */
async function probePlaybookBuild(projectId: string, root: string, sessionId: string): Promise<string | null> {
  const row = readBuild(projectId, sessionId);
  if (!row) return null;
  const wt = await withWorktreePath(row, root);
  if (!wt) return null;
  const w = await readWorktree(wt.worktree, root);
  const engine = engineOf(projectId);
  if (engine) await probeBuild(projectId, `build/${projectId}/${sessionId}`, row, w).catch(() => {});
  return wt.worktree.branch;
}

const inflight = new Map<string, Promise<void>>();

/** Read main's facts (and the live playbook branch's) and tell the registry when they changed. */
export function observe(projectId: string): Promise<void> {
  const prev = inflight.get(projectId);
  if (prev) return prev;
  const p = (async () => {
    const at = runtimeOf(projectId);
    if (!at) return;
    const root = readProject(projectId).root;
    if (!root) return;
    const payload = observedPayload(await observeRuntime(root));
    const d = obj(at.host.data(at.sid));
    const pb = obj(d.playbook);
    if ((d.playbookState === "running" || d.playbookState === "proposed") && str(pb.sessionId)) {
      const branch = (await probePlaybookBuild(projectId, root, str(pb.sessionId))) || str(pb.branch);
      if (branch) payload.branchFacts = branchPayload(await branchFacts(root, branch));
    }
    const key = JSON.stringify(payload);
    if (sent.get(projectId) === key) return;
    await at.host.act(at.sid, "runtime/observed", payload, SYSTEM);
    sent.set(projectId, key);
  })()
    .catch((err) => console.warn(`[runtime] ${projectId}: not observed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => inflight.delete(projectId));
  inflight.set(projectId, p);
  return p;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Observe soon (several changes in a row read once). */
function observeSoon(projectId: string): void {
  if (timers.has(projectId)) return;
  const t = setTimeout(() => {
    timers.delete(projectId);
    void observe(projectId);
  }, SETTLE_MS);
  t.unref?.();
  timers.set(projectId, t);
}

// ---- the engine's hooks ---------------------------------------------------------------------------------

/** Start the registry of every project the engine holds that has none yet (projects born before it), then read. */
async function startRegistries(host: OrgHostApi): Promise<void> {
  for (const s of host.sessions("project")) {
    const projectId = str(s.data.id);
    if (!projectId) continue;
    const sid = runtimeSid(projectId);
    try {
      if (!host.configuration(sid)) await host.start(sid, "runtime", { projectId, root: str(s.data.root) }, { by: "system" });
      sent.delete(projectId);
      observeSoon(projectId);
    } catch (err) {
      console.warn(`[runtime] ${projectId}: no registry: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function conformResult(r: VerbResult, hash: string): Record<string, unknown> {
  const c = r.conform;
  if (!c) return { hash, pass: false, confined: false, at: Date.now(), failed: { check: r.error?.step ?? "run", detail: r.error?.message ?? "Conformance did not run." } };
  const bad = c.checks.find((x) => !x.ok);
  return {
    hash: c.defHash || hash,
    suite: c.suiteVersion,
    pass: c.pass,
    confined: !!c.confined,
    at: Date.now(),
    ...(!c.pass ? { failed: { check: bad?.id ?? r.error?.step ?? "run", detail: bad?.detail ?? r.error?.message ?? "" } } : {}),
    ...(c.memory ? { memory: c.memory } : {}),
  };
}

function registerRuntimeEffects(host: OrgHostApi): void {
  // runtime: the operator's approval of a hash, at main's HEAD or the playbook's branch (a stale hash is refused).
  host.effects.register("approve", async (e: Effect) => {
    const projectId = str(host.data(e.sessionId)?.projectId);
    const root = readProject(projectId).root;
    const out = await approveAtRef(root, str(e.hash), str(e.ref) || "HEAD");
    observeSoon(projectId);
    return { hash: out.hash, commit: out.commit };
  });
  // runtime: entering conforming: the full, unconfined conformance on main (the approval is the authority).
  host.effects.register("conform", async (e: Effect) => {
    const projectId = str(host.data(e.sessionId)?.projectId);
    const root = readProject(projectId).root;
    const r = await projectEngine().run("conform", { project: root }, { kind: "operator" });
    observeSoon(projectId);
    return conformResult(r, str(e.hash));
  });
}

onOrgHostOpened((host) => {
  registerRuntimeEffects(host);
  queueMicrotask(() => void startRegistries(host));
});

// A registry's own move or its playbook build's: read again (an unchanged read sends nothing).
onOrgChange((engine, change) => {
  if (!isOrgHostOpen(engine)) return;
  const host = hostOf(engine);
  const projects = new Set<string>();
  for (const sid of change.sessions) {
    if (sid.startsWith("project/")) {
      const id = str(host.data(sid)?.id);
      if (id && !host.configuration(runtimeSid(id))) void startRegistries(host);
    } else if (sid.startsWith("runtime/") || sid.startsWith("build/")) {
      const pid = str(host.data(sid)?.projectId);
      if (!pid) continue;
      if (sid.startsWith("build/") && obj(host.data(runtimeSid(pid))?.playbook).sid !== sid) continue;
      projects.add(pid);
    }
  }
  for (const pid of projects) observeSoon(pid);
});

let tick: ReturnType<typeof setInterval> | null = null;
/** Every 5 minutes, every project's facts again (main's HEAD may have moved). */
export function startRuntimeTick(): void {
  if (tick) return;
  tick = setInterval(() => {
    for (const p of listProjects()) void observe(p.id);
  }, OBSERVE_EVERY_MS);
  tick.unref?.();
}

// ---- the page's read ------------------------------------------------------------------------------------

function proofView(v: unknown): RuntimeProof | null {
  const p = obj(v);
  if (!p.hash) return null;
  return {
    hash: str(p.hash),
    suite: Number(p.suite) || 0,
    pass: p.pass === true,
    confined: p.confined === true,
    at: iso(p.at),
    ...(p.failed ? { failed: { check: str(obj(p.failed).check), detail: str(obj(p.failed).detail) } } : {}),
    ...(p.memory ? { memory: p.memory as RuntimeProof["memory"] } : {}),
  };
}

/** The proof that counts for main's hash (the standing rule's: unconfined, current suite, newest). */
function countingProof(d: Record<string, unknown>): RuntimeProof | null {
  const hash = str(obj(d.def).hash);
  const cleared = typeof d.clearedAt === "number" ? d.clearedAt : null;
  const ok = (p: Record<string, unknown>) => p.hash === hash && p.suite === d.suite && p.confined !== true && (cleared === null || (Number(p.at) || 0) > cleared);
  const c = [obj(d.proof), obj(d.conformResult)].filter(ok).sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  return proofView(c.at(-1));
}

const labelOf = (i: InstanceSummary): string => i.branch || basename(i.checkout);

/** Each declared service with its live state per instance, and what still runs that left the definition. */
function joinLive(software: Record<string, unknown>[], instances: InstanceSummary[], proof: RuntimeProof | null): { services: RuntimeService[]; orphans: RuntimeOrphan[] } {
  const declared = new Set(software.map((s) => str(s.name)));
  const orphans: RuntimeOrphan[] = [];
  const live = new Map<string, RuntimeService["live"]>();
  const sharedSeen = new Set<string>();
  for (const inst of instances)
    for (const sv of inst.services as ServiceView[]) {
      if (!declared.has(sv.name) || /no longer in (the|any) definition/.test(sv.detail ?? "")) {
        orphans.push({ name: sv.name, instance: inst.instance, label: labelOf(inst), state: sv.state });
        continue;
      }
      if (sv.scope === "shared") {
        if (sharedSeen.has(sv.name)) continue;
        sharedSeen.add(sv.name);
      }
      const rows = live.get(sv.name) ?? [];
      rows.push({ instance: sv.scope === "shared" ? "shared" : inst.instance, label: sv.scope === "shared" ? "shared" : labelOf(inst), state: sv.state, ...(typeof sv.rssBytes === "number" ? { rssBytes: sv.rssBytes } : {}) });
      live.set(sv.name, rows);
    }
  const memoryOf = (name: string): RuntimeService["memory"] | undefined => {
    const rows = (proof?.memory?.instances ?? []).flatMap((i) => i.services.filter((s) => s.name === name));
    if (!rows.length) return undefined;
    const max = (k: "peakBytes" | "steadyBytes") => rows.reduce<number | null>((m, r) => (r[k] === null ? m : Math.max(m ?? 0, r[k] as number)), null);
    return { peakBytes: max("peakBytes"), steadyBytes: max("steadyBytes") };
  };
  const services = software.map((s): RuntimeService => {
    const name = str(s.name);
    const mem = memoryOf(name);
    return {
      name,
      kind: (str(s.kind) || "process") as RuntimeService["kind"],
      scope: (str(s.scope) || "checkout") as RuntimeService["scope"],
      ports: Array.isArray(s.ports) ? (s.ports as { name: string; port: number }[]) : [],
      requires: Array.isArray(s.requires) ? (s.requires as string[]) : [],
      ...(s.isolation ? { isolation: s.isolation as RuntimeService["isolation"] } : {}),
      live: live.get(name) ?? [],
      ...(mem ? { memory: mem } : {}),
    };
  });
  return { services, orphans };
}

export const ALREADY_RUNNING = (title: string) => `The Project verbs playbook is already running: "${title}".`;

function playbookView(host: OrgHostApi, d: Record<string, unknown>): RuntimePlaybook | null {
  const pb = obj(d.playbook);
  if (!pb.sessionId) return null;
  const bf = obj(pb.branchFacts);
  const bdef = obj(bf.def);
  const path = buildSessionPath(str(pb.sessionId));
  return {
    sessionId: str(pb.sessionId),
    ...(path ? { path } : {}),
    ...(str(pb.title) ? { title: str(pb.title) } : str(host.data(str(pb.sid))?.title) ? { title: str(host.data(str(pb.sid))?.title) } : {}),
    ...(str(pb.why) ? { why: str(pb.why) } : {}),
    startedBy: pb.startedBy === "overseer" ? "overseer" : "operator",
    startedAt: iso(pb.at),
    ...(str(pb.result) ? { result: str(pb.result) } : {}),
    ...(str(pb.branch) ? { branch: str(pb.branch) } : {}),
    ...(bdef.state === "present" ? { branchHash: str(bdef.hash), branchApproved: bf.approved === true, branchProof: proofView(bf.proof) } : {}),
  };
}

/** The live title of a running playbook (the "already running" refusal), or null. */
function liveRun(host: OrgHostApi, d: Record<string, unknown>): string | null {
  if (d.playbookState !== "running" && d.playbookState !== "proposed") return null;
  const pb = obj(d.playbook);
  return str(pb.title) || str(host.data(str(pb.sid))?.title) || str(pb.sessionId);
}

/** The registry as the page reads it (after a fresh read of main). */
export async function readRuntime(projectId: string, opts: { observe?: boolean } = {}): Promise<ProjectRuntimeView> {
  engineOrThrow(projectId);
  if (opts.observe !== false) await observe(projectId);
  const at = runtimeOf(projectId);
  if (!at) throw new OrgError("This project's software registry is not open on this host.", 409);
  const d = obj(at.host.data(at.sid));
  const cfg = at.host.configuration(at.sid) ?? [];
  const root = readProject(projectId).root;
  let instances: InstanceSummary[] = [];
  try {
    instances = (await projectEngine().run("status", { project: root }, { kind: "operator" })).instances ?? [];
  } catch {}
  const proof = countingProof(d);
  const { services, orphans } = joinLive(Array.isArray(d.software) ? (d.software as Record<string, unknown>[]) : [], instances, proof);
  const def = obj(d.def);
  const reg = obj(d.registered);
  const env = operatorEnvelopeOf(projectId);
  const mainHash = def.state === "present" ? str(def.hash) : "";
  const branchHash = str(obj(obj(obj(d.playbook).branchFacts).def).hash);
  const approve = [mainHash, branchHash].find((h) => h && at.host.trial(at.sid, "runtime/approve", { hash: h }, env).taken) ?? null;
  const running = liveRun(at.host, d);
  const onboardWhy = running ? ALREADY_RUNNING(running) : projectArchived(projectId) ? `${readProject(projectId).name} is archived. Unarchive it first.` : undefined;
  const rows = at.host.log.rows({ session: at.sid }) as unknown as FeedRow[];
  return {
    projectId,
    standing: ((["unregistered", "awaiting-approval", "conforming", "registered", "stale", "failed"] as const).find((s) => cfg.includes(s)) ?? "unregistered") as RuntimeStanding,
    playbookState: d.playbookState === "running" || d.playbookState === "proposed" ? d.playbookState : "idle",
    def: def.state ? { state: def.state as "absent" | "invalid" | "present", ...(def.hash ? { hash: str(def.hash) } : {}), ...(def.error ? { error: str(def.error) } : {}) } : null,
    commit: str(d.commit) || null,
    suite: typeof d.suite === "number" ? d.suite : null,
    services,
    orphans,
    data: (Array.isArray(d.data) ? (d.data as Record<string, unknown>[]) : []).map((r) => ({ name: str(r.name), kind: r.kind === "hook" ? ("hook" as const) : ("dir" as const), sensitive: r.sensitive === true })),
    sources: Array.isArray(obj(d.sources).paths) ? (obj(d.sources).paths as string[]) : [],
    drift: cfg.includes("stale") && Array.isArray(obj(d.drift).paths) ? (obj(d.drift).paths as string[]) : null,
    approved: obj(d.approved).hash ? { hash: str(obj(d.approved).hash), at: iso(obj(d.approved).at) } : null,
    proof,
    confinedProof: proofView(d.confinedProof),
    registered: reg.hash ? { hash: str(reg.hash), suite: Number(reg.suite) || 0, commit: str(reg.commit) || null, at: iso(reg.at) } : null,
    playbook: playbookView(at.host, d),
    can: {
      approve,
      ...(approve && approve !== mainHash ? { approveBranch: str(obj(d.playbook).branch) } : {}),
      onboard: !onboardWhy,
      ...(onboardWhy ? { onboardWhy } : {}),
    },
    feed: runtimeFeed(rows),
  };
}

// ---- the operator's acts --------------------------------------------------------------------------------

/** A refusal of a registry act, with its own status (403 for anyone but the operator). */
export class RuntimeRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
  }
}

/** Approve `hash` (`runtime/approve`): the operator's only; the effect approves it on this host. */
export async function approveRuntime(projectId: string, hash: string, by: OperatorBy = { kind: "operator" }): Promise<ProjectRuntimeView> {
  const at = runtimeOf(projectId);
  if (!at) throw new OrgError("This project's software registry is not open on this host.", 409);
  const out = await at.host.act(at.sid, "runtime/approve", { hash }, operatorEnvelopeOf(projectId, by), { settle: true });
  if (!out.taken) {
    const r = out.refusal ?? { sentence: "That can't be done now." };
    throw new RuntimeRefusal(r.sentence, r.status === 403 ? 403 : r.status === 400 ? 400 : 409);
  }
  const refused = str(at.host.data(at.sid)?.approveRefused);
  if (refused) throw new RuntimeRefusal(refused, 409);
  return readRuntime(projectId);
}

/** What starting the playbook needs stamped on `verbs/onboard`: the host's refusal (its own, else a live run) and the standing. */
export async function onboardStamp(projectId: string, input: { why?: string; model?: string; thinking?: string }) {
  const start = await onboardStart(projectId, input);
  const at = runtimeOf(projectId);
  const d = at ? obj(at.host.data(at.sid)) : {};
  const running = at ? liveRun(at.host, d) : null;
  const standing = at ? ((["unregistered", "awaiting-approval", "conforming", "registered", "stale", "failed"] as const).find((s) => (at.host.configuration(at.sid) ?? []).includes(s)) ?? null) : null;
  const invalid = start.invalid || (running ? ALREADY_RUNNING(running) : "");
  return { start, extra: { ...(input.why?.trim() ? { why: input.why.trim() } : {}), ...(invalid ? { invalid, invalidStatus: 409 } : {}), ...(standing ? { runtimeStanding: standing } : {}) } };
}

export interface OnboardInput {
  why?: string;
  model?: string;
  thinking?: string;
}

/**
 * Run the Project verbs playbook on the project (`verbs/onboard`, §app.project-runtime/onboard): a coding session
 * of kind onboard in its own worktree, whose first prompt is the playbook's turn. `envelope`: the overseer's act
 * (its level and limits); else the operator's.
 */
export async function startOnboard(projectId: string, input: OnboardInput, envelope?: Envelope): Promise<StartedCoding> {
  const { start, extra } = await onboardStamp(projectId, input);
  return startOnboardSession(projectId, { prompt: start.prompt, title: start.title, model: start.model, thinking: start.thinking, envelope: envelope ?? operatorEnvelopeOf(projectId), extra });
}

/** The registered project whose root holds `path` (the global Overseer names a project by a path in it), or a 404. */
export async function projectByPath(path: string): Promise<string> {
  if (!path) throw new OrgError("Name the project (project: an absolute path inside it).", 400);
  const root = (await projectRootOf(path)) ?? path;
  const hit = listProjects().find((p) => p.root === root);
  if (!hit) throw new OrgError(`${root} is not a registered project: the playbook runs only on a project.`, 404);
  return hit.id;
}

const STANDING_WORDS: Record<RuntimeStanding, string> = {
  unregistered: "Unregistered: main declares no software yet (.sova/project.json is missing).",
  "awaiting-approval": "Awaiting approval: main's definition runs here once the operator approves it.",
  conforming: "Checking: conformance is running on main.",
  registered: "Registered and current.",
  stale: "Out of date: the stack changed since the software was registered.",
  failed: "Failed.",
};

/** sova_project's Software block: the standing in words, each service, approval, proof, drift and the playbook's run. */
export function softwareLines(v: ProjectRuntimeView): string[] {
  const h = (x: string) => x.replace(/^sha256:/, "").slice(0, 12);
  const out = [`Standing: ${STANDING_WORDS[v.standing]}`];
  if (v.standing === "failed")
    out.push(v.def?.state === "invalid" ? `The definition on main is invalid: ${v.def.error ?? ""}` : `Conformance failed at ${v.proof?.failed?.check ?? "run"}: ${v.proof?.failed?.detail ?? ""}`);
  if (v.drift?.length) out.push(`Changed since registration: ${v.drift.join(", ")}`);
  for (const s of v.services) out.push(`- ${s.name} · ${s.kind} · ${s.scope}${s.isolation ? ` · ${s.isolation.method}` : ""}${s.live.length ? ` (running: ${s.live.map((l) => `${l.label} ${l.state}`).join(", ")})` : ""}`);
  for (const o of v.orphans) out.push(`- ${o.name}: still running in ${o.label} but no longer declared`);
  if (v.approved) out.push(`Approved: ${h(v.approved.hash)} on this host.`);
  if (v.proof) out.push(`Proven: ${v.proof.pass ? "passed" : "failed"} at ${h(v.proof.hash)} (suite v${v.proof.suite}), ${v.proof.at}.`);
  if (v.playbook)
    out.push(
      `Project verbs playbook: ${v.playbookState === "idle" ? `last run ${v.playbook.result ?? "ended"}` : v.playbookState === "proposed" ? `proposes a definition on ${v.playbook.branch ?? "its branch"} (the operator approves and merges)` : "running"} (session ${v.playbook.sessionId}, started by ${v.playbook.startedBy}).`,
    );
  if (["unregistered", "stale", "failed"].includes(v.standing) && v.playbookState === "idle") out.push("At L3 you may start the playbook once: sova_project_verbs onboard {why}. Never approve or merge.");
  return out;
}

/** sova_project_verbs onboard's answer, as the model reads it. */
export function onboardAnswer(made: StartedCoding): { text: string; details: Record<string, unknown> } {
  if (made.held) return { text: `Held: the Project verbs playbook waits until ${new Date(made.held.until).toISOString()} so the operator can cancel it; it goes ahead then unless cancelled.`, details: { held: made.held.id } };
  const where = made.worktree ? ` on the branch ${made.worktree.branch}` : "";
  return {
    text: `Started the Project verbs playbook (coding session ${made.sessionId})${where}. It proposes a definition on its branch; the operator approves and merges it.${made.notPrompted ? ` ${made.notPrompted}` : ""}`,
    details: { onboard: { sessionId: made.sessionId, ...(made.worktree ? { branch: made.worktree.branch } : {}) } },
  };
}

/** Tests: forget what was sent. */
export function resetRuntimeForTest(): void {
  sent.clear();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
