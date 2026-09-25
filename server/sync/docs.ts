import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SyncCategory } from "../../shared/protocol";
import { parseTheme } from "../../shared/theme";
import { parseDelegate } from "../../pi-config/extensions/mode/delegate.ts";
import { parseSpec } from "../../pi-config/extensions/mode/spec.ts";
import { clockSkewed } from "./logins-merge";
import { writeFileAtomic } from "./logins-stores";

/**
 * Settings and themes sync: whole documents (files), newest edit wins. Unlike logins there is no
 * lineage to protect, so a document is one value with one stamp: `modifiedAt`, the wall time a
 * host first saw its content (sha256), and the host that saw it. Ties fall to origin, then hash.
 * A deleted document is a stamped absence, so deleting a theme on one host deletes it everywhere.
 *
 * Every received document is checked with its consumer's own parser before it is written, and is
 * written the way the consumer writes it (tmp + rename; the palette's lock for favorites), with a
 * last re-read right before the rename so a local edit made meanwhile is never silently replaced.
 * A local file the consumer itself can't read, or a symlink (a pi-config link under git), is this
 * host's business: never offered, never overwritten.
 *
 * Which state is synced (the rest is per host by design):
 * - settings: Sova's settings.json (the claude-code provider switch) and defaults.json (new-session
 *   model and thinking); pi's model-favorites.json and model-policy.json; the mode extension's
 *   mode.json (default mode), mode-delegate.json and mode-spec.json.
 * - themes: every `<state root>/themes/*.json` (the theme CHOICE is the browser's, per origin).
 * Not synced: topic-outline.json (it holds this host's claudeBin path), anything keyed by session
 * (titles, groups, drafts, origin: the session's owner keeps them), extensions.json.
 */

export type DocCategory = Extract<SyncCategory, "settings" | "themes">;

export interface DocMeta {
  /** sha256 hex of the file's bytes; null = the document is absent. */
  hash: string | null;
  modifiedAt: number;
  origin: string;
}

export interface DocSpec {
  key: string;
  category: DocCategory;
  path: string;
  /** The consumer's own reader accepts these bytes. */
  valid(text: string): boolean;
  /** The consumer's mkdir lock around read-modify-rename, where it has one. */
  lockDir?: string;
}

export interface DocManifest {
  hostId: string;
  now: number;
  docs: Record<string, DocMeta>;
}
export interface DocReply {
  meta: DocMeta;
  content: string | null;
}
export interface DocPush {
  hostId: string;
  now: number;
  docs: Record<string, DocReply>;
}
export interface DocPushReply {
  accepted: string[];
  rejected: { key: string; reason: "older" | "invalid" | "local-only" | "unknown" | "disabled" | "clock-skew" | "changed" }[];
}

export interface DocPeer {
  readonly id: string;
  manifest(): Promise<DocManifest>;
  doc(key: string): Promise<DocReply>;
  push(body: DocPush): Promise<DocPushReply>;
}

/** Newer edit wins; > 0 when `a` does. */
export function compareDocs(a: DocMeta, b: DocMeta): number {
  const c = (x: number | string, y: number | string) => (x < y ? -1 : x > y ? 1 : 0);
  return c(a.modifiedAt, b.modifiedAt) || c(a.origin, b.origin) || c(a.hash ?? "", b.hash ?? "");
}

export function isDocMeta(v: unknown): v is DocMeta {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as Partial<DocMeta>;
  return (
    (m.hash === null || (typeof m.hash === "string" && /^[0-9a-f]{64}$/.test(m.hash))) &&
    typeof m.modifiedAt === "number" &&
    Number.isFinite(m.modifiedAt) &&
    typeof m.origin === "string" &&
    m.origin.length > 0
  );
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const jsonObject = (text: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const THEME_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;
const MAX_DOC_BYTES = 256 * 1024;

/** The fixed settings documents, by agent dir and Sova state dir. */
export function settingsDocs(agentDir: string, stateDir: string): DocSpec[] {
  const favorites = join(agentDir, "model-favorites.json");
  return [
    { key: "settings:sova/settings.json", category: "settings", path: join(stateDir, "settings.json"), valid: (t) => jsonObject(t)?.version === 1 },
    { key: "settings:sova/defaults.json", category: "settings", path: join(stateDir, "defaults.json"), valid: (t) => jsonObject(t) !== null },
    {
      key: "settings:model-favorites.json",
      category: "settings",
      path: favorites,
      lockDir: `${favorites}.lock`,
      valid: (t) => validFavorites(t),
    },
    { key: "settings:model-policy.json", category: "settings", path: join(agentDir, "model-policy.json"), valid: (t) => validPolicy(t) },
    { key: "settings:mode.json", category: "settings", path: join(agentDir, "mode.json"), valid: (t) => jsonObject(t) !== null },
    {
      key: "settings:mode-delegate.json",
      category: "settings",
      path: join(agentDir, "mode-delegate.json"),
      valid: (t) => {
        const o = jsonObject(t);
        return o !== null && !("error" in parseDelegate(o));
      },
    },
    {
      key: "settings:mode-spec.json",
      category: "settings",
      path: join(agentDir, "mode-spec.json"),
      valid: (t) => {
        const o = jsonObject(t);
        return o !== null && !("error" in parseSpec(o));
      },
    },
  ];
}

export function themeDoc(themesDir: string, file: string): DocSpec | null {
  if (!THEME_FILE_RE.test(file)) return null;
  return { key: `themes:${file}`, category: "themes", path: join(themesDir, file), valid: (t) => !parseTheme(t).error };
}

/**
 * The command palette's `ModelFavorites.read()` shape, exactly: it refuses anything else, and a
 * file it refuses must not be overwritten. It reads only from a path, so the rule is restated
 * here and pinned to the real reader by a differential test (docs.test.ts).
 */
export function validFavorites(text: string): boolean {
  const o = jsonObject(text);
  if (!o || o.version !== 1 || !Array.isArray(o.models) || Object.keys(o).length !== 2) return false;
  return o.models.every(
    (m: unknown) =>
      !!m &&
      typeof m === "object" &&
      Object.keys(m).length === 2 &&
      typeof (m as { provider?: unknown }).provider === "string" &&
      (m as { provider: string }).provider.length > 0 &&
      typeof (m as { id?: unknown }).id === "string" &&
      (m as { id: string }).id.length > 0,
  );
}

function validPolicy(text: string): boolean {
  const o = jsonObject(text);
  if (!o || o.version !== 1) return false;
  const lists = ["disabledProviders", "disabledModels", "subagentDisabledProviders", "subagentDisabledModels"];
  return lists.every((k) => o[k] === undefined || (Array.isArray(o[k]) && (o[k] as unknown[]).every((e) => typeof e === "string")));
}

type Local = { kind: "file"; text: string } | { kind: "absent" } | { kind: "local-only"; why: string };

function readLocal(spec: DocSpec): Local {
  let st;
  try {
    st = lstatSync(spec.path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "local-only", why: (e as NodeJS.ErrnoException).code ?? "unreadable" };
  }
  if (st.isSymbolicLink()) return { kind: "local-only", why: "symlink" };
  if (!st.isFile()) return { kind: "local-only", why: "not a file" };
  if (st.size > MAX_DOC_BYTES) return { kind: "local-only", why: "too large" };
  let text: string;
  try {
    text = readFileSync(spec.path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "local-only", why: "unreadable" };
  }
  return spec.valid(text) ? { kind: "file", text } : { kind: "local-only", why: "its reader rejects it" };
}

const hashOf = (l: Local): string | null | undefined => (l.kind === "file" ? sha(l.text) : l.kind === "absent" ? null : undefined);

export interface DocSyncOptions {
  hostId: string;
  agentDir: string;
  /** Sova's state root (`<agent dir>/sova`). */
  stateDir: string;
  sidecarPath: string;
  peers?: () => readonly DocPeer[];
  categoryEnabled?: (c: DocCategory) => boolean;
  now?: () => number;
  log?: (m: string) => void;
  debounceMs?: number;
}

const SIDECAR_VERSION = 1;

export class DocSync {
  private records: Record<string, DocMeta> = {};
  private readonly peerState = new Map<string, { state: "ok" | "clock-skew" | "error"; at: number; error?: string }>();
  private watchers: FSWatcher[] = [];
  private themesWatcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | undefined;
  private syncTimer: NodeJS.Timeout | undefined;
  private started = false;
  private firstRun = false;
  private loaded = false;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: DocSyncOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[doc-sync] ${m}`));
  }

  private get themesDir(): string {
    return join(this.opts.stateDir, "themes");
  }

  private enabled(c: DocCategory): boolean {
    return this.opts.categoryEnabled?.(c) ?? true;
  }

  /** Every document this host knows of: the fixed settings, themes on disk, themes it has records for. */
  specs(): DocSpec[] {
    const out = settingsDocs(this.opts.agentDir, this.opts.stateDir);
    const files = new Set<string>();
    try {
      for (const f of readdirSync(this.themesDir)) if (f.endsWith(".json")) files.add(f);
    } catch {
      // no themes folder: none on disk
    }
    for (const key of Object.keys(this.records)) if (key.startsWith("themes:")) files.add(key.slice("themes:".length));
    for (const f of [...files].sort()) {
      const spec = themeDoc(this.themesDir, f);
      if (spec) out.push(spec);
    }
    return out;
  }

  specFor(key: string): DocSpec | null {
    if (key.startsWith("themes:")) return themeDoc(this.themesDir, key.slice("themes:".length));
    return settingsDocs(this.opts.agentDir, this.opts.stateDir).find((s) => s.key === key) ?? null;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.loadSidecar();
    this.observe(true);
    // Only our documents' names wake a scan (the agent dir also holds auth.json, sessions/, …).
    const names = new Set(settingsDocs(this.opts.agentDir, this.opts.stateDir).map((s) => basename(s.path)));
    names.add("themes");
    for (const dir of [this.opts.agentDir, this.opts.stateDir]) {
      const w = this.watchDir(dir, (f) => names.has(f));
      if (w) this.watchers.push(w);
    }
    this.watchThemes();
  }

  private watchDir(dir: string, match: (f: string) => boolean): FSWatcher | null {
    try {
      const w = watch(dir, { persistent: false }, (_e, f) => {
        if (f === null || match(f)) this.scheduleObserve();
      });
      w.on("error", () => {});
      return w;
    } catch {
      return null; // not there (yet)
    }
  }

  /**
   * The themes folder may not exist at start. A watch on its parent sees it appear (that event
   * scans, and the scan calls this), but not files later removed inside it, so the folder gets
   * its own watch the moment it exists; a deleted theme must not wait for the next reconcile.
   */
  private watchThemes(): void {
    if (!this.started || this.themesWatcher) return;
    this.themesWatcher = this.watchDir(this.themesDir, (f) => f.endsWith(".json"));
    this.themesWatcher?.on("close", () => (this.themesWatcher = null));
  }

  stop(): void {
    this.started = false;
    this.themesWatcher?.close();
    this.themesWatcher = null;
    for (const w of this.watchers.splice(0)) w.close();
    clearTimeout(this.debounce);
    this.debounce = undefined;
    clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
  }

  private scheduleObserve(): void {
    if (!this.started) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.observe(); // a change it finds schedules the push
    }, this.opts.debounceMs ?? 500);
    this.debounce.unref?.();
  }

  /**
   * Coalesce "a local change was recorded: tell every peer". Whatever path records it — our own
   * watcher's scan, or a peer's request (`doc`, `apply`) that folded an unseen local edit in first
   * — must push it: a record that is already up to date makes every later scan report no change.
   */
  private scheduleSync(): void {
    if (!this.started || this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.syncAll().catch((e) => this.log(`sync: ${(e as Error).message}`));
    }, this.opts.debounceMs ?? 500);
    this.syncTimer.unref?.();
  }

  private loadSidecar(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.firstRun = true;
    try {
      const raw = JSON.parse(readFileSync(this.opts.sidecarPath, "utf8")) as { version?: unknown; docs?: Record<string, unknown> };
      this.firstRun = false;
      if (raw.version !== SIDECAR_VERSION || !raw.docs) return;
      for (const [k, v] of Object.entries(raw.docs)) if (isDocMeta(v)) this.records[k] = v;
    } catch {
      // first run
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(this.opts.sidecarPath, `${JSON.stringify({ version: SIDECAR_VERSION, docs: this.records }, null, 2)}\n`);
    } catch (e) {
      this.log(`sidecar write failed: ${(e as Error).message}`);
    }
  }

  /**
   * Fold every document's current content into the records; returns the keys that changed here.
   * On the first run ever, an existing file is stamped with its mtime (when it was last edited)
   * and a missing one with 0, so a fresh host never outvotes a real edit elsewhere.
   */
  observe(initial = false): string[] {
    this.watchThemes();
    const changed: string[] = [];
    for (const spec of this.specs()) {
      if (this.observeOne(spec, initial && this.firstRun)) changed.push(spec.key);
    }
    if (changed.length) this.persist();
    return changed;
  }

  private observeOne(spec: DocSpec, firstScan = false): boolean {
    const local = readLocal(spec);
    const hash = hashOf(local);
    if (hash === undefined) return false; // local-only: not ours to report
    const rec = this.records[spec.key];
    if (rec && rec.hash === hash) return false;
    if (!rec && hash === null && !firstScan) return false; // never existed anywhere we know of
    let modifiedAt = this.now();
    if (firstScan && !rec) {
      try {
        modifiedAt = hash === null ? 0 : Math.min(lstatSync(spec.path).mtimeMs, this.now());
      } catch {
        modifiedAt = 0;
      }
      if (hash === null) return false;
    }
    this.records[spec.key] = { hash, modifiedAt, origin: this.opts.hostId };
    this.scheduleSync();
    return true;
  }

  // ---------------------------------------------------------------- peer-facing

  manifest(): DocManifest {
    const docs: Record<string, DocMeta> = {};
    for (const [key, meta] of Object.entries(this.records)) {
      const spec = this.specFor(key);
      if (spec && this.enabled(spec.category) && readLocal(spec).kind !== "local-only") docs[key] = meta;
    }
    return { hostId: this.opts.hostId, now: this.now(), docs };
  }

  doc(key: string): DocReply | null {
    const spec = this.specFor(key);
    if (!spec || !this.enabled(spec.category)) return null;
    if (this.observeOne(spec)) this.persist();
    const meta = this.records[key];
    const local = readLocal(spec);
    if (!meta || local.kind === "local-only") return null;
    return { meta, content: local.kind === "file" ? local.text : null };
  }

  /** Apply one peer document if it is newer than ours; the reason when it isn't taken. */
  apply(key: string, remote: DocReply): DocPushReply["rejected"][number]["reason"] | null {
    const spec = this.specFor(key);
    if (!spec) return "unknown";
    if (!this.enabled(spec.category)) return "disabled";
    if (!isDocMeta(remote.meta)) return "invalid";
    if (readLocal(spec).kind === "local-only") return "local-only";
    if (this.observeOne(spec)) this.persist();
    const local = this.records[key];
    if (local && compareDocs(remote.meta, local) <= 0) return "older";
    if (remote.meta.hash !== null) {
      if (typeof remote.content !== "string" || remote.content.length > MAX_DOC_BYTES) return "invalid";
      if (sha(remote.content) !== remote.meta.hash || !spec.valid(remote.content)) return "invalid";
    }
    const expect = local?.hash ?? null;
    const ok = this.install(spec, remote.meta.hash === null ? null : (remote.content as string), expect);
    if (!ok) return "changed";
    this.records[key] = remote.meta;
    this.persist();
    return null;
  }

  /**
   * Replace (or remove) the file, the consumer's way, unless its content moved away from `expect`
   * since we last looked (a local edit racing us wins; the watcher then offers it to the peers).
   */
  private install(spec: DocSpec, content: string | null, expect: string | null): boolean {
    let locked = false;
    if (spec.lockDir) {
      try {
        mkdirSync(dirname(spec.lockDir), { recursive: true });
        mkdirSync(spec.lockDir);
        locked = true;
      } catch {
        return false; // the palette is saving: next round
      }
    }
    try {
      if (hashOf(readLocal(spec)) !== expect) return false;
      if (content === null) {
        try {
          unlinkSync(spec.path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        return true;
      }
      mkdirSync(dirname(spec.path), { recursive: true });
      writeFileAtomic(spec.path, content);
      return true;
    } finally {
      if (locked) rmdirSync(spec.lockDir!);
    }
  }

  receivePush(from: string, body: unknown): DocPushReply {
    const reply: DocPushReply = { accepted: [], rejected: [] };
    const b = body as Partial<DocPush> | null;
    if (!b || typeof b !== "object" || typeof b.now !== "number" || !b.docs || typeof b.docs !== "object") return reply;
    const skewed = clockSkewed(b.now, this.now());
    if (skewed) this.peerState.set(from, { state: "clock-skew", at: this.now() });
    for (const [key, item] of Object.entries(b.docs as Record<string, unknown>)) {
      if (skewed) {
        reply.rejected.push({ key, reason: "clock-skew" });
        continue;
      }
      const it = item as Partial<DocReply> | null;
      const reason = it && typeof it === "object" ? this.apply(key, { meta: it.meta as DocMeta, content: (it.content ?? null) as string | null }) : "invalid";
      if (reason) reply.rejected.push({ key, reason });
      else reply.accepted.push(key);
    }
    return reply;
  }

  async syncWith(peer: DocPeer): Promise<void> {
    try {
      const remote = await peer.manifest();
      const now = this.now();
      if (clockSkewed(remote.now, now)) {
        this.peerState.set(peer.id, { state: "clock-skew", at: now });
        return;
      }
      this.observe();
      const mine = this.manifest().docs;
      const theirs: Record<string, DocMeta> = {};
      for (const [k, v] of Object.entries(remote.docs ?? {})) if (this.specFor(k) && isDocMeta(v)) theirs[k] = v;
      const push: DocPush = { hostId: this.opts.hostId, now: this.now(), docs: {} };
      for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
        const l = mine[key];
        const r = theirs[key];
        if (r && (!l || compareDocs(r, l) > 0)) {
          const got = await peer.doc(key).catch(() => null);
          if (got) this.apply(key, got);
        } else if (l && (!r || compareDocs(l, r) > 0)) {
          const got = this.doc(key);
          if (got) push.docs[key] = got;
        }
      }
      if (Object.keys(push.docs).length) {
        const reply = await peer.push(push);
        for (const r of reply.rejected ?? []) if (r.reason !== "older") this.log(`${peer.id} rejected ${r.key}: ${r.reason}`);
      }
      this.peerState.set(peer.id, { state: "ok", at: this.now() });
    } catch (e) {
      this.peerState.set(peer.id, { state: "error", at: this.now(), error: (e as Error).message });
    }
  }

  async syncAll(): Promise<void> {
    await Promise.all((this.opts.peers?.() ?? []).map((p) => this.syncWith(p)));
  }

  peers(): Record<string, { state: "ok" | "clock-skew" | "error"; at: number; error?: string }> {
    return Object.fromEntries(this.peerState);
  }

  recordsSnapshot(): Record<string, DocMeta> {
    return structuredClone(this.records);
  }
}
