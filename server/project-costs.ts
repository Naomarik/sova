import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { OrgCosts, ProjectCost } from "../shared/costs";
import { contributedCostSessions } from "./projects/contributions";
import { engineOrThrow, projectDir } from "./projects/spaces";
import { ledgerPaths } from "./project-costs-ledger";
import { readBuilds } from "./build-loadout";
import { projectOf, readPoMarker, sessionIdOfFile } from "./project-overseer-store";
import { getSessionSummary } from "./sessions-index";
import { askUsage, type HelperAnswer } from "./usage-helper/client";
import type { CostScopeSource, ProjectScope } from "./usage-helper/project";

/**
 * A project's running cost at API prices (§app/project-costs), from the usage ledger
 * (§app.insights/usage-ledger). This side only names the project's sessions (§app.project-costs/scope:
 * contributed sessions with their wrap-up turns, its overseer's conversations, its coding sessions)
 * and where its costs.json is; the usage helper counts their records and their workers' at any
 * depth, the project's reconciler calls, other hosts' rows "as last counted", prices them and keeps
 * this host's rows in costs.json. The route relays the helper's bytes.
 *
 * Main listener only: never the share listener, the owner page or the project overseer's tools.
 */

async function titleOf(path: string, fallback: string): Promise<string> {
  const s = await getSessionSummary(path).catch(() => null);
  return s?.title?.trim() || fallback;
}

/** The project's sessions on this host and its costs.json. Throws a 404 OrgError for an unknown project. */
export async function projectScope(projectId: string): Promise<ProjectScope> {
  projectOf(projectId);
  const dir = projectDir(projectId);
  const sources: CostScopeSource[] = [];
  const seen = new Set<string>();
  const add = (s: CostScopeSource) => {
    if (seen.has(s.key) || (s.path && seen.has(s.path))) return;
    seen.add(s.key);
    if (s.path) seen.add(s.path);
    sources.push(s);
  };

  // Sessions another layer counts as the project's (gathering sessions), each with its wrap-up apart.
  for (const c of contributedCostSessions(engineOrThrow(projectId), projectId)) {
    add({ key: c.key, sessionId: c.sessionId, title: c.title, kind: c.kind, by: c.by, path: c.path, ...(c.wrapupEntry ? { wrapupEntry: c.wrapupEntry } : {}) });
  }

  // Its overseer's conversations: every session in its engine's sessions dir carrying this project's marker.
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, "sessions")).filter((n) => n.endsWith(".jsonl"));
  } catch {
    names = [];
  }
  for (const name of names) {
    const path = join(dir, "sessions", name);
    if (seen.has(path)) continue;
    const m = readPoMarker(path);
    if (!m || m.projectId !== projectId) continue;
    const id = sessionIdOfFile(path);
    add({ key: id, sessionId: id, title: await titleOf(path, "Overseer conversation"), kind: "overseer", by: "overseer", path });
  }

  // Coding sessions of both kinds.
  for (const r of readBuilds(projectId)) {
    const coding = r.kind === "coding";
    add({
      key: r.sessionId,
      sessionId: r.sessionId,
      title: r.path ? await titleOf(r.path, r.title ?? "Coding session") : (r.title ?? "Coding session"),
      kind: coding ? "coding-overseer" : "coding-operator",
      by: coding ? "overseer" : "operator",
      path: r.path ?? null,
    });
  }
  return { projectId, costsPath: ledgerPaths(projectId, dir).costs, sources };
}

/** GET /api/projects/:pid/costs: the helper's ProjectCost, as bytes. */
export async function projectCostAnswer(projectId: string): Promise<HelperAnswer> {
  return askUsage("project", { scope: await projectScope(projectId) });
}

/** GET /api/orgs/:id/costs: every placed project's total, as bytes. */
export async function orgCostsAnswer(orgId: string, projectIds: string[]): Promise<HelperAnswer> {
  const scopes: ProjectScope[] = [];
  for (const pid of projectIds) scopes.push(await projectScope(pid));
  return askUsage("org", { orgId, scopes });
}

const parsed = <T>(a: HelperAnswer): T => {
  if (a.status !== 200) throw new Error(`usage helper: ${a.status} ${a.body.toString()}`);
  return JSON.parse(a.body.toString()) as T;
};

/** A project's cost as an object (the overseer's org view; a figure in a tool's text). */
export async function projectCost(projectId: string): Promise<ProjectCost> {
  return parsed<ProjectCost>(await projectCostAnswer(projectId));
}

/** The org roll-up as an object (the overseer's org view). */
export async function orgCostsOf(orgId: string, projectIds: string[]): Promise<OrgCosts> {
  return parsed<OrgCosts>(await orgCostsAnswer(orgId, projectIds));
}
