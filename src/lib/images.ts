// Image attachments (spec/04b-images.md §4b): validating picked/pasted/dropped files and uploading
// each one the moment it's attached, into the session's attachments folder, so it's part of the
// draft and survives a reload. Like pi's TUI, the prompt then names each file's path and the
// model reads it with the read tool; no base64 goes over the socket.

import type { UploadResult } from "../../shared/protocol";
import { uploadImage } from "./api";
import { isObj, str } from "./message";

/** The formats model providers accept. */
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 8;

/** An attachment already stored on the server: the draft's own record, plus what the strip needs. */
export interface PendingImage extends UploadResult {
  id: number;
  /** Served by the server from the stored file; nothing to revoke. */
  previewUrl: string;
}

/** A file that passed validation and is about to upload. */
export interface AcceptedFile {
  id: number;
  name: string;
  file: File;
}

export interface RejectedFile {
  id: number;
  name: string;
  /** "Unsupported type" / "Over 5 MB" / "Over 8 images" / "Upload failed" (fits the ~18-character meta line). */
  reason: string;
}

let nextId = 0;

const displayName = (file: File, pasted: boolean) => (pasted || !file.name ? "Pasted image" : file.name);

/** Splits files into ones to upload and rejections, given how many are already pending (uploaded
    or still uploading). */
export function acceptFiles(files: File[], pendingCount: number, pasted = false): { accepted: AcceptedFile[]; rejected: RejectedFile[] } {
  const accepted: AcceptedFile[] = [];
  const rejected: RejectedFile[] = [];
  for (const file of files) {
    const name = displayName(file, pasted);
    if (!ACCEPTED_TYPES.includes(file.type)) rejected.push({ id: ++nextId, name, reason: "Unsupported type" });
    else if (file.size > MAX_IMAGE_BYTES) rejected.push({ id: ++nextId, name, reason: "Over 5 MB" });
    else if (pendingCount + accepted.length >= MAX_IMAGES) rejected.push({ id: ++nextId, name, reason: "Over 8 images" });
    else accepted.push({ id: ++nextId, name, file });
  }
  return { accepted, rejected };
}

/** Uploads one accepted file into `sessionPath`'s attachments folder. The row keeps the name the
    user knows ("Pasted image", or the picked file's own), not the stored one. */
export const uploadAccepted = (a: AcceptedFile, sessionPath: string): Promise<UploadResult> =>
  uploadImage(a.file, sessionPath).then((u) => ({ ...u, name: a.name }));

const previewUrl = (path: string) => `/api/attachment?path=${encodeURIComponent(path)}`;

/** A stored attachment as a strip row. */
export const pendingFrom = (a: UploadResult): PendingImage => ({ ...a, id: ++nextId, previewUrl: previewUrl(a.path) });

/** Whether a drag carries at least one image we'd accept (some platforms hide types until drop). */
export function dragHasAcceptedImage(dt: DataTransfer): boolean {
  const items = [...dt.items];
  if (items.length === 0 || items.every((i) => !i.type)) return true;
  return items.some((i) => i.kind === "file" && ACCEPTED_TYPES.includes(i.type));
}

/** The prompt as sent: the typed text, then each uploaded path on its own line (pi's TUI shape). */
export const withImagePaths = (text: string, uploads: { path: string }[]) => [text, ...uploads.map((u) => u.path)].filter(Boolean).join("\n");

/** Image blocks in a pi content array (`{type:"image", data, mimeType}`) as data URLs. */
export function imagesFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content) {
    if (isObj(c) && c.type === "image" && typeof c.data === "string") {
      out.push(`data:${str(c.mimeType) ?? "image/png"};base64,${c.data}`);
    }
  }
  return out;
}
