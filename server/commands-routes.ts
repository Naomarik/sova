// GET /api/commands (§app.served-commands/route): the catalogue as this running server knows it, for
// scripts (scripts/sova.mjs list and describe). Core entries, then each installed extension's own
// `ext.<id>.<name>` entries (server/extensions.ts installedExtensionCommands: the manifest's offers,
// never a backend probe), then which server answered. Main listener only: the peer listener's
// classifier gives the path `full` (server/mesh/access.ts), and the share listener has no such route.
// It is the catalogue itself, not a catalogue entry (server/commands-inventory/scan.ts `catalogue`).
import { readFileSync } from "node:fs";
import type { Hono } from "hono";
import { buildRequest, type BuiltRequest, COMMANDS, type CommandEntry, isDotSegment } from "../shared/commands-catalog";
import { DENIED } from "../shared/mesh-access";
import { COMMAND_HEADER } from "./command-audit";
import { installedExtensionCommands } from "./extensions";
import { classifyRequest, type Need } from "./mesh/access";
import { REFUSED_HEADER } from "./mesh/hello";
import { judgedPath } from "./mesh/paths";

export const COMMANDS_PATH = "/api/commands";

/** The answer's shape (the command line checks it before trusting it). */
export interface ServedCommands {
  version: 1;
  server: { version: string | null; head: string | null };
  commands: CommandEntry[];
}

/** Sova's package version, read once. */
const PACKAGE_VERSION: string | null = (() => {
  try {
    const v = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
})();

/** The answer, as of now: the manifest is re-read on every call (§app.extensions/manifest). */
export function servedCommands(head: string | null): ServedCommands {
  return { version: 1, server: { version: PACKAGE_VERSION, head }, commands: [...COMMANDS, ...installedExtensionCommands()] };
}

/** Mount the route; `head` is the commit this process's checkout had at startup (GET /api/health's). */
export function registerCommandsRoutes(app: Hono, head: string | null): void {
  app.get(COMMANDS_PATH, (c) => c.json(servedCommands(head)));
}

// ---- a remote command run on the peer listener (§mesh.peers/remote-commands) --------------------
// `POST /api/commands/<id>` reached on the peer listener (PeerGate, server/mesh/listener.ts), never
// on the main or share listener: no Hono route has it. The gate has already identified the peer and
// held it to the id's pinned need (server/mesh/access.ts commandNeed: the entry's own route's). Here
// the entry's request is built exactly as `sova run` builds it, must land on the entry's own route,
// and is gated again as the gate gates any request, then dispatched into the app as that peer.

/** The largest params object a remote run takes. */
export const PEER_COMMAND_MAX_BYTES = 1024 * 1024;

/** What the door's 404 says for an id this peer's catalogue doesn't run (sova tells it from an older
    peer's plain 404 by this). */
export const NO_COMMAND = "no command";

/** Headers of the peer's request that describe its own body or connection: never on the inner one. */
const BODY_HEADERS = ["content-length", "transfer-encoding", "content-encoding", "content-type", "expect", "connection", "keep-alive", "upgrade", COMMAND_HEADER];

export interface PeerCommandDeps<P> {
  /** The app's fetch (the same one every peer request is dispatched into). */
  fetch: (req: Request, env: Record<string, unknown>) => Response | Promise<Response>;
  /** The gate's own reach rule (listener.ts peerMayReach). */
  mayReach: (pathname: string) => boolean;
  /** The grant check (absent = always, as the gate's). */
  allows?: (peer: P, need: Need) => boolean;
}

const sentence = (status: number, error: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json", ...headers } });

/** A Hono path pattern as a regex over judged (decoded, lower-cased) paths. */
const routeRe = (path: string) => new RegExp(`^${path.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[^/]+/g, "[^/]+").replace(/\*/g, ".*")}$`);

async function readCapped(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > PEER_COMMAND_MAX_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PEER_COMMAND_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Run `id` for `peer` (the caller the gate let through), answering as the entry's own route does. */
export async function runPeerCommand<P>(req: Request, id: string, peer: P, env: Record<string, unknown>, deps: PeerCommandDeps<P>): Promise<Response> {
  const entry = COMMANDS.find((e) => e.id === id);
  if (!entry) return sentence(404, `${NO_COMMAND} ${id} on this host`);
  const text = await readCapped(req);
  if (text === null) return sentence(413, `a command's params are at most ${PEER_COMMAND_MAX_BYTES} bytes`);
  let values: unknown = {};
  if (text.trim()) {
    try {
      values = JSON.parse(text);
    } catch {
      return sentence(400, "the params must be one JSON object");
    }
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) return sentence(400, "the params must be one JSON object");
  for (const k of Object.keys(values)) if (!Object.hasOwn(entry.params, k)) return sentence(400, `${id} has no param ${k}`);
  const offRoute = () => sentence(400, `${id}: its params take the request off the command's own route`);
  // A dot segment would resolve out of the route: refused as the door refuses any such param (the builder refuses it too).
  for (const [k, p] of Object.entries(entry.params)) if (p.in === "path" && isDotSegment(String((values as Record<string, unknown>)[k] ?? ""))) return offRoute();
  let built: BuiltRequest;
  try {
    built = buildRequest(entry, values as Record<string, unknown>);
  } catch (err) {
    return sentence(400, err instanceof Error ? err.message : String(err));
  }
  // Resolved as fetch and the proxy resolve it: a ".." in a param is resolved here, never later.
  const inner = new URL(built.url, new URL(req.url).origin);
  const path = judgedPath(inner.pathname);
  // A route a peer never reaches gets the gate's own 404 for it, as when sent straight there.
  if (!deps.mayReach(inner.pathname) || inner.pathname.startsWith("/ws/")) return sentence(404, "Not found");
  if (!path || !routeRe(entry.route.path).test(path)) return offRoute();
  // Gated again, exactly as the gate gates a request sent straight to the route.
  const need = classifyRequest(built.method, inner.pathname).need;
  if (deps.allows && !deps.allows(peer, need)) return sentence(403, "not shared with this host", { [REFUSED_HEADER]: DENIED });
  const headers = new Headers(req.headers);
  for (const h of BODY_HEADERS) headers.delete(h);
  headers.set(COMMAND_HEADER, id);
  let body: string | undefined;
  if (built.body !== undefined) {
    body = JSON.stringify(built.body);
    headers.set("content-type", "application/json");
  }
  return deps.fetch(new Request(inner, { method: built.method, headers, body }), { ...env, meshPeer: peer });
}
