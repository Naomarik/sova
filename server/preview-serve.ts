import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Folder previews (§mesh.public/preview-serve): a static file server Sova runs itself, one per
 * preview, on 127.0.0.1 only; the public preview proxy forwards to its port like any other preview.
 * Node builtins only. It serves regular files under the realpath of its root and nothing else: a
 * path with a segment starting with "." (so .git, .sova, .env and "..") or one that resolves
 * outside the root (encoded traversal, a symlink leaving it) is a plain 404, as is a directory
 * without index.html (never a listing) and a missing root. Only GET and HEAD (405 otherwise).
 * Serves live in Sova's process and end with it; the caller rebinds them on startup with the
 * recorded port.
 */

export interface StaticServe {
  id: string;
  /** Absolute; resolved to its realpath at each request, so a root made later serves then. */
  root: string;
  port: number;
}

/** The recorded port is taken by something else (`code` "port-taken"), or the bind failed. */
export class StaticServeError extends Error {
  constructor(
    readonly code: "port-taken" | "bind-failed",
    message: string,
  ) {
    super(message);
    this.name = "StaticServeError";
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

export function contentTypeOf(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

interface Entry extends StaticServe {
  server: Server;
}

const serves = new Map<string, Entry>();
const pending = new Map<string, Promise<{ port: number }>>();

/** Whether `real` is `realRoot` or inside it, with no path segment starting with ".". */
function inside(realRoot: string, real: string): boolean {
  const rel = relative(realRoot, real);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel.split(sep).every((s) => s !== "" && !s.startsWith("."));
}

/** The URL path's segments, decoded; null when any is refused (dot, separator, NUL, bad escape). */
function segmentsOf(url: string): string[] | null {
  const q = url.search(/[?#]/);
  const path = q < 0 ? url : url.slice(0, q);
  if (!path.startsWith("/")) return null;
  const out: string[] = [];
  for (const raw of path.split("/")) {
    if (raw === "") continue;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg.startsWith(".") || /[/\\\0]/.test(seg)) return null;
    out.push(seg);
  }
  return out;
}

/** The regular file a request names, or null (404). `redirect` when a directory lacks its slash. */
async function locate(root: string, url: string): Promise<{ file: string; size: number } | { redirect: string } | null> {
  const segs = segmentsOf(url);
  if (!segs) return null;
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return null;
  }
  try {
    let real = await realpath(join(realRoot, ...segs));
    if (!inside(realRoot, real)) return null;
    let st = await stat(real);
    if (st.isDirectory()) {
      const q = url.search(/[?#]/);
      const path = q < 0 ? url : url.slice(0, q);
      // Built from the decoded segments, so the Location is always a path on this origin.
      if (!path.endsWith("/")) return { redirect: `/${segs.map(encodeURIComponent).join("/")}/${q < 0 ? "" : url.slice(q)}` };
      real = await realpath(join(real, "index.html"));
      if (!inside(realRoot, real)) return null;
      st = await stat(real);
    }
    return st.isFile() ? { file: real, size: st.size } : null;
  } catch {
    return null;
  }
}

function plain(res: ServerResponse, status: number, body: string, head: boolean, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(head ? undefined : body);
}

function handler(root: string) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? "";
    const head = method === "HEAD";
    if (method !== "GET" && !head) {
      plain(res, 405, "Method Not Allowed\n", false, { Allow: "GET, HEAD" });
      return;
    }
    locate(root, req.url ?? "/").then(
      (found) => {
        if (!found) return plain(res, 404, "Not Found\n", head);
        if ("redirect" in found) return plain(res, 301, "Moved Permanently\n", head, { Location: found.redirect });
        res.writeHead(200, {
          "Content-Type": contentTypeOf(found.file),
          "Content-Length": found.size,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-cache",
        });
        if (head) return void res.end();
        const stream = createReadStream(found.file);
        stream.on("error", () => res.destroy());
        stream.pipe(res);
      },
      () => plain(res, 404, "Not Found\n", head),
    );
  };
}

function bind(root: string, port: number): Promise<Server> {
  return new Promise((ok, fail) => {
    const server = createServer(handler(root));
    const onError = (e: NodeJS.ErrnoException) => {
      server.close();
      fail(
        e.code === "EADDRINUSE"
          ? new StaticServeError("port-taken", `port ${port} on 127.0.0.1 is taken by something else`)
          : new StaticServeError("bind-failed", `cannot listen on 127.0.0.1:${port}: ${e.code ?? e.message}`),
      );
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      ok(server);
    });
  });
}

function close(entry: Entry): Promise<void> {
  return new Promise((done) => {
    entry.server.close(() => done());
    entry.server.closeAllConnections();
  });
}

/**
 * Serves `root` on 127.0.0.1: on `port` when given (the recorded one, on a rebind at startup), else
 * a free one. The same id and root again answers the running serve's port; the same id with another
 * root replaces it (on `port`, else the old port). Rejects with StaticServeError when the port is taken.
 */
export async function startStaticServe(opts: { id: string; root: string; port?: number }): Promise<{ port: number }> {
  const { id } = opts;
  const root = resolve(opts.root);
  while (pending.has(id)) await pending.get(id)!.catch(() => undefined);
  const running = serves.get(id);
  if (running && running.root === root && (opts.port === undefined || opts.port === running.port)) {
    return { port: running.port };
  }
  const job = (async () => {
    let port = opts.port ?? 0;
    if (running) {
      if (opts.port === undefined) port = running.port;
      serves.delete(id);
      await close(running);
    }
    const server = await bind(root, port);
    const bound = (server.address() as AddressInfo).port;
    serves.set(id, { id, root, port: bound, server });
    return { port: bound };
  })();
  pending.set(id, job);
  try {
    return await job;
  } finally {
    pending.delete(id);
  }
}

/** Stops the serve and frees its port; false when there was none. */
export async function stopStaticServe(id: string): Promise<boolean> {
  while (pending.has(id)) await pending.get(id)!.catch(() => undefined);
  const entry = serves.get(id);
  if (!entry) return false;
  serves.delete(id);
  await close(entry);
  return true;
}

export function staticServes(): StaticServe[] {
  return [...serves.values()].map(({ id, root, port }) => ({ id, root, port }));
}
