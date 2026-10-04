import { buildSessionPath } from "../build-loadout";
import { hostOf, isOrgHostOpen } from "../org-engine";
import { engineOf, listProjects, runtimeSid } from "./spaces";
import type { PlaybookReviewWords } from "../../shared/playbook-review";
import { CONTRACT_FILE, DefinitionError, parseDefinition, type ProjectDef } from "../../shared/project-contract";
import type { RuntimeMemory, RuntimeProof, RuntimeRunLive, RuntimeRunReview } from "../../shared/project-runtime";
import { realGit } from "../project-services/engine";
import { softwareOf } from "../project-services/observe";
import { defHashOf } from "../project-services/trust";
import { getSessionSummary } from "../sessions-index";

/**
 * A proposed verb playbook run waits on the operator (§app.project-runtime/review): the facts its
 * Needs-you item (`playbook-review`), its push and the project page's banner say, read from the
 * registry's statechart (`runtime/<p>` while its playbook region is proposed) and its build's.
 */

/** One proposed run, as Needs you and the banner read it. */
export interface PlaybookReviewFact extends PlaybookReviewWords {
  projectId: string;
  sessionId: string;
  /** The run's session file on this host; "" when it is not here. */
  path: string;
  /** ms epoch: its last turn's end (when it became proposed). */
  since: number;
  /** What its proposal approves (§app.project-runtime/verb-playbooks). */
  approves: "definition" | "deploy";
}

export const DEFAULT_PLAYBOOK_LABEL = "Project verbs";

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The proposed run of one project, or null (no registry open here, or nothing proposed). */
export function playbookReviewOf(projectId: string): PlaybookReviewFact | null {
  const engine = engineOf(projectId);
  if (!engine || !isOrgHostOpen(engine)) return null;
  const host = hostOf(engine);
  const d = obj(host.data(runtimeSid(projectId)));
  if (d.playbookState !== "proposed") return null;
  const pb = obj(d.playbook);
  const sessionId = str(pb.sessionId);
  if (!sessionId) return null;
  const build = obj(host.data(str(pb.sid)));
  const bf = obj(pb.branchFacts);
  const def = obj(bf.def);
  const hash = def.state === "present" ? str(def.hash) : "";
  return {
    projectId,
    sessionId,
    path: buildSessionPath(sessionId) ?? "",
    label: str(pb.label) || DEFAULT_PLAYBOOK_LABEL,
    branch: str(pb.branch) || str(build.branch),
    target: str(build.target) || "main",
    ...(hash ? { hash } : {}),
    approved: !!hash && bf.approved === true,
    approves: pb.approves === "deploy" ? "deploy" : "definition",
    since: typeof build.lastTurnAt === "number" ? build.lastTurnAt : typeof pb.at === "number" ? pb.at : 0,
  };
}

/** Every proposed run on this host, by its session file (runs whose session is elsewhere are left out). */
export function playbookReviews(): Map<string, PlaybookReviewFact> {
  const out = new Map<string, PlaybookReviewFact>();
  for (const p of listProjects()) {
    const r = playbookReviewOf(p.id);
    if (r?.path) out.set(r.path, r);
  }
  return out;
}

// ---- the review card's facts (§app.project-runtime/run-report) and the run strip's (/run-progress) ----

/** A service's memory in a proof: the larger of its two scratch instances', or undefined when nothing was read. */
export function memoryIn(proof: RuntimeProof | null, name: string): RuntimeMemory | undefined {
  const rows = (proof?.memory?.instances ?? []).flatMap((i) => i.services.filter((s) => s.name === name));
  if (!rows.length) return undefined;
  const max = (k: "peakBytes" | "steadyBytes") => rows.reduce<number | null>((m, r) => (r[k] === null ? m : Math.max(m ?? 0, r[k] as number)), null);
  return { peakBytes: max("peakBytes"), steadyBytes: max("steadyBytes") };
}

/** The review of a definition (as parsed at the branch's tip) and its proof. Pure. */
export function reviewOf(def: ProjectDef | null, fact: RuntimeRunReview["def"], proof: RuntimeProof | null): RuntimeRunReview {
  if (!def) return { def: fact, services: [], data: [], share: null, open: null, proof };
  return {
    def: fact,
    services: softwareOf(def).map((s) => {
      const memory = memoryIn(proof, s.name);
      return { name: s.name, kind: s.kind, scope: s.scope, ports: s.ports, start: s.start, ...(s.isolation ? { isolation: { method: s.isolation.method, why: s.isolation.why } } : {}), ...(memory ? { memory } : {}) };
    }),
    data: (def.data ?? []).map((d) => ({ name: d.name, kind: d.kind, sensitive: d.sensitive === true })),
    share: def.share ? { endpoints: [...def.share.endpoints], allow: def.share.allow !== false } : null,
    open: def.open ? { endpoint: def.open.endpoint, path: def.open.path } : null,
    proof,
  };
}

/** What a proposed run's branch proposes, read at its tip from git (never the worktree's files). */
export async function branchReview(root: string, branch: string, proof: RuntimeProof | null, git: typeof realGit = realGit): Promise<RuntimeRunReview> {
  const shown = await git(["show", `${branch}:${CONTRACT_FILE}`], root);
  if (shown.code !== 0) return reviewOf(null, { state: "absent" }, proof);
  try {
    const def = parseDefinition(shown.stdout);
    return reviewOf(def, { state: "present", hash: defHashOf(def) }, proof);
  } catch (err) {
    return reviewOf(null, { state: "invalid", error: err instanceof DefinitionError ? err.message : String(err) }, proof);
  }
}

/** The run's session as the session list reads it now: working or idle, its "now" line, its open questions. */
export async function runLive(path: string | undefined): Promise<RuntimeRunLive | undefined> {
  if (!path) return undefined;
  const s = await getSessionSummary(path).catch(() => null);
  if (!s) return undefined;
  const working = s.busy || s.activity?.state === "working" || (s.workers?.working ?? 0) > 0;
  const now = s.outlineNow?.trim();
  const questions = s.align?.openQuestions ?? 0;
  return { working, ...(now ? { now } : {}), ...(!working && questions > 0 ? { questions } : {}) };
}
