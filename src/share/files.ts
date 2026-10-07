import type { BatonFileUpload } from "../../shared/baton";
import type { UploadRefusal } from "./photos";

/**
 * A person's files on the share page (§app.baton/files): sent as they are, never processed, one
 * upload per file at attach, the name in `X-File-Name` (percent-encoded).
 */

/** "1 file", "3 files". Pure. */
export const filesWord = (n: number): string => (n === 1 ? "1 file" : `${n} files`);

/** POST the file's bytes; `progress` gets 0..1 while they go up. Resolves the staged file, or rejects with an UploadRefusal. */
export function uploadFile(token: string, file: Blob, name: string, progress: (p: number) => void): { done: Promise<BatonFileUpload>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<BatonFileUpload>((resolve, reject) => {
    xhr.open("POST", `/api/h/${token}/file`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(name));
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
      if (xhr.status === 201 && typeof body.id === "string") return resolve(body as unknown as BatonFileUpload);
      reject({ status: xhr.status, ...(typeof body.code === "string" ? { code: body.code } : {}), error: typeof body.error === "string" ? body.error : "Upload failed." } satisfies UploadRefusal);
    };
    xhr.onerror = () => reject({ status: 0, error: "Upload failed." } satisfies UploadRefusal);
    xhr.onabort = () => reject({ status: 0, code: "aborted", error: "Upload stopped." } satisfies UploadRefusal);
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}
