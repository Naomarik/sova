import { PHOTO_EDGE_MAX, type BatonPhotoUpload } from "../../shared/baton";

/**
 * A person's photos on the share page (§app.baton/images): processed on the device before they
 * leave it, then uploaded one at a time at attach.
 */

/** Where a photo's longest edge ends up: at most PHOTO_EDGE_MAX, never enlarged. Pure. */
export function fitEdge(width: number, height: number, max = PHOTO_EDGE_MAX): { width: number; height: number; scaled: boolean } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height, scaled: false };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true };
}

/** `KB` under 1 MB, rounded; else one decimal (as the operator's composer). Pure. */
export function sizeLabel(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class PhotoFormatError extends Error {}

/**
 * Decode with its orientation applied, scale to the longest-edge ceiling, re-encode: a JPEG at
 * quality 0.85, or a PNG that needed no scaling as a PNG. Drawing onto a canvas drops every
 * metadata segment (EXIF, GPS). A file the browser can't decode is a PhotoFormatError.
 */
export async function processPhoto(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new PhotoFormatError("This photo's format can't be sent.");
  }
  try {
    const fit = fitEdge(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = fit.width;
    canvas.height = fit.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoFormatError("This photo's format can't be sent.");
    const png = file.type === "image/png" && !fit.scaled;
    if (!png) {
      // JPEG has no transparency: a transparent pixel would come out black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, fit.width, fit.height);
    }
    ctx.drawImage(bitmap, 0, 0, fit.width, fit.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, png ? "image/png" : "image/jpeg", 0.85));
    if (!blob) throw new PhotoFormatError("This photo's format can't be sent.");
    return blob;
  } finally {
    bitmap.close();
  }
}

export interface UploadRefusal {
  status: number;
  code?: string;
  error: string;
}

/** POST the processed bytes; `progress` gets 0..1 while they go up. Resolves the staged photo, or rejects with an UploadRefusal. */
export function uploadPhoto(token: string, blob: Blob, progress: (p: number) => void): { done: Promise<BatonPhotoUpload>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<BatonPhotoUpload>((resolve, reject) => {
    xhr.open("POST", `/api/h/${token}/image`);
    xhr.setRequestHeader("Content-Type", blob.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        body = {};
      }
      if (xhr.status === 201 && typeof body.id === "string") return resolve(body as unknown as BatonPhotoUpload);
      reject({ status: xhr.status, ...(typeof body.code === "string" ? { code: body.code } : {}), error: typeof body.error === "string" ? body.error : "Upload failed." } satisfies UploadRefusal);
    };
    xhr.onerror = () => reject({ status: 0, error: "Upload failed." } satisfies UploadRefusal);
    xhr.onabort = () => reject({ status: 0, code: "aborted", error: "Upload stopped." } satisfies UploadRefusal);
    xhr.send(blob);
  });
  return { done, abort: () => xhr.abort() };
}
