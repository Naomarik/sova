// The rows the routes and the catalogue answer with. Server-side: reads the projects.
import type { McpProjectServers, McpServerRow, McpServers } from "../../shared/mcp";
import { isChecking } from "./check";
import { readComputerList, readProjectList, type McpEntry } from "./config";
import { type RowRef } from "./ids";
import { checkoutsOf, mcpProjects, type McpProject } from "./places";
import { currentEntry } from "./resolve";
import { rowOfEntry } from "./rows";
import type { McpOwner } from "./trust";

const rowFor = (owner: McpOwner, e: McpEntry, replacedIn?: McpServerRow["replacedIn"]) => rowOfEntry(owner, e, { checking: isChecking(owner, e.name), ...(replacedIn ? { replacedIn } : {}) });

/** Where each computer server's name is taken by a project's. */
async function replacements(projects: readonly McpProject[]): Promise<Map<string, NonNullable<McpServerRow["replacedIn"]>>> {
  const out = new Map<string, NonNullable<McpServerRow["replacedIn"]>>();
  for (const p of projects) {
    const names = new Set<string>();
    for (const checkout of await checkoutsOf(p.root)) for (const e of readProjectList(checkout).entries) names.add(e.name);
    for (const name of names) out.set(name, [...(out.get(name) ?? []), { project: p.name, projectId: p.id, name }]);
  }
  return out;
}

export async function computerServers(): Promise<McpServers> {
  const replaced = await replacements(mcpProjects());
  return { servers: readComputerList().entries.map((e) => rowFor({ kind: "computer" }, e, replaced.get(e.name))) };
}

export async function projectServers(project: Pick<McpProject, "id" | "root">): Promise<McpProjectServers> {
  const checkouts = await checkoutsOf(project.root);
  return {
    checkouts: checkouts.map((folder) => {
      const list = readProjectList(folder);
      const owner: McpOwner = { kind: "project", projectId: project.id, checkout: folder };
      return { folder, file: list.file, ...(list.file === "broken" ? { error: list.error } : {}), servers: list.entries.map((e) => rowFor(owner, e)) };
    }),
  };
}

/** Whether a ref points at a project and checkout that exist here: an id is the caller's to make up. */
export async function knownRef(ref: RowRef): Promise<boolean> {
  if (ref.owner.kind === "computer") return true;
  const { projectId, checkout } = ref.owner;
  const p = mcpProjects().find((x) => x.id === projectId);
  return !!p && (await checkoutsOf(p.root)).includes(checkout);
}

export async function rowOf(ref: RowRef): Promise<McpServerRow | null> {
  const e = currentEntry(ref.owner, ref.name);
  if (!e || !(await knownRef(ref))) return null;
  if (ref.owner.kind !== "computer") return rowFor(ref.owner, e);
  return (await computerServers()).servers.find((r) => r.name === ref.name) ?? null;
}
