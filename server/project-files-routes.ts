import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import type { ProjectFilesAnswer } from "../shared/project-files";
import { OrgError } from "./org-error";
import { bytesHere, bytesPath, deleteFile, FileRefusal, fileOf } from "./project-files";
import { namedFileRows } from "./project-files-tool";
import { readProject } from "./projects/spaces";

/**
 * The project page's Files card (§app.organizations/files-card): the operator's main listener only.
 * The share listener never reads a file back (§app/file-intake).
 */

const NO_STORE = { "Cache-Control": "no-store" };

const handle =
  (fn: (c: Context, projectId: string) => Promise<Response> | Response) =>
  async (c: Context): Promise<Response> => {
    try {
      const projectId = c.req.param("pid") ?? "";
      readProject(projectId); // a 404 for an unknown project
      return await fn(c, projectId);
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message }, err.status, NO_STORE);
      if (err instanceof FileRefusal) return c.json({ error: err.message, code: err.code }, err.status, NO_STORE);
      throw err;
    }
  };

/** RFC 5987: the name as `filename*`, with a plain ASCII fallback. Pure. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** A downloaded file's headers: never rendered, never sniffed, never run. */
export const downloadHeaders = (name: string, size: number): Record<string, string> => ({
  "Content-Type": "application/octet-stream",
  "Content-Disposition": attachmentDisposition(name),
  "Content-Length": String(size),
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  ...NO_STORE,
});

export function registerProjectFileRoutes(app: Hono<any>): void {
  app.get(
    "/api/projects/:pid/files",
    handle((c, pid) => c.json({ files: namedFileRows(pid) } satisfies ProjectFilesAnswer, 200, NO_STORE)),
  );
  app.get(
    "/api/projects/:pid/files/:id",
    handle((c, pid) => {
      const rec = fileOf(pid, c.req.param("id") ?? "");
      if (!rec || !bytesHere(pid, rec)) return c.json({ error: "No such file on this host." }, 404, NO_STORE);
      const body = Readable.toWeb(createReadStream(bytesPath(pid, rec))) as unknown as ReadableStream;
      return new Response(body, { status: 200, headers: downloadHeaders(rec.name, rec.size) });
    }),
  );
  app.delete(
    "/api/projects/:pid/files/:id",
    handle((c, pid) => {
      deleteFile(pid, c.req.param("id") ?? "", "operator");
      return c.json({ ok: true }, 200, NO_STORE);
    }),
  );
}
