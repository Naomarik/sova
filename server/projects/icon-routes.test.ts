// Run: pnpm test -- server/projects/icon-routes.test.ts. The icon routes (§app.projects/icon) through an in-process app:
// the picture's headers, letters as a 404, the upload, letters and remove round trip, and the Overseer refused.
// A throwaway PI_CODING_AGENT_DIR and project folder; no network.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import type { ProjectIconInfo, ProjectSummary } from "../../shared/projects";
import { linkPiConfigExtensions } from "../testing/agent-dir";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-icon-routes-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);

const { registerProjectRoutes } = await import("./routes");
const { closeAllOrgHosts } = await import("../org-engine");
const { OVERSEER_SENDER_HEADER, senderSecret } = await import("../overseer-sender");
after(() => closeAllOrgHosts());

const app = new Hono();
registerProjectRoutes(app);
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const root = join(tmp, "widget");
mkdirSync(join(root, "public"), { recursive: true });
writeFileSync(join(root, "public", "apple-touch-icon.png"), png(180, 180));
const reg = await call("POST", "/api/projects", { root });
assert.equal(reg.status, 201);
const pid = ((await reg.json()) as { project: ProjectSummary }).project.id;
const summary = async () => (await (await call("GET", `/api/projects/${pid}`)).json()) as ProjectSummary;

test("the summary carries the found icon; GET …/icon serves it inert, immutable only at the current v", async () => {
  const s = await summary();
  assert.equal(s.icon?.source, "found");
  const listed = ((await (await call("GET", "/api/projects")).json()) as { projects: ProjectSummary[] }).projects.find((p) => p.id === pid);
  assert.deepEqual(listed?.icon, s.icon);
  const hit = await call("GET", `/api/projects/${pid}/icon?v=${s.icon!.v}`);
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get("content-type"), "image/png");
  assert.equal(hit.headers.get("x-content-type-options"), "nosniff");
  assert.equal(hit.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(hit.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(Buffer.from(await hit.arrayBuffer()).length, png(180, 180).length);
  const stale = await call("GET", `/api/projects/${pid}/icon?v=old`);
  assert.equal(stale.headers.get("cache-control"), "no-store");
  assert.equal((await call("GET", "/api/projects/prj_nothere1/icon")).status, 404);
});

test("upload, letters and remove round trip; letters answer 404", async () => {
  const info = (await (await call("GET", `/api/projects/${pid}/icon/info`)).json()) as ProjectIconInfo;
  assert.equal(info.use, "found");
  assert.equal(info.found?.path, "public/apple-touch-icon.png");

  const put = await call("PUT", `/api/projects/${pid}/icon`, { png: png(256, 256).toString("base64") });
  assert.equal(put.status, 200);
  assert.equal(((await put.json()) as ProjectIconInfo).use, "upload");
  assert.equal((await summary()).icon?.source, "upload");
  assert.equal((await call("PUT", `/api/projects/${pid}/icon`, { png: Buffer.from("GIF89a....................").toString("base64") })).status, 415);
  assert.equal((await call("PUT", `/api/projects/${pid}/icon`, { png: png(300, 100).toString("base64") })).status, 400);

  const letters = await call("PATCH", `/api/projects/${pid}/icon`, { letters: true });
  assert.equal(((await letters.json()) as ProjectIconInfo).use, "letters");
  assert.equal((await summary()).icon, undefined);
  const gone = await call("GET", `/api/projects/${pid}/icon`);
  assert.equal(gone.status, 404);
  assert.equal(gone.headers.get("cache-control"), "no-store");
  assert.equal((await call("PATCH", `/api/projects/${pid}/icon`, { letters: "yes" })).status, 400);

  assert.equal(((await (await call("PATCH", `/api/projects/${pid}/icon`, { letters: false })).json()) as ProjectIconInfo).use, "upload");
  const removed = (await (await call("DELETE", `/api/projects/${pid}/icon`)).json()) as ProjectIconInfo;
  assert.equal(removed.use, "found");
  assert.equal(removed.uploaded, undefined);
});

test("the Overseer's own calls can't change an icon", async () => {
  const h = { [OVERSEER_SENDER_HEADER]: senderSecret() };
  assert.equal((await call("PUT", `/api/projects/${pid}/icon`, { png: png(128, 128).toString("base64") }, h)).status, 403);
  assert.equal((await call("PATCH", `/api/projects/${pid}/icon`, { letters: true }, h)).status, 403);
  assert.equal((await call("DELETE", `/api/projects/${pid}/icon`, undefined, h)).status, 403);
  assert.equal((await summary()).icon?.source, "found", "nothing changed");
});
