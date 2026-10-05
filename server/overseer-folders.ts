import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { OverseerGuard } from "./overseer-deny";
import { projectOf } from "./project-root";
import { reservedRoots } from "./projects/contributions";

/**
 * The folders the global Overseer may add as projects (§app.overseer/org-project-add): an absolute folder of
 * this host, or `~/…` in the user's home, never one its file guard denies (credentials, an org workspace,
 * §app.overseer/tools). The card's folder rows, the tool and the project routes all ask here, so the click
 * approves exactly the root the route registers.
 */

/** `~` and `~/…` in the user's home; anything else as given (trimmed). */
export function expandHome(raw: string): string {
  const t = raw.trim();
  if (t === "~") return homedir();
  return t.startsWith("~/") ? join(homedir(), t.slice(2)) : t;
}

/** The refusal of a folder the Overseer's file guard denies. */
export const GUARDED_FOLDER = "That folder holds credentials or an organization's workspace; the Overseer can't add it.";

/** Why the Overseer may not add `path` (absolute), or null. The workspaces are the ones attached now (the roots the
    org layer reserves: this module is the project layer's too, so it names no org, §app.projects/seam). */
export function guardedFolderProblem(path: string): string | null {
  const guard = new OverseerGuard(reservedRoots());
  return guard.isSecret(path) ? GUARDED_FOLDER : null;
}

/** The checkout root `raw` (absolute or `~/…`) registers as, with the folder asked for, or why the Overseer may not add it. */
export async function overseerFolder(raw: unknown): Promise<{ root: string; asked: string } | { problem: string }> {
  if (typeof raw !== "string" || !raw.trim()) return { problem: "root must be a folder path" };
  const asked = expandHome(raw);
  if (!isAbsolute(asked)) return { problem: "root must be an absolute folder path (or ~/…)" };
  const guarded = guardedFolderProblem(asked);
  if (guarded) return { problem: guarded };
  const p = await projectOf(asked);
  if (p.state !== "ok") return { problem: p.state === "none" ? "root must be a folder path" : p.message };
  const again = guardedFolderProblem(p.root);
  if (again) return { problem: again };
  return { root: p.root, asked };
}
