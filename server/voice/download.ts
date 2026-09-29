// Resumable downloads for voice setup: `<dest>.part` grows with HTTP Range requests, a streaming
// sha256 covers the bytes already there plus the new ones, and the file is renamed into place only
// when its size and hash match. A mismatch deletes the part: resuming a corrupt prefix would fail
// again forever.

import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream, renameSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DownloadOpts {
  url: string;
  dest: string;
  /** Expected size; known sizes let progress show a total from the first byte. */
  bytes?: number;
  /** Expected sha256 (hex). Without it the file is kept as fetched. */
  sha256?: string;
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
  /** For tests: the fetch to use. */
  fetchImpl?: typeof fetch;
}

export class DownloadError extends Error {}

const sizeOf = (f: string): number => {
  try {
    return statSync(f).size;
  } catch {
    return 0;
  }
};

async function hashFile(file: string, hash: Hash, signal?: AbortSignal, onProgress?: (done: number) => void): Promise<void> {
  let done = 0;
  let lastTick = 0;
  await pipeline(createReadStream(file), async function* (src) {
    for await (const chunk of src) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      hash.update(chunk as Buffer);
      done += (chunk as Buffer).length;
      const now = Date.now();
      if (onProgress && now - lastTick > 250) {
        lastTick = now;
        onProgress(done);
      }
    }
  });
  onProgress?.(done);
}

/** sha256 of a whole file, streamed; `onProgress` gets the bytes hashed so far. */
export async function sha256File(file: string, signal?: AbortSignal, onProgress?: (done: number) => void): Promise<string> {
  const h = createHash("sha256");
  await hashFile(file, h, signal, onProgress);
  return h.digest("hex");
}

/** Fetch `url` to `dest`, resuming `dest.part`. Resolves with the final size. */
export async function download(o: DownloadOpts): Promise<number> {
  const part = `${o.dest}.part`;
  const doFetch = o.fetchImpl ?? fetch;
  let have = sizeOf(part);
  if (o.bytes !== undefined && have > o.bytes) {
    rmSync(part, { force: true });
    have = 0;
  }
  const hash = createHash("sha256");
  if (have > 0) await hashFile(part, hash, o.signal);
  let total = o.bytes ?? 0;
  if (o.bytes === undefined || have < o.bytes) {
    const res = await doFetch(o.url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal: o.signal, redirect: "follow" });
    if (res.status === 416 && o.bytes !== undefined && have === o.bytes) {
      // The part is already whole.
    } else if (!res.ok || !res.body) {
      throw new DownloadError(`${new URL(o.url).host} answered ${res.status} ${res.statusText}`.trim());
    } else {
      if (have > 0 && res.status !== 206) {
        // The server ignored the range: start over.
        await res.body.cancel().catch(() => {});
        return download({ ...o, fetchImpl: wrapFresh(doFetch, part) });
      }
      const len = Number(res.headers.get("content-length") ?? 0);
      if (!total && len) total = have + len;
      let done = have;
      o.onProgress?.(done, total);
      let lastTick = 0;
      await pipeline(
        Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>),
        async function* (src) {
          for await (const chunk of src) {
            const buf = chunk as Buffer;
            hash.update(buf);
            done += buf.length;
            const now = Date.now();
            if (now - lastTick > 250) {
              lastTick = now;
              o.onProgress?.(done, total);
            }
            yield buf;
          }
        },
        createWriteStream(part, { flags: have > 0 ? "a" : "w" }),
        { signal: o.signal },
      );
      o.onProgress?.(done, total || done);
    }
  }
  const size = sizeOf(part);
  if (o.bytes !== undefined && size !== o.bytes) {
    rmSync(part, { force: true });
    throw new DownloadError(`the download ended at ${size} of ${o.bytes} bytes`);
  }
  if (o.sha256) {
    const got = hash.digest("hex");
    if (got !== o.sha256) {
      rmSync(part, { force: true });
      throw new DownloadError(`sha256 mismatch: got ${got.slice(0, 12)}…, expected ${o.sha256.slice(0, 12)}…. The file was deleted`);
    }
  }
  renameSync(part, o.dest);
  return size;
}

/** A retry after a server ignored Range: the part is truncated first so the fresh body replaces it. */
function wrapFresh(doFetch: typeof fetch, part: string): typeof fetch {
  rmSync(part, { force: true });
  return ((url: string | URL | Request, init?: RequestInit) => doFetch(url, { ...init, headers: {} })) as typeof fetch;
}
