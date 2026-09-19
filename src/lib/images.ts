// Image attachments (DESIGN_NOTES §4b): validating picked/pasted/dropped files, blob previews,
// and converting to the wire's OutboundImage (base64 without the data: prefix) at send time.

import type { OutboundImage } from "../../shared/protocol";
import { isObj, str } from "./message";

/** The formats model providers accept. */
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 8;

export interface PendingImage {
  id: number;
  name: string;
  mimeType: string;
  size: number;
  file: File;
  /** `blob:` URL for the preview; revoke with `releaseImage` on remove and on send. */
  previewUrl: string;
}

export interface RejectedFile {
  id: number;
  name: string;
  /** "Not an image we can send" / "Over 5 MB" / "Over 8 images". */
  reason: string;
}

let nextId = 0;

const displayName = (file: File, pasted: boolean) => (pasted || !file.name ? "Pasted image" : file.name);

/** Splits files into accepted attachments and rejections, given how many are already pending. */
export function acceptImages(
  files: File[],
  pendingCount: number,
  pasted = false,
): { added: PendingImage[]; rejected: RejectedFile[] } {
  const added: PendingImage[] = [];
  const rejected: RejectedFile[] = [];
  for (const file of files) {
    const name = displayName(file, pasted);
    if (!ACCEPTED_TYPES.includes(file.type)) rejected.push({ id: ++nextId, name, reason: "Not an image we can send" });
    else if (file.size > MAX_IMAGE_BYTES) rejected.push({ id: ++nextId, name, reason: "Over 5 MB" });
    else if (pendingCount + added.length >= MAX_IMAGES) rejected.push({ id: ++nextId, name, reason: "Over 8 images" });
    else added.push({ id: ++nextId, name, mimeType: file.type, size: file.size, file, previewUrl: URL.createObjectURL(file) });
  }
  return { added, rejected };
}

export const releaseImage = (p: PendingImage) => URL.revokeObjectURL(p.previewUrl);

/** Whether a drag carries at least one image we'd accept (some platforms hide types until drop). */
export function dragHasAcceptedImage(dt: DataTransfer): boolean {
  const items = [...dt.items];
  if (items.length === 0 || items.every((i) => !i.type)) return true;
  return items.some((i) => i.kind === "file" && ACCEPTED_TYPES.includes(i.type));
}

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });

/** Reads attachments for sending: the wire form, plus data URLs for the optimistic bubble. */
export async function encodeImages(images: PendingImage[]): Promise<{ outbound: OutboundImage[]; dataUrls: string[] }> {
  const data = await Promise.all(images.map((p) => readBase64(p.file)));
  return {
    outbound: images.map((p, i) => ({ data: data[i]!, mimeType: p.mimeType })),
    dataUrls: images.map((p, i) => `data:${p.mimeType};base64,${data[i]}`),
  };
}

/** Rebuilds an attachment from a data URL (restoring a refused prompt's images into the draft). */
export function fromDataUrl(dataUrl: string, name: string): PendingImage {
  const mimeType = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? "image/png";
  const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const file = new File([Uint8Array.from(bin, (c) => c.charCodeAt(0))], name, { type: mimeType });
  return { id: ++nextId, name, mimeType, size: file.size, file, previewUrl: URL.createObjectURL(file) };
}

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
