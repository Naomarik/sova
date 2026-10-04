import { buildSessionPath } from "../build-loadout";
import { hostOf, isOrgHostOpen } from "../org-engine";
import { engineOf, listProjects, runtimeSid } from "./spaces";
import type { PlaybookReviewWords } from "../../shared/playbook-review";

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
