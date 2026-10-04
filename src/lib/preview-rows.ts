import { PREVIEW_NOT_KEPT, type PreviewTarget, type PreviewView } from "../../shared/preview-links";
import { expiresWord } from "./session-shares";

/**
 * One row of the project page's Previews card (§mesh.public/preview-card): what it is for, the
 * coding session and branch it shows, what it serves, who made it, whether it serves now, its
 * expiry and its link. Pure: the card renders what this returns.
 */

export interface PreviewRow {
  title: string;
  /** The coding session it shows; `href` is its in-app link, `sova://s/<id>`, when the id is known. */
  session: { title: string; href: string | null } | null;
  branch: string | null;
  /** "static files" / "app on port N". */
  serves: string;
  /** The session was matched now by the app's folder, not recorded at the mint. */
  matched: boolean;
  /** "Made by you" / "Made by the overseer" (`href`: that conversation), or null when unknown. */
  maker: { text: string; href: string | null } | null;
  state: { text: string; tone: "ok" | "warn" | "info" };
  /** A copy link whose copy is stopped: the operator may Start it (`up`; a visit never starts anything). */
  start: { instance: string } | null;
  expires: string;
  /** The link to copy, or null; then `linkNote` says why there is none (null for a sibling: its link went to its person). */
  url: string | null;
  linkNote: string | null;
}

/** What a preview shows; one made before targets were listed reads as its port. */
export const previewTarget = (v: PreviewView): PreviewTarget => v.target ?? { kind: "port", port: v.port };

export const sessionHref = (id: string): string => `sova://s/${id}`;

/** A folder as the row names it: "." is the worktree itself. */
const folderName = (folder: string): string => (folder === "." || folder === "" ? "the worktree" : folder);

/** The row's title: its purpose, else what it shows. */
export function previewTitle(v: PreviewView): string {
  const purpose = v.purpose?.trim();
  if (purpose) return purpose;
  if (v.endpoint) return `Preview of a copy's ${v.endpoint}`;
  const t = previewTarget(v);
  return t.kind === "port" ? `Preview of port ${t.port}` : `Preview of ${folderName(t.folder)}`;
}

export const servesLine = (t: PreviewTarget): string => (t.kind === "port" ? `app on port ${t.port}` : "static files");

/** A copy link's serves part: its endpoint and the copy's slot ("the main checkout's copy" for slot 0). */
export const copyServesLine = (endpoint: string, slot: number | null): string => `${endpoint} of ${slot === 0 ? "the main checkout's copy" : slot === null ? "a copy" : `the copy in slot ${slot}`}`;

/** Whether it serves now: a copy link's copy running, starting or stopped; else an app answers on its port, or Sova serves its folder. */
export function stateLine(v: PreviewView): { text: string; tone: "ok" | "warn" | "info" } {
  if (v.instance) {
    const s = v.copy?.state ?? "stopped";
    return s === "running" ? { text: "Running", tone: "ok" } : s === "starting" ? { text: "Starting", tone: "info" } : { text: "Stopped", tone: "warn" };
  }
  if (v.running) return { text: "Serving", tone: "ok" };
  const t = previewTarget(v);
  return { text: t.kind === "port" ? `Nothing on port ${t.port}` : "Folder not served", tone: "warn" };
}

/** Who sent a recipient's link, for its name's tooltip. */
export const senderLine = (createdBy: string): string | null => (createdBy === "operator" ? "Sent by you" : createdBy.startsWith("session:") ? "Sent by the overseer" : null);

/** `operator` is you; `session:<id>` is the project overseer's conversation that made it. */
export function makerLine(createdBy: string): { text: string; href: string | null } | null {
  if (createdBy === "operator") return { text: "Made by you", href: null };
  const m = /^session:(.+)$/.exec(createdBy);
  return m ? { text: "Made by the overseer", href: sessionHref(m[1]!) } : null;
}

/** `minted` is the link this page's own New Preview answered with, if any. */
export function previewRow(v: PreviewView, now: number, minted?: string): PreviewRow {
  const id = v.sessionId ?? null;
  const sessionTitle = v.sessionTitle?.trim() || null;
  const url = v.url || minted;
  return {
    title: previewTitle(v),
    session: sessionTitle || id ? { title: sessionTitle ?? "Coding session", href: id ? sessionHref(id) : null } : null,
    branch: v.branch?.trim() || null,
    serves: v.endpoint ? copyServesLine(v.endpoint, v.copy?.slot ?? null) : servesLine(previewTarget(v)),
    matched: v.sessionFrom === "worktree",
    maker: makerLine(v.createdBy),
    state: stateLine(v),
    start: v.instance && v.copy?.state === "stopped" && v.state === "active" ? { instance: v.instance } : null,
    expires: expiresWord(v.expiresAt, now),
    url: url || null,
    // A sibling's link went to its person, never to this page: no "not kept" line for it.
    linkNote: url || v.siblingOf ? null : PREVIEW_NOT_KEPT,
  };
}
