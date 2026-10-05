import { readdirSync } from "node:fs";
import { join } from "node:path";
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

export async function titleOf(path: string, fallback: string): Promise<string> {
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

// The Overseer's text views read the helper on the main loop, so they ask for answers that need no
// parse there (a7): a line the helper formatted, and a list of bare numbers.
const ok = (a: HelperAnswer): string => {
  if (a.status !== 200) throw new Error(`usage helper: ${a.status}`);
  return a.body.toString();
};

/** A project's cost as the Overseer's org view says it ("Cost: $… at API prices, …"). */
export async function projectCostLine(projectId: string): Promise<string> {
  // The helper's line has no quote, backslash or control character: its JSON form is "<line>".
  return ok(await askUsage("project-line", { scope: await projectScope(projectId) })).slice(1, -1);
}

/** The org's total and each project's, in `projectIds` order (the Overseer's org view). */
export async function orgCostFigures(orgId: string, projectIds: string[]): Promise<{ totalUsd: number; projects: { projectId: string; totalUsd: number }[] }> {
  const scopes: ProjectScope[] = [];
  for (const pid of projectIds) scopes.push(await projectScope(pid));
  // A JSON array of numbers: "[12.5,3,9.5]".
  const n = ok(await askUsage("org-figures", { orgId, scopes })).slice(1, -1).split(",").map(Number);
  if (n.length !== projectIds.length + 1 || n.some((x) => !Number.isFinite(x))) throw new Error("usage helper: malformed org figures");
  return { totalUsd: n[0]!, projects: projectIds.map((projectId, i) => ({ projectId, totalUsd: n[i + 1]! })) };
}
