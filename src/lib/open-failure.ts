// What the "This session can't be opened" banner says: a pure derivation from the session summary, the server's config-failure text and the
// targets list (labels only). Pure, so every sentence and every offered action is testable without
// a browser.
//
// The server's classified failure shape (server/chat-manager.ts acquireChat/openSession):
//   Stored session working directory does not exist: <cwd>
//   Session file: <path>
// Anything else it refuses with (an older server's wording) is shown
// verbatim with the same way back.

import { remotePlaceOf, type TargetInfo } from "./remote-session";

export type OpenFailureKind =
  /** The stored cwd doesn't exist locally: a plain folder, or a remote session's placeholder. */
  | "folder-gone"
  /** Anything else the server refused with: shown verbatim. */
  | "unknown";

export type OpenFailureActionId = "reconnect" | "archive";

export interface OpenFailureAction {
  id: OpenFailureActionId;
  label: string;
  /** A tooltip, only where the button needs one to be clear (Archive's says it isn't a delete). */
  title?: string;
}

/** What the decision needs from the session row; `SessionSummary` satisfies it structurally. */
export interface OpenFailureSession {
  /** The stored working directory — the thing that's missing or unreachable. */
  cwd: string;
  /** Remote session: its target, and the folder on it. */
  target?: string;
  remoteCwd?: string;
  /** Archiving is Sova's gesture for sessions it started and hasn't archived (the pane's rule). */
  origin?: "web" | "external";
  archived?: boolean;
}

export interface OpenFailureView {
  kind: OpenFailureKind;
  /** The target this session runs on, when its summary says so. */
  target?: string;
  title: string;
  detail: string;
  actions: OpenFailureAction[];
}

// The server's first line, verbatim (server/chat-manager.ts). Only the first line carries the
// diagnosis; "Session file: <path>" is the second and isn't restated — the user is in the session.
const GONE_PREFIX = "Stored session working directory does not exist: ";

const RECONNECT: OpenFailureAction = { id: "reconnect", label: "Reconnect" };
const ARCHIVE: OpenFailureAction = {
  id: "archive",
  label: "Archive",
  title: "Move this session to the Archive region. Nothing is deleted; unarchive brings it back.",
};

const firstLine = (s: string) => (s.split("\n", 1)[0] ?? "").trim();
/** The chip's label rule: the target's label when the list has it, else the name (a true label too). */
const labelOf = (name: string, targets?: readonly TargetInfo[]) => targets?.find((t) => t.name === name)?.label || name;
/** The pane's rule: Archive is offered for web sessions that aren't already archived. */
const canArchive = (s: OpenFailureSession | undefined) => !!s && s.origin === "web" && s.archived !== true;

/**
 * The banner for a session the server refused to open (WS error code "config"): what's wrong,
 * named concretely, and the actions that fix it. `summary` may be missing (an old or partial
 * row): the copy degrades to what the error text alone proves. `targets` is labels only — never
 * a liveness fact.
 */
export function openFailureView(summary: OpenFailureSession | undefined, error: string, targets?: readonly TargetInfo[]): OpenFailureView {
  const line = firstLine(error);
  const place = summary ? remotePlaceOf(summary) : null;
  const actions: OpenFailureAction[] = [RECONNECT];
  if (canArchive(summary)) actions.push(ARCHIVE);

  // The stored cwd doesn't exist. A remote session's is a local placeholder; everything else is a
  // plain local folder.
  if (line.startsWith(GONE_PREFIX)) {
    const cwd = summary?.cwd ?? line.slice(GONE_PREFIX.length).trim();
    const target = place?.target;
    const label = target ? labelOf(target, targets) : undefined;
    if (target)
      return {
        kind: "folder-gone",
        target,
        title: "This session can't be opened: its local placeholder folder is gone.",
        detail:
          `This session's files are on ${label}, in ${place!.remoteCwd}. Locally they're a placeholder folder — ${cwd} — and that folder is gone. ` +
          "Nothing in the session file changed: restore the folder, then reconnect. (A new session in the same remote folder recreates the placeholder.)",
        actions,
      };
    return {
      kind: "folder-gone",
      title: "This session can't be opened: its folder is gone.",
      detail: `The session's working directory ${cwd} doesn't exist on this machine. Nothing in the session file changed — restore the folder, then reconnect.`,
      actions,
    };
  }

  // Anything else (an older server's wording, a failure this version
  // doesn't classify): the server's text verbatim, with the same reassurance and the same way back.
  const raw = error.trim();
  return {
    kind: "unknown",
    title: "This session can't be opened.",
    detail: raw ? `${raw} Nothing in the session file changed.` : "Nothing in the session file changed.",
    actions,
  };
}
