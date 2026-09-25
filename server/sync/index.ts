import { homedir } from "node:os";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MeshLoginEntry, MeshLogins, SyncCategory, SyncStatus } from "../../shared/protocol";
import type { MeshApi } from "../mesh";
import { stateRoot } from "../state-root";
import { parseEntryKey, type EntryKey } from "./logins-merge";
import { ClaudeCredentialStore, PiAuthStore, piRefresher, type CredentialStore } from "./logins-stores";
import { CredentialSync, type CredentialStatusEntry, type CredentialEntryReply, type CredentialManifest, type CredentialPushReply, type SyncPeer } from "./logins";
import { DocSync, type DocManifest, type DocPeer, type DocPushReply, type DocReply } from "./docs";
import { ExtensionSync, type ExtensionList, type ExtensionPeer } from "./extensions";
import { extensionsFile, readExtensions, setPeerExtensions, validateExtension } from "../extensions";

/**
 * Host-to-host sync, mounted on the mesh. While the mesh is OFF nothing here exists beyond the
 * route handlers (which the peer gate makes unreachable): no service, no watcher, no timer, no
 * read of any store. The service is built on the mesh's start hook and dropped on its stop hook.
 *
 * Peer routes (peer listener only, never through the /peer/<id> browser proxy):
 *   GET  /api/peer/credentials/manifest
 *   GET  /api/peer/credentials/entry?key=<store>:<provider>
 *   POST /api/peer/credentials/push
 *   GET  /api/peer/sync/manifest            settings + themes
 *   GET  /api/peer/sync/doc?key=<key>
 *   POST /api/peer/sync/push
 *   GET  /api/peer/sync/extensions          this host's own extensions.json entries
 *   POST /api/peer/sync/extensions          a peer's list, pushed when its manifest changes
 *
 * Browser routes (main listener only; 404 while OFF and to any peer-listener caller):
 *   GET  /api/mesh/logins                   each login's standing here, never a secret
 *   POST /api/mesh/logins/claim {key}       keep this host's login for that key everywhere
 */

const PEER_CALL_TIMEOUT_MS = 5_000;
/** Watchers catch local edits and onPeerUp catches returns; this catches everything else. */
const RECONCILE_MS = 5 * 60_000;

/**
 * The Claude Code store this host syncs, or null. Only a host on the DEFAULT agent dir (a real
 * install) syncs Claude Code's own store; a hermetic agent dir (dev servers, tests) runs with the
 * real $HOME and must never touch the real ~/.claude, so it syncs Claude only when told where by
 * SOVA_SYNC_CLAUDE_DIR (the lab's simulated store).
 */
export function claudeSyncDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.SOVA_SYNC_CLAUDE_DIR) return env.SOVA_SYNC_CLAUDE_DIR;
  if (env.PI_CODING_AGENT_DIR) return null;
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Any request on the peer listener, verified or proxied through it: never a browser route. */
const onPeerListener = (c: Context): boolean => !!(c.env as { meshPeer?: unknown } | undefined)?.meshPeer;

/** A request that came through a browser proxy hop (ours sets X-Forwarded-Host) is never a peer call. */
const peerCaller = (mesh: MeshApi, c: Context): string | null =>
  c.req.header("x-forwarded-host") ? null : (mesh.requestPeer(c)?.id ?? null);

function peerCall(mesh: MeshApi, id: string) {
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await mesh.peerFetch(id, path, { ...init, signal: AbortSignal.timeout(PEER_CALL_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`${path.split("?")[0]}: HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  };
}

const postJson = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function httpDocPeer(mesh: MeshApi, id: string): DocPeer {
  const call = peerCall(mesh, id);
  return {
    id,
    manifest: () => call<DocManifest>("/api/peer/sync/manifest"),
    doc: (key) => call<DocReply>(`/api/peer/sync/doc?key=${encodeURIComponent(key)}`),
    push: (body) => call<DocPushReply>("/api/peer/sync/push", postJson(body)),
  };
}

function httpExtensionPeer(mesh: MeshApi, id: string): ExtensionPeer {
  const call = peerCall(mesh, id);
  return {
    id,
    extensions: () => call<ExtensionList>("/api/peer/sync/extensions"),
    notify: async (list) => void (await call<{ ok: true }>("/api/peer/sync/extensions", postJson(list))),
  };
}

function httpPeer(mesh: MeshApi, id: string): SyncPeer {
  const call = peerCall(mesh, id);
  return {
    id,
    manifest: () => call<CredentialManifest>("/api/peer/credentials/manifest"),
    entry: (key: EntryKey) => call<CredentialEntryReply>(`/api/peer/credentials/entry?key=${encodeURIComponent(key)}`),
    push: (body) => call<CredentialPushReply>("/api/peer/credentials/push", postJson(body)),
  };
}

export interface SyncRuntime {
  credentials: CredentialSync | null;
  docs: DocSync | null;
  extensions: ExtensionSync | null;
}

/** Where this host's stores live; read at mesh start. Tests pass scratch paths. */
export interface SyncPaths {
  agentDir: () => string;
  stateDir: () => string;
  claudeDir: () => string | null;
}
const defaultPaths: SyncPaths = { agentDir: getAgentDir, stateDir: stateRoot, claudeDir: () => claudeSyncDir() };

/** Mount the sync routes and hooks. Call after meshRoutes(app) (its /api/peer/* gate runs first). */
export function mountSync(app: Hono, mesh: MeshApi, paths: SyncPaths = defaultPaths): SyncRuntime {
  const rt: SyncRuntime = { credentials: null, docs: null, extensions: null };
  const loginsOn = () => mesh.settings().sync.logins;
  const categoryOn = (c: SyncCategory) => mesh.settings().sync[c];
  let reconcile: NodeJS.Timeout | undefined;
  const syncEverything = () => {
    void rt.credentials?.syncAll().catch((err) => console.error("[sync] logins:", err));
    void rt.docs?.syncAll().catch((err) => console.error("[sync] settings/themes:", err));
    void rt.extensions?.syncAll().catch((err) => console.error("[sync] extensions:", err));
  };

  const start = () => {
    if (rt.credentials) return;
    const authPath = join(paths.agentDir(), "auth.json");
    const stores: CredentialStore[] = [new PiAuthStore(authPath)];
    const claudeDir = paths.claudeDir();
    if (claudeDir) stores.push(new ClaudeCredentialStore(claudeDir));
    const sync = new CredentialSync({
      hostId: mesh.self().id,
      stores,
      sidecarPath: join(paths.stateDir(), "login-sync.json"),
      peers: () => mesh.peers().map((p) => httpPeer(mesh, p.id)),
      refreshers: { pi: piRefresher(authPath) },
      enabled: loginsOn,
    });
    rt.credentials = sync;
    void sync
      .start()
      .then(() => sync.syncAll())
      .catch((err) => console.error("[sync] credentials start failed:", err));

    const docs = new DocSync({
      hostId: mesh.self().id,
      agentDir: paths.agentDir(),
      stateDir: paths.stateDir(),
      sidecarPath: join(paths.stateDir(), "doc-sync.json"),
      peers: () => mesh.peers().map((p) => httpDocPeer(mesh, p.id)),
      categoryEnabled: categoryOn,
    });
    rt.docs = docs;
    void docs
      .start()
      .then(() => docs.syncAll())
      .catch((err) => console.error("[sync] settings/themes start failed:", err));

    const extensions = new ExtensionSync({
      hostId: mesh.self().id,
      file: join(paths.stateDir(), "mesh-extensions.json"),
      local: readExtensions,
      validate: validateExtension,
      peers: () => mesh.peers().map((p) => httpExtensionPeer(mesh, p.id)),
      peerIds: () => mesh.peers().map((p) => p.id),
      enabled: () => categoryOn("extensions"),
    });
    rt.extensions = extensions;
    setPeerExtensions(() => extensions.peerEntries());
    extensions.start(extensionsFile());
    void extensions.syncAll().catch((err) => console.error("[sync] extensions start failed:", err));

    reconcile = setInterval(syncEverything, RECONCILE_MS);
    reconcile.unref?.();
  };
  const stop = () => {
    clearInterval(reconcile);
    reconcile = undefined;
    rt.credentials?.stop();
    rt.credentials = null;
    rt.docs?.stop();
    rt.docs = null;
    setPeerExtensions(null);
    rt.extensions?.stop();
    rt.extensions = null;
  };
  mesh.onMeshStart(start);
  mesh.onMeshStop(stop);
  mesh.onPeerUp((id) => {
    if (!mesh.peers().some((p) => p.id === id)) return;
    if (rt.credentials) void rt.credentials.syncWith(httpPeer(mesh, id));
    if (rt.docs) void rt.docs.syncWith(httpDocPeer(mesh, id));
    if (rt.extensions) void rt.extensions.syncWith(httpExtensionPeer(mesh, id));
  });
  // A switch turned back on takes effect at once (off is read at every entry point anyway).
  mesh.onSettingsChange(() => {
    rt.docs?.observe();
    syncEverything();
  });
  mesh.onSyncStatus(() => [
    loginStatus(rt.credentials, loginsOn()),
    docStatus("settings", rt.docs, categoryOn("settings")),
    docStatus("themes", rt.docs, categoryOn("themes")),
    extensionStatus(rt.extensions, categoryOn("extensions")),
  ]);

  const notFound = (c: Context) => c.json({ error: "Not found" }, 404);
  app.get("/api/peer/credentials/manifest", (c) => {
    if (!peerCaller(mesh, c) || !rt.credentials) return notFound(c);
    return c.json(rt.credentials.manifest());
  });
  app.get("/api/peer/credentials/entry", async (c) => {
    if (!peerCaller(mesh, c) || !rt.credentials) return notFound(c);
    const got = await rt.credentials.entry(c.req.query("key") ?? "");
    return got ? c.json(got) : notFound(c);
  });
  app.post("/api/peer/credentials/push", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) }), async (c) => {
    const from = peerCaller(mesh, c);
    if (!from || !rt.credentials) return notFound(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Expected JSON" }, 400);
    }
    return c.json(await rt.credentials.receivePush(from, body));
  });
  app.get("/api/mesh/logins", (c) => {
    if (onPeerListener(c) || !rt.credentials) return notFound(c);
    return c.json({ entries: rt.credentials.status().entries.map(browserLogin) } satisfies MeshLogins);
  });
  app.post("/api/mesh/logins/claim", bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) }), async (c) => {
    const sync = rt.credentials;
    if (onPeerListener(c) || !sync) return notFound(c);
    let key: unknown;
    try {
      key = ((await c.req.json()) as { key?: unknown } | null)?.key;
    } catch {
      return c.json({ error: "Expected JSON" }, 400);
    }
    if (typeof key !== "string" || !parseEntryKey(key) || !sync.status().entries.some((e) => e.key === key)) {
      return c.json({ error: "Unknown login" }, 400);
    }
    if (!loginsOn()) return c.json({ error: "Logins sync is off" }, 409);
    if (!(await sync.claim(key))) return c.json({ error: "No live login here to claim" }, 409);
    return c.json({ ok: true as const });
  });
  app.get("/api/peer/sync/manifest", (c) => {
    if (!peerCaller(mesh, c) || !rt.docs) return notFound(c);
    return c.json(rt.docs.manifest());
  });
  app.get("/api/peer/sync/doc", (c) => {
    if (!peerCaller(mesh, c) || !rt.docs) return notFound(c);
    const got = rt.docs.doc(c.req.query("key") ?? "");
    return got ? c.json(got) : notFound(c);
  });
  app.post("/api/peer/sync/push", bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) }), async (c) => {
    const from = peerCaller(mesh, c);
    if (!from || !rt.docs) return notFound(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Expected JSON" }, 400);
    }
    return c.json(rt.docs.receivePush(from, body));
  });
  app.get("/api/peer/sync/extensions", (c) => {
    if (!peerCaller(mesh, c) || !rt.extensions) return notFound(c);
    return c.json(rt.extensions.published());
  });
  app.post("/api/peer/sync/extensions", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) }), async (c) => {
    const from = peerCaller(mesh, c);
    if (!from || !rt.extensions) return notFound(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Expected JSON" }, 400);
    }
    rt.extensions.receive(from, body);
    return c.json({ ok: true });
  });
  return rt;
}

export function extensionStatus(ext: ExtensionSync | null, enabled: boolean): SyncStatus {
  if (!enabled) return { category: "extensions", enabled, state: "off", lastAt: null };
  if (!ext) return { category: "extensions", enabled, state: "pending", lastAt: null };
  return peerStatusLine("extensions", enabled, ext.peers());
}

/** Settings and themes share one exchange; each category gets its own line. */
export function docStatus(category: "settings" | "themes", docs: DocSync | null, enabled: boolean): SyncStatus {
  if (!enabled) return { category, enabled, state: "off", lastAt: null };
  if (!docs) return { category, enabled, state: "pending", lastAt: null };
  return peerStatusLine(category, enabled, docs.peers());
}

function peerStatusLine(category: SyncCategory, enabled: boolean, peerStates: Record<string, { state: string; at: number }>): SyncStatus {
  const peers = Object.entries(peerStates);
  const ok = peers.filter(([, s]) => s.state === "ok");
  const lastAt = ok.length ? Math.max(...ok.map(([, s]) => s.at)) : null;
  const skewed = peers.filter(([, s]) => s.state === "clock-skew").map(([id]) => id);
  const failed = peers.filter(([, s]) => s.state === "error").map(([id]) => id);
  if (skewed.length) return { category, enabled, state: "error", lastAt, error: `clock differs by over 60s from ${skewed.join(", ")}` };
  if (!ok.length && failed.length) return { category, enabled, state: "error", lastAt, error: `no peer reachable (${failed.join(", ")})` };
  return { category, enabled, state: ok.length ? "ok" : "pending", lastAt };
}

/** A status row as the browser sees it: no fingerprint, no tombstone, no secret. */
export function browserLogin(e: CredentialStatusEntry): MeshLoginEntry {
  return {
    key: e.key,
    store: e.store,
    provider: e.provider,
    ...(e.kind ? { kind: e.kind } : {}),
    state: e.state,
    ...(e.expires !== undefined ? { expires: e.expires } : {}),
    ...(e.loginAt !== undefined ? { loginAt: e.loginAt } : {}),
    ...(e.issuedAt !== undefined ? { issuedAt: e.issuedAt } : {}),
    ...(e.origin ? { origin: e.origin } : {}),
    ...(e.conflictWith?.length ? { conflictWith: e.conflictWith } : {}),
  };
}

/** The Mesh page's one line for logins: never a secret, only how the exchange is going. */
export function loginStatus(sync: CredentialSync | null, enabled: boolean): SyncStatus {
  if (!enabled) return { category: "logins", enabled, state: "off", lastAt: null };
  if (!sync) return { category: "logins", enabled, state: "pending", lastAt: null };
  const status = sync.status();
  const line = peerStatusLine("logins", enabled, status.peers);
  const conflicts = status.entries.filter((e) => e.conflictWith?.length);
  if (!conflicts.length) return line;
  const which = conflicts.map((e) => `${e.key} (${e.conflictWith!.join(", ")})`).join("; ");
  return { ...line, state: "error", error: `different logins from before sync, not synced until one is chosen: ${which}` };
}
