import { join, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Sova's own state root (`<agent dir>/sova/`): the JSON stores, durable attachments, the remote
 * placeholder layout, the connect seed dir, the user themes folder. Renamed from the legacy
 * `<agent dir>/pi-web/` with the product rename; the install procedure MOVES the whole directory
 * (atomic rename, backup kept), so reads live at the new root only — a read fallback would mask a
 * half-finished move.
 *
 * What DOES carry a legacy bridge is everything EMBEDDED in data the move can't rewrite:
 * transcripts name old attachment paths, session headers name old placeholder/connect cwds, and
 * this build must keep resolving those — `unlegacyStatePath` is the one primitive for it.
 * Read per call, like every agent-dir path: PI_CODING_AGENT_DIR is what the tests move.
 */
export const stateRoot = () => join(getAgentDir(), "sova");
export const legacyStateRoot = () => join(getAgentDir(), "pi-web");

/**
 * A path under the legacy state root, re-anchored at the new one; anything else passes through.
 * Lexical, no fs: the pre-move absolute paths live in transcripts and session headers forever, and
 * after the directory rename they resolve where the files actually are. Used at serving/classifying
 * boundaries, never rewritten back into any file.
 */
export function unlegacyStatePath(p: string): string {
  const legacy = legacyStateRoot() + sep;
  return p.startsWith(legacy) ? join(stateRoot(), p.slice(legacy.length)) : p;
}
