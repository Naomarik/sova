import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { PREVIEW_PURPOSE_MAX, type PreviewHandoff, type PreviewTarget, type PreviewView } from "../shared/preview-links";
import { readBuilds, withWorktreePath } from "./build-loadout";
import { projectOf } from "./project-overseer-store";
import { peerPort } from "./mesh/peers";
import { portOwner, type PortOwner } from "./port-owner";
import { keepPreview, keptPreview, type KeptPreview } from "./preview-kept";
import { checkDays, checkPort, findPreviewByHash, listPreviews, mintPreview, onPreviewEnded, PreviewRefused, revokePreview, type PreviewRecord } from "./preview-links";
import { startStaticServe, staticServes, stopStaticServe } from "./preview-serve";
import { readPublicLinks } from "./public-links";
import { readSessionTitles } from "./session-titles";
import { awaitShareLinks } from "./share/links-events";
import { previewAddress, previewOrigin } from "./share/preview-address";
import { dialLoopback, previewDialable, previewRootId } from "./share/preview-proxy";
import { ingressInfo, linkWarning, shareListenerState } from "./share/share-state";

/**
 * A project's previews (§mesh.public/preview, /preview-serve; §app.project-overseer/previews): what
 * the operator's routes and the overseer's tools share. A preview shows one of the project's coding
 * sessions' apps: a port it already serves, or a folder of its worktree that Sova serves itself.
 * preview-links.json keeps its record (its keys never change); preview-kept.json the rest, its link
 * included. Nothing here ever starts an app.
 *
 * `resolvePreview` checks a request and changes nothing (the overseer's call is checked with it before
 * its statechart act, and again when a hold releases it); `makePreview` mints what it resolved.
 */

/** A coding session of the project with its worktree on this host. */
export interface CodingTree {
  sessionId: string;
  branch: string;
  /** The worktree folder (as recorded; may not exist any more). */
  path: string;
  title: string;
  /** Its session file on this host. */
  sessionPath: string | null;
}

/** Tests: stand-ins for the project's worktrees and the port's listener (the real ones read the statecharts and /proc). */
let testDeps: { trees?: (projectId: string) => Promise<CodingTree[]>; owner?: (port: number) => PortOwner } = {};
export function setPreviewDepsForTest(d: typeof testDeps | null): void {
  testDeps = d ?? {};
}
const ownerOf = (port: number): PortOwner => (testDeps.owner ?? portOwner)(port);
const treesFor = (projectId: string): Promise<CodingTree[]> => (testDeps.trees ?? projectTrees)(projectId);

/** The project's coding sessions with a worktree here, newest first (no git: the statechart's records). */
export async function projectTrees(projectId: string): Promise<CodingTree[]> {
  const root = projectOf(projectId).root;
  const titles = readSessionTitles();
  const out: CodingTree[] = [];
  for (const row of readBuilds(projectId).reverse()) {
    if (row.removed || !row.worktree) continue;
    const w = await withWorktreePath(row, root).catch(() => null);
    if (!w) continue;
    out.push({ sessionId: row.sessionId, branch: w.worktree.branch, path: w.worktree.path, title: titles[row.sessionId] || row.title || "Untitled coding session", sessionPath: row.path ?? null });
  }
  return out;
}

const real = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
/** `child` is `dir` or inside it (both real paths). */
const within = (dir: string, child: string): boolean => {
  const rel = relative(dir, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The tree whose worktree holds `dir` (at real paths), or null. */
export function treeHolding(trees: readonly CodingTree[], dir: string): CodingTree | null {
  const d = real(dir);
  if (!d) return null;
  for (const t of trees) {
    const top = real(t.path);
    if (top && within(top, d)) return t;
  }
  return null;
}

// ---- resolving a request ----------------------------------------------------------------------------

export interface PreviewRequest {
  projectId: string;
  port?: unknown;
  folder?: unknown;
  sessionId?: unknown;
  purpose?: unknown;
  days?: unknown;
  /** `operator`, or `session:<overseer conversation id>`. */
  createdBy: string;
  /** The overseer's: a port must be served from the named (or some) coding session's worktree. */
  requireOwner: boolean;
}

export interface ResolvedPreview {
  projectId: string;
  target: { kind: "port"; port: number } | { kind: "static"; folder: string };
  tree: CodingTree | null;
  purpose: string | null;
  days: number;
  createdBy: string;
}

export const noteOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Check a request against the project's worktrees, the port's listener and every preview rule. Mints nothing. */
export async function resolvePreview(q: PreviewRequest, deps: { owner?: (port: number) => PortOwner; trees?: CodingTree[]; sovaPorts: ReadonlySet<number> }): Promise<ResolvedPreview> {
  const purposeRaw = q.purpose === undefined || q.purpose === null ? null : typeof q.purpose === "string" ? q.purpose.trim() : undefined;
  if (purposeRaw === undefined || (purposeRaw && (purposeRaw.length > PREVIEW_PURPOSE_MAX || /[\r\n]/.test(purposeRaw)))) throw new PreviewRefused("bad-purpose", `The purpose is one line of at most ${PREVIEW_PURPOSE_MAX} characters.`);
  const days = checkDays(q.days);
  const hasPort = q.port !== undefined && q.port !== null && q.port !== "";
  const hasFolder = typeof q.folder === "string" && q.folder.trim() !== "";
  if (hasPort === hasFolder) throw new PreviewRefused("bad-target", "Give either a port the app listens on or a folder to serve, not both.");
  const trees = deps.trees ?? (await treesFor(q.projectId));
  const sid = noteOf(q.sessionId);
  const named = sid ? trees.find((t) => t.sessionId === sid) ?? null : null;
  if (sid && !named) throw new PreviewRefused("bad-session", `No coding session ${sid} of this project has a worktree on this host.`);
  const base = { projectId: q.projectId, purpose: purposeRaw || null, days, createdBy: q.createdBy };

  if (hasFolder) {
    if (!named) throw new PreviewRefused("bad-session", "Name the coding session whose worktree holds the folder.");
    const raw = (q.folder as string).trim();
    const top = real(named.path);
    if (!top) throw new PreviewRefused("bad-target", "Its worktree folder is missing on this host.");
    const asked = isAbsolute(raw) ? raw : resolve(top, raw);
    const folder = real(asked);
    if (!folder || !statSync(folder).isDirectory()) throw new PreviewRefused("bad-target", `No folder ${raw} in its worktree.`);
    if (!within(top, folder)) throw new PreviewRefused("bad-target", `${raw} is outside its worktree.`);
    const rel = relative(top, folder);
    if (rel.split(sep).some((s) => s.startsWith("."))) throw new PreviewRefused("bad-target", "A folder whose name starts with a dot (.git, .sova, …) is never served.");
    return { ...base, target: { kind: "static", folder }, tree: named };
  }

  const port = checkPort(typeof q.port === "string" && /^\d+$/.test(q.port) ? Number(q.port) : q.port, deps.sovaPorts);
  const owner = (deps.owner ?? ownerOf)(port);
  const holder = typeof owner === "object" ? treeHolding(trees, owner.cwd) : null;
  if (q.requireOwner) {
    if (owner === "none") throw new PreviewRefused("not-listening", `Nothing listens on port ${port}. Have its coding session start the app first.`);
    if (owner === "unknown") throw new PreviewRefused("not-in-worktree", `Sova can't tell which program listens on port ${port} on this host, so it can't check that a coding session of this project serves it.`);
    if (!holder) throw new PreviewRefused("not-in-worktree", `Port ${port} isn't served from a worktree of this project's coding sessions.`);
    if (named && holder.sessionId !== named.sessionId) throw new PreviewRefused("not-in-worktree", `Port ${port} is served from another coding session's worktree (${holder.sessionId}).`);
  }
  return { ...base, target: { kind: "port", port }, tree: named ?? holder };
}

// ---- minting ------------------------------------------------------------------------------------------

export interface MadePreview {
  record: PreviewRecord;
  url: string;
  linkWarning?: string;
}

/** Mint what `resolvePreview` checked: a folder is served first (its port becomes the preview's), then the link is kept. */
export async function makePreview(r: ResolvedPreview, sovaPorts: ReadonlySet<number>): Promise<MadePreview> {
  const address = previewAddress();
  if (!address.url) throw new PreviewRefused(address.reason ?? "no-address", address.message ?? "No preview address is set.");
  const staging = r.target.kind === "static" ? `staging-${process.pid}-${Date.now()}` : null;
  let port = r.target.kind === "port" ? r.target.port : 0;
  if (staging && r.target.kind === "static") port = (await startStaticServe({ id: staging, root: r.target.folder })).port;
  try {
    const { result, outcome } = await awaitShareLinks(() =>
      mintPreview({ projectId: r.projectId, port, days: r.days, createdBy: r.createdBy }, staging ? new Set([...sovaPorts].filter((p) => p !== port)) : sovaPorts),
    );
    const url = `${previewOrigin(address.url, result.label)}/`;
    const kept: KeptPreview = {
      url,
      target: r.target.kind === "static" ? { kind: "static", folder: r.target.folder } : { kind: "port" },
      ...(r.tree ? { sessionId: r.tree.sessionId, branch: r.tree.branch } : {}),
      ...(r.purpose ? { purpose: r.purpose } : {}),
    };
    keepPreview(result.record.id, kept);
    if (staging && r.target.kind === "static") {
      // The serve moves to the preview's own id, on the port the record names.
      await stopStaticServe(staging);
      await startStaticServe({ id: result.record.id, root: r.target.folder, port });
    }
    const warning = typeof readPublicLinks().route === "object" ? linkWarning(outcome).linkWarning : undefined;
    return { record: result.record, url, ...(warning ? { linkWarning: warning } : {}) };
  } catch (err) {
    if (staging) await stopStaticServe(staging).catch(() => {});
    throw err;
  }
}

/** Turn one off (never held): 410 from now on, its connections closed, its folder no longer served. */
export async function turnOffPreview(id: string): Promise<PreviewRecord | null> {
  const r = revokePreview(id);
  await stopStaticServe(id).catch(() => false);
  return r;
}

// ---- folder serves: which ports, the proxy's guard, startup and expiry ----------------------------------

/** The ports Sova serves folders on: never a port preview's. */
export const staticPorts = (): number[] => staticServes().map((s) => s.port);

/** Every port this Sova process binds or its settings name: never a preview's. */
export function sovaPorts(env: NodeJS.ProcessEnv = process.env): Set<number> {
  const out = new Set<number>();
  const add = (v: unknown) => {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) out.add(n);
  };
  add(env.PORT ?? 4800);
  add(env.SOVA_PORT);
  add(peerPort());
  add(env.SOVA_SHARE_PORT);
  add(shareListenerState()?.port);
  const file = readPublicLinks();
  add(file.gateway?.sharePort);
  add(file.ingressPort);
  add(ingressInfo()?.port);
  for (const p of staticPorts()) add(p);
  return out;
}

/** Bind every active folder preview again on its recorded port (index.ts, at startup). A taken port serves nothing. */
export async function rebindStaticPreviews(now = Date.now()): Promise<{ bound: string[]; failed: string[] }> {
  const bound: string[] = [];
  const failed: string[] = [];
  for (const v of listPreviews({}, now)) {
    if (v.state !== "active") continue;
    const kept = keptPreview(v.id);
    if (kept?.target.kind !== "static") continue;
    try {
      await startStaticServe({ id: v.id, root: kept.target.folder, port: v.port });
      bound.push(v.id);
    } catch (err) {
      failed.push(v.id);
      console.warn(`[preview] ${v.id}: its folder can't be served on port ${v.port} (${err instanceof Error ? err.message : "bind failed"})`);
    }
  }
  return { bound, failed };
}

/**
 * Stop serving folders of previews that are no longer active (expired, turned off elsewhere, gone).
 * Only a preview's own serve (`pv_…`): a copy's static service (served under its unit name) and a
 * preview being staged are never its to stop.
 */
export async function sweepStaticPreviews(now = Date.now()): Promise<void> {
  for (const s of staticServes()) {
    if (!s.id.startsWith("pv_")) continue;
    const v = listPreviews({}, now).find((x) => x.id === s.id);
    if (!v || v.state !== "active") await stopStaticServe(s.id).catch(() => false);
  }
}

let started = false;
/** Rebind at startup, sweep each minute, and stop a folder's serve the moment its preview ends. */
export function startStaticPreviews(): void {
  if (started) return;
  started = true;
  void rebindStaticPreviews().catch(() => {});
  const t = setInterval(() => void sweepStaticPreviews().catch(() => {}), 60_000);
  t.unref();
  onPreviewEnded((hash) => {
    const r = findPreviewByHash(hash);
    if (r) void stopStaticServe(r.id).catch(() => false);
  });
}

// ---- reading them -----------------------------------------------------------------------------------------

async function isRunning(record: PreviewRecord, kept: KeptPreview | null): Promise<boolean> {
  if (kept?.target.kind === "static") return previewDialable(record);
  const s = await dialLoopback(record.port);
  if (s === "refused") return false;
  s.destroy();
  return true;
}

/** A folder as the card and the tools show it: relative to its worktree ("." for the worktree), else its last part. */
function shownFolder(folder: string, tree: CodingTree | null): string {
  const top = tree ? real(tree.path) ?? tree.path : null;
  if (top && within(top, folder)) return relative(top, folder) || ".";
  return folder.split(sep).filter(Boolean).pop() ?? folder;
}

/** The project's previews (every project's without a filter), with the kept facts, the running check and the worktree match. */
export async function previewViews(filter: { projectId?: string } = {}, deps: { owner?: (port: number) => PortOwner; trees?: (projectId: string) => Promise<CodingTree[]> } = {}): Promise<PreviewView[]> {
  const treesOf = new Map<string, Promise<CodingTree[]>>();
  const trees = (p: string) => {
    if (!treesOf.has(p)) treesOf.set(p, (deps.trees ?? treesFor)(p).catch(() => []));
    return treesOf.get(p)!;
  };
  const now = Date.now();
  const out: PreviewView[] = [];
  for (const base of listPreviews(filter, now)) {
    const record = { ...base, hash: "" } as PreviewRecord;
    // A person's sibling (§app.outreach/links) shows its original's app: its target, session and purpose, never its link.
    const own = keptPreview(base.id);
    const kept = own ?? (base.siblingOf ? keptPreview(previewRootId(base)) : null);
    const all = await trees(base.projectId);
    let tree = kept?.sessionId ? all.find((t) => t.sessionId === kept.sessionId) ?? null : null;
    let from: "recorded" | "worktree" | undefined = kept?.sessionId ? "recorded" : undefined;
    // An older preview (or the operator's by port): matched now by its listener's worktree, never written.
    if (!kept?.sessionId && kept?.target.kind !== "static" && base.state === "active") {
      const owner = (deps.owner ?? ownerOf)(base.port);
      const holder = typeof owner === "object" ? treeHolding(all, owner.cwd) : null;
      if (holder) {
        tree = holder;
        from = "worktree";
      }
    }
    const target: PreviewTarget = kept?.target.kind === "static" ? { kind: "static", folder: shownFolder(kept.target.folder, tree) } : { kind: "port", port: base.port };
    out.push({
      ...base,
      ...(base.state === "active" ? { running: await isRunning(record, kept) } : {}),
      target,
      url: own?.url ?? null,
      purpose: kept?.purpose ?? null,
      sessionId: kept?.sessionId ?? tree?.sessionId ?? null,
      branch: kept?.branch ?? tree?.branch ?? null,
      ...(from ? { sessionFrom: from } : {}),
      sessionTitle: tree?.title ?? null,
      sessionPath: tree?.sessionPath ?? null,
    });
  }
  return out;
}

/** The one shape a preview leaves the tools in (shared/preview-links.ts PreviewHandoff): never its link. Pure. */
export function handoffOf(v: PreviewView): PreviewHandoff {
  return {
    v: 1,
    id: v.id,
    linkKept: !!v.url,
    purpose: v.purpose ?? null,
    expiresAt: v.expiresAt,
    projectId: v.projectId,
    sessionId: v.sessionId ?? null,
    branch: v.branch ?? null,
    target: v.target ?? { kind: "port", port: v.port },
    state: v.state,
    running: v.state === "active" ? v.running ?? false : null,
    createdBy: v.createdBy,
  };
}

