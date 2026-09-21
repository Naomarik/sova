// What the "This session can't be opened" banner says (spec/01-app-shell.md "The open-failure
// banner"): a pure derivation from the session summary, the server's config-failure text, the
// targets list (labels only), and — when a Mount click has already failed — the mount attempt's
// own error. Pure, so every sentence and every offered action is testable without a browser.
//
// The server's two failure shapes (server/chat-manager.ts acquireChat/openSession):
//   Stored session working directory is not reachable through its mount: <reason>
//   Session file: <path>
//   Stored session working directory does not exist: <cwd>
//   Session file: <path>
// The mount shape only happens for a cwd inside a target's CONFIGURED mount point, so its
// presence alone proves the target declares a mount. The reason then says which world it is:
// "no mount at <point>" is the only one mounting fixes (the mount table has no entry there);
// anything else — a hung or unreadable mount, a folder gone through an up mount — mounting
// cannot, so those offer no Mount button.

import { remotePlaceOf, type TargetInfo } from "./remote-session";

export type OpenFailureKind =
  /** The session's cwd is inside the target's declared mount point and the mount is off: mounting is what fixes it. */
  | "mount-down"
  /** The target's mount is configured but couldn't be read (hung, unreadable, the target no longer configured). */
  | "mount-broken"
  /** The mount is up, but the session's folder inside it is gone on the target. */
  | "mount-folder-gone"
  /** The stored cwd doesn't exist locally: a plain folder, or a remote session's placeholder. */
  | "folder-gone"
  /** Anything else the server refused with: shown verbatim. */
  | "unknown";

export type OpenFailureActionId = "mount" | "reconnect" | "archive";

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
  /** Mount-mode session: the cwd is inside the target's mount point. */
  mounted?: boolean;
  /** Archiving is pi-web's gesture for sessions it started and hasn't archived (the pane's rule). */
  origin?: "web" | "external";
  archived?: boolean;
}

export interface OpenFailureView {
  kind: OpenFailureKind;
  /** The target this session runs on, when its summary says so: what the Mount action mounts. */
  target?: string;
  title: string;
  detail: string;
  actions: OpenFailureAction[];
  /** The caption for a Mount click that failed: the mount module's real reason, anchored. */
  mountError?: string;
}

// The server's first lines, verbatim (server/chat-manager.ts). Only the first line carries the
// diagnosis; "Session file: <path>" is the second and isn't restated — the user is in the session.
const MOUNT_PREFIX = "Stored session working directory is not reachable through its mount: ";
const GONE_PREFIX = "Stored session working directory does not exist: ";
/** The mount module's reason when the mount table has no entry at the point (mount.ts verifyMounted). */
const NO_MOUNT_PREFIX = "no mount at ";
/** The mount module's reason when the mount is up but the folder isn't there on the target. */
const NO_SUCH_PREFIX = "no such directory through the mount: ";

const RECONNECT: OpenFailureAction = { id: "reconnect", label: "Reconnect" };
const ARCHIVE: OpenFailureAction = {
  id: "archive",
  label: "Archive",
  title: "Move this session to the Archive region. Nothing is deleted; unarchive brings it back.",
};
const mountAction = (label: string): OpenFailureAction => ({
  id: "mount",
  label: "Mount and reconnect",
  title: `Mount ${label}'s sshfs mount again, then reopen this session.`,
});

const firstLine = (s: string) => (s.split("\n", 1)[0] ?? "").trim();
/** The chip's label rule: the target's label when the list has it, else the name (a true label too). */
const labelOf = (name: string, targets?: readonly TargetInfo[]) => targets?.find((t) => t.name === name)?.label || name;
/** The pane's rule: Archive is offered for web sessions that aren't already archived. */
const canArchive = (s: OpenFailureSession | undefined) => !!s && s.origin === "web" && s.archived !== true;

/**
 * The banner for a session the server refused to open (WS error code "config"): what's wrong,
 * named concretely, and the actions that fix it. `summary` may be missing (an old or partial
 * row): the copy degrades to what the error text alone proves. `targets` is labels only — never
 * a liveness or mount fact; the error text itself proves the target declares a mount.
 * `mountFailure` is the error of a Mount button click that already failed, if one did.
 */
export function openFailureView(
  summary: OpenFailureSession | undefined,
  error: string,
  targets?: readonly TargetInfo[],
  mountFailure?: string | null,
): OpenFailureView {
  const mountError = mountFailure?.trim() ? `Mount failed: ${mountFailure.trim()}` : undefined;
  const line = firstLine(error);
  const place = summary ? remotePlaceOf(summary) : null;

  // The session's cwd is inside a target's mount point, and the mount couldn't prove it works.
  if (line.startsWith(MOUNT_PREFIX)) {
    const reason = line.slice(MOUNT_PREFIX.length).trim();
    const target = place?.target;
    const label = target ? labelOf(target, targets) : undefined;
    const files = (l: string, where: string) => `This session's files are on ${l}, in ${place!.remoteCwd} — locally they're reached through ${where}.`;
    const actions: OpenFailureAction[] = [];

    // The mount table has no entry at the point: mounting is the fix, so the banner offers it.
    if (reason.startsWith(NO_MOUNT_PREFIX)) {
      const point = reason.slice(NO_MOUNT_PREFIX.length).trim();
      actions.push(...(target ? [mountAction(labelOf(target, targets))] : []), RECONNECT);
      if (canArchive(summary)) actions.push(ARCHIVE);
      return {
        kind: "mount-down",
        target,
        title: `This session can't be opened: ${label ? `${label}'s` : "its"} mount is down.`,
        detail: target
          ? `${files(label!, `the sshfs mount at ${point}`)} The mount isn't up right now, so they can't be read here. ` +
            `Nothing in the session file changed: mounting ${label} again brings the folder back, and the session opens as it was.`
          : `Its working directory sits inside a target's sshfs mount, and that mount isn't up right now (${reason}). ` +
            "Nothing in the session file changed — mount the target, then reconnect.",
        actions,
        mountError,
      };
    }

    // The mount is up but the folder isn't there on the target: mounting can't bring it back.
    if (reason.startsWith(NO_SUCH_PREFIX)) {
      actions.push(RECONNECT);
      if (canArchive(summary)) actions.push(ARCHIVE);
      return {
        kind: "mount-folder-gone",
        target,
        title: `This session can't be opened: its folder is gone${label ? ` on ${label}` : ""}.`,
        detail: target
          ? `${files(label!, "the target's sshfs mount")} The mount is up, but that folder doesn't exist on ${label} anymore. Nothing in the session file changed.`
          : `Its working directory sits inside a target's sshfs mount, and that folder isn't there anymore (${reason}). Nothing in the session file changed.`,
        actions,
        mountError,
      };
    }

    // Any other read failure (hung, unreadable, the target no longer configured): the mount
    // module's real reason, verbatim. No Mount button — the mount is already there.
    actions.push(RECONNECT);
    if (canArchive(summary)) actions.push(ARCHIVE);
    return {
      kind: "mount-broken",
      target,
      title: "This session can't be opened: its mount can't be read.",
      detail: target
        ? `${files(label!, "the target's sshfs mount")} The mount couldn't be read: ${reason}. Nothing in the session file changed.`
        : `Its working directory sits inside a target's sshfs mount, and that mount couldn't be read: ${reason}. Nothing in the session file changed.`,
      actions,
      mountError,
    };
  }

  // The stored cwd doesn't exist. A remote session's is a local placeholder; a mount session's
  // is the target's folder seen through the mount; everything else is a plain local folder.
  if (line.startsWith(GONE_PREFIX)) {
    const cwd = summary?.cwd ?? line.slice(GONE_PREFIX.length).trim();
    const target = place?.target;
    const label = target ? labelOf(target, targets) : undefined;
    const actions: OpenFailureAction[] = [RECONNECT];
    if (canArchive(summary)) actions.push(ARCHIVE);

    if (target && summary?.mounted === true)
      return {
        kind: "folder-gone",
        target,
        title: "This session can't be opened: its folder is gone.",
        detail:
          `This session's files are on ${label}, in ${place!.remoteCwd}, through the target's sshfs mount — and its local folder ${cwd} is gone. ` +
          "Nothing in the session file changed — restore the folder, then reconnect.",
        actions,
        mountError,
      };
    if (target)
      return {
        kind: "folder-gone",
        target,
        title: "This session can't be opened: its local placeholder folder is gone.",
        detail:
          `This session's files are on ${label}, in ${place!.remoteCwd}. Locally they're a placeholder folder — ${cwd} — and that folder is gone. ` +
          "Nothing in the session file changed: restore the folder, then reconnect. (A new session in the same remote folder recreates the placeholder.)",
        actions,
        mountError,
      };
    return {
      kind: "folder-gone",
      title: "This session can't be opened: its folder is gone.",
      detail: `The session's working directory ${cwd} doesn't exist on this machine. Nothing in the session file changed — restore the folder, then reconnect.`,
      actions,
      mountError,
    };
  }

  // Anything else (an older server's wording, a failure this version doesn't classify): the
  // server's text verbatim, with the same reassurance and the same way back.
  const actions: OpenFailureAction[] = [RECONNECT];
  if (canArchive(summary)) actions.push(ARCHIVE);
  const raw = error.trim();
  return {
    kind: "unknown",
    title: "This session can't be opened.",
    detail: raw ? `${raw} Nothing in the session file changed.` : "Nothing in the session file changed.",
    actions,
    mountError,
  };
}