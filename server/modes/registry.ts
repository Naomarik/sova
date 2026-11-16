// The one registry of a chat's minor modes (§chat.mode-menu/sova-runs-modes, §chat.mode-menu/personal-modes):
// the built-ins are minor.ts's closed table; beside them, one listing of the chat's checkout's project modes
// with the user's personal modes merged in ("yours wins", personal.ts). The engine (engine.ts) turns modes on
// from it; the mode menu (project-mode-menu.ts) and the mode commands read the same merge.
import { join } from "node:path";
import { discoverProjectModes, readProjectMode } from "../../pi-config/extensions/mode/project-discovery.ts";
import { PROJECT_MODES_DIR, type ProjectModeListing } from "../../pi-config/extensions/mode/project-format.ts";
import { isApproved } from "../../pi-config/extensions/mode/project-tools-approval.ts";
import type { ModeSource } from "./engine";
import { approvalRootFor, approvalRootOfDir, discoverPersonalModes, isPersonalDir, isPersonalId, mergeModeListings, personalModesDir, projectRootForDir, type MergedModeListing } from "./personal";

/** A chat's listing now: its checkout's project modes with the personal ones merged in. */
export function listingFor(cwd: string): MergedModeListing {
  const project = discoverProjectModes(cwd);
  // A chat with no checkout gets no personal modes, as its menu offers none (project-mode-menu.ts).
  return mergeModeListings(project, project.root === null ? null : discoverPersonalModes());
}

/** The source the engine reads: project and personal modes on one listing. */
export const PERSONAL_AND_PROJECT: ModeSource = {
  listing: (cwd) => listingFor(cwd),
  read: (listing, id) =>
    isPersonalId(listing, id) ? readProjectMode((listing as MergedModeListing).personalRoot ?? personalModesDir(), id) : readProjectMode(join(listing.root!, PROJECT_MODES_DIR), id),
  approved: (listing: ProjectModeListing, copy) => {
    const root = isPersonalDir(copy.dir) ? approvalRootOfDir(copy.dir) : approvalRootFor(listing, copy.id);
    return root !== null && isApproved(root, copy.id, copy.toolsHash);
  },
  projectRoot: (copy, cwd) => (isPersonalDir(copy.dir) ? projectRootForDir(copy.dir, cwd) : undefined),
};

/** modes-entry.ts's source: every chat the engine runs gets personal modes. */
export const personalModesSource = (): ModeSource => PERSONAL_AND_PROJECT;
