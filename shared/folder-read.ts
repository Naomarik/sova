/**
 * The read-only folder viewer's wire shapes (§app/folder-viewer): any folder of a registered project at a ref, or
 * one of Sova's own shipped folders by id. Served by GET /api/folders/list and /api/folders/read
 * (server/folder-read.ts). Pure types and helpers, imported by the server and the web app.
 */

export type FolderSource =
  /** `project`: the project's id; `ref`: a branch, tag or commit (empty: its main line); `dir`: root-relative. */
  | { kind: "project"; project: string; ref: string; dir: string }
  /** One of Sova's shipped folders (FOLDER_BUILTINS). */
  | { kind: "builtin"; id: string };

export type FolderFileKind = "markdown" | "text" | "binary" | "too-large";

export interface FolderListing {
  /** The commit the files are read at (a Git project). */
  commit?: string;
  files: { path: string; size: number; kind: FolderFileKind }[];
  /** More files than one listing returns. */
  truncated?: boolean;
}

export interface FolderFile {
  path: string;
  kind: "markdown" | "text";
  text: string;
  /** Cut at the size cap. */
  truncated?: boolean;
}

/** Sova's shipped folders a viewer may show, by id: its folder relative to Sova's install. */
export const FOLDER_BUILTINS: Readonly<Record<string, string>> = {
  "merge-queue-method": "playbooks/merge-queue",
};

/** The `src` query parameter of a source. Pure. */
export const folderSrcParam = (s: FolderSource): string => JSON.stringify(s);
