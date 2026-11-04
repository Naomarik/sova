// Which projects and checkouts exist, for the rows and for a chat's folder. The server's
// side only: projects live in the org engines, which a chat's process doesn't open.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { folderMatcher } from "../project-folder";
import { listProjects } from "../projects/spaces";
import { agentRoot } from "../state-root";

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export interface McpProject {
  id: string;
  name: string;
  root: string;
}

export const mcpProjects = (): McpProject[] => listProjects().filter((p) => !p.archived).map(({ id, name, root }) => ({ id, name, root }));

/** The project's checkouts: its root, then its worktrees, by real path. */
export function checkoutsOf(root: string): Promise<string[]> {
  return new Promise((done) => {
    execFile("git", ["-C", root, "worktree", "list", "--porcelain"], { timeout: 5_000 }, (err, stdout) => {
      const all = err ? [] : stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
      done([...new Set([real(root), ...all.map(real)])].filter(existsSync));
    });
  });
}

/** The top of the checkout a folder is in, by its `.git`; null when it is in none. */
export function checkoutRootOf(cwd: string): string | null {
  for (let dir = real(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

export interface McpFolder {
  project: McpProject | null;
  /** The real path whose `.mcp.json` this folder reads. */
  checkout: string;
}

export function folderOf(cwd: string, projects: readonly McpProject[] = mcpProjects()): McpFolder {
  const id = folderMatcher(projects, agentRoot())(cwd);
  const project = projects.find((p) => p.id === id) ?? null;
  return { project, checkout: checkoutRootOf(cwd) ?? (project ? real(project.root) : real(cwd)) };
}
