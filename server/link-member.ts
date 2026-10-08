// Whether a session file is a link member session (§mesh.links/tools): its create wrote the marker
// (POST /api/sessions with `link: true`), which alone gives a session the link tools and lets it be made
// a member of a new link (§mesh.links/record). A held chat reads the same marker from its own state
// (chat-manager.ts isLinkMember); this reads a file by path, for the link routes.
import { readBranch } from "./harness/pi/reader";
import { LINK_MEMBER } from "./harness/state-kinds";
import { stateView } from "./harness/state-view";

/** The marker is the file's first entry after its header, so it is on every branch. A file that can't
    be read is no link member. */
export async function isLinkMemberFile(path: string): Promise<boolean> {
  try {
    return stateView(await readBranch(path)).first(LINK_MEMBER) !== null;
  } catch {
    return false;
  }
}
