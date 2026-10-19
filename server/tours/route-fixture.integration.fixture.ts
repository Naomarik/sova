import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tourEditionAssetsFixture, tourEditionFixture } from "../../shared/tour-fixtures";

export interface TourRouteRequest { method?: string; body?: unknown; headers?: Record<string, string>; auth?: boolean }
export interface TourRouteAnswer { status: number; headers: IncomingHttpHeaders; bytes: Buffer; text: string; json<T = unknown>(): T }
async function listen(server: Server): Promise<number> { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return (server.address() as AddressInfo).port; }
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
function send(base: string, path: string, input: TourRouteRequest = {}, ownerCookie?: string): Promise<TourRouteAnswer> {
  const url = new URL(base), body = input.body === undefined ? undefined : typeof input.body === "string" ? input.body : JSON.stringify(input.body);
  return new Promise((resolve, reject) => {
    const headers = { ...(ownerCookie ? { Cookie: ownerCookie, Origin: base, "Sec-Fetch-Site": "same-origin" } : {}), ...(body !== undefined ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } : {}), ...input.headers };
    const req = request({ host: "127.0.0.1", port: Number(url.port), path, method: input.method ?? "GET", headers, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => { const bytes = Buffer.concat(chunks), text = bytes.toString("utf8"); resolve({ status: res.statusCode ?? 500, headers: res.headers, bytes, text, json: <T>() => JSON.parse(text) as T }); });
      res.on("error", reject);
    });
    req.on("error", reject); req.setTimeout(15_000, () => req.destroy(new Error("The fixture HTTP request timed out."))); req.end(body);
  });
}
/** Once per test process. Real app, auth gate, sockets and share edge; no model is ever prompted. */
export async function createTourRouteFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tour-real-app-"))), agentDir = join(root, "agent"), state = join(agentDir, "sova"), cwd = join(root, "workspace");
  const names = ["PI_CODING_AGENT_DIR", "SOVA_SHARE_DIST", "SOVA_SHARE_PUBLIC_URL", "SOVA_AUTH", "SOVA_TOKEN", "HOST", "SOVA_ALLOWED_HOSTS", "SOVA_ALLOWED_ORIGINS", "SOVA_PRICES_FETCH", "SOVA_CHAT_STATE_ROOT"];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.SOVA_SHARE_DIST = join(root, "dist-share"); process.env.SOVA_PRICES_FETCH = "off"; process.env.SOVA_CHAT_STATE_ROOT = state;
  for (const name of ["SOVA_AUTH", "SOVA_TOKEN", "HOST", "SOVA_ALLOWED_HOSTS", "SOVA_ALLOWED_ORIGINS", "SOVA_SHARE_PUBLIC_URL"]) delete process.env[name];
  mkdirSync(join(agentDir, "sessions", "live"), { recursive: true }); mkdirSync(cwd, { recursive: true }); mkdirSync(process.env.SOVA_SHARE_DIST, { recursive: true });
  writeFileSync(join(process.env.SOVA_SHARE_DIST, "index.html"), "<!doctype html><html><title>Recorded tour fixture</title></html>");
  const { linkPiConfigExtensions } = await import("../testing/agent-dir"); linkPiConfigExtensions(agentDir);
  await import("../testing/in-process-chats");
  const { createSessionFile } = await import("../harness/pi/state"); const { SANDBOX } = await import("../harness/state-kinds");
  mkdirSync(join(agentDir, "sessions", "fixture"), { recursive: true });
  const made = createSessionFile({ cwd, sessionsDir: join(agentDir, "sessions", "fixture"), seed: [[SANDBOX, { version: 1, on: false, level: "workspace-write", workers: "off" }]] });
  // Exactly the app's own create path (createWebSessionFile): the fresh header write is recorded as Sova's.
  const { canonicalPath } = await import("../paths"); const { markOwned } = await import("../write-guard");
  const source = { id: made.id, path: canonicalPath(made.path) }; markOwned(source.path);
  const { acquireChat, heldChats } = await import("../chat-manager");
  const chat = await acquireChat(source.path);
  chat.harness.appendUserMessage("Explain this made-up interface without sending anything.");
  const sourceEdition = tourEditionFixture(); sourceEdition.sessionId = source.id;
  const { publishEdition } = await import("./store"); publishEdition(sourceEdition, tourEditionAssetsFixture());
  const { buildApp } = await import("../app"); const { app } = buildApp({ extensionEntriesOf: async () => [] });
  const { getRequestListener } = await import("@hono/node-server");
  const { AUTH_COOKIE, initAuthToken, setAuthPort, setAuthHosts, sovaToken } = await import("../auth");
  initAuthToken(); setAuthHosts(() => ({ magicDns: null, own: [], peers: [] }));
  const mainServer = createServer(getRequestListener(app.fetch)), mainPort = await listen(mainServer); setAuthPort(mainPort);
  const { createShareServer } = await import("../share/edge"); const shareServer = createShareServer(), sharePort = await listen(shareServer);
  const mainURL = `http://127.0.0.1:${mainPort}`, shareURL = `http://127.0.0.1:${sharePort}`, ownerCookie = `${AUTH_COOKIE}=${sovaToken()}`;
  process.env.SOVA_SHARE_PUBLIC_URL = shareURL;
  let closed = false;
  return {
    root, stateRoot: state, agentDir, sid: source.id, sessionFile: source.path, sourceEdition, app, mainURL, shareURL, ownerCookie,
    requestMain: (path: string, input: TourRouteRequest = {}) => send(mainURL, path, input, input.auth === false ? undefined : ownerCookie),
    requestShare: (path: string, input: TourRouteRequest = {}) => send(shareURL, path, input),
    async close() {
      if (closed) return; closed = true;
      await close(mainServer); await close(shareServer);
      const { closeChat } = await import("../chat-handle");
      for (const held of heldChats()) await closeChat(held.path, "The test fixture finished.").catch(() => false);
      const { tourRuntime } = await import("./runtime"); const runtime = tourRuntime();
      if (process.env.PI_CODING_AGENT_DIR === agentDir) await runtime.removeSession(source.id).catch(() => {});
      runtime.close();
      const { stopSessionShareLive } = await import("../share/session-live"); stopSessionShareLive();
      rmSync(root, { recursive: true, force: true });
      for (const [name, value] of previous) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    },
  };
}
