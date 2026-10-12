import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MeshCap } from "../../shared/mesh-access";
import type { SyncCategory } from "../../shared/protocol";
import { parseTheme } from "../../shared/theme";
import { parseDelegate } from "../../pi-config/extensions/mode/delegate.ts";
import { parseSpec } from "../../pi-config/extensions/mode/spec.ts";
import { ALIGN_SETTINGS_FILE, parseAlignSettingsText } from "../../pi-config/extensions/mode/align-settings.ts";
import { parseProviderLimits } from "../../pi-config/extensions/provider-limits/gate.ts";
import { parseSubagentProfiles, SEEDED_MTIME_MS, type SubagentProfile } from "../../pi-config/extensions/subagents/subagent-profiles.ts";
import { parseProfilesFile } from "../profiles-store";
import { clockSkewed } from "./logins-merge";
import { writeFileAtomic } from "./logins-stores";
import { keepCopy, LIBRARY_KEY } from "./kept";
import { isItems, itemsAhead, libraryText, mergeLibraries, observeItems, remoteItems, type Items, type ProfileChanges } from "./profile-merge";

/**
 * Settings and themes sync: whole documents (files), newest edit wins. Unlike logins there is no
 * lineage to protect, so a document is one value with one stamp: `modifiedAt`, the wall time a
 * host first saw its content (sha256), and the host that saw it. Ties fall to origin, then hash.
 * A deleted document is a stamped absence, so deleting a theme on one host deletes it everywhere.
 * A file that first appears on a host (at its first run or later) is dated by its own mtime, never
 * by the moment it was noticed, so a fresh copy or seed never outvotes an older edit elsewhere.
 *
 * One exception: the subagent profile library merges profile by profile (`merge: "profiles"`,
 * ./profile-merge.ts, §mesh.sync/profile-library). Its record also carries `items`, one stamp per
 * profile id (deletions included), which travel in the manifest; the file keeps the shape every
 * reader parses. An older peer ignores `items` and sends the whole file, which is merged by union.
 *
 * Before sync replaces a settings document with another host's version, the version it had is kept
 * (./kept.ts, §mesh.sync/kept-copies).
 *
 * Every received document is checked with its consumer's own parser before it is written, and is
 * written the way the consumer writes it (tmp + rename; the palette's lock for favorites), with a
 * last re-read right before the rename so a local edit made meanwhile is never silently replaced.
 * A local file the consumer itself can't read, or a symlink (a pi-config link under git), is this
 * host's business: never offered, never overwritten.
 *
 * Which state is synced (the rest is per host by design):
 * - settings: Sova's settings.json (Settings → Alignment's review switch, Experimental's switches) and defaults.json (new-session
 *   model and thinking); pi's model-favorites.json and model-policy.json; the mode extension's
 *   mode.json (default mode), mode-delegate.json, mode-spec.json and mode-align.json; the subagent profile library
 *   subagent-profiles.json (its device default, subagent-profiles-default.json, never syncs:
 *   which profile new chats start from is each device's own); your session profiles, Sova's
 *   session-profiles.json (checked with its own strict parser; only with peers also granted
 *   sessions, since a profile's first message runs here as a session's opening prompt).
 * - themes: every `<state root>/themes/*.json` (the theme CHOICE is the browser's, per origin).
 * Not synced: subagent-profiles-default.json, topic-outline.json (it holds this host's claudeBin
 * path), anything keyed by session (titles, groups, drafts, origin: the session's owner keeps
 * them), extensions.json.
 */

export type DocCategory = Extract<SyncCategory, "settings" | "themes">;

export interface DocMeta {
  /** sha256 hex of the file's bytes; null = the document is absent. */
  hash: string | null;
  modifiedAt: number;
  origin: string;
  /** A merged document's per-item stamps (the profile library's, by profile id). An older build ignores it. */
  items?: Items;
}

export interface DocSpec {
  key: string;
  category: DocCategory;
  path: string;
  /** The consumer's own reader accepts these bytes. */
  valid(text: string): boolean;
  /** The consumer's mkdir lock around read-modify-rename, where it has one. */
  lockDir?: string;
  /** Capabilities a peer needs on top of the category's own (§mesh.peers/grants). */
  needs?: readonly MeshCap[];
  /** Merged item by item instead of replaced whole (the subagent profile library). */
  merge?: "profiles";
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
const validSessionProfiles = (text: string): boolean => {
  const o = jsonObject(text);
  if (o === null) return false;
  try {
    parseProfilesFile(o);
    return true;
  } catch {
    return false;
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
    // Your session profiles ("Yours"), whole: what your profile cards are on every device.
    // A profile's first message runs as a session's opening prompt here: only for peers granted sessions.
    {
      key: "settings:sova/session-profiles.json",
      category: "settings",
      path: join(stateDir, "session-profiles.json"),
      valid: (t) => validSessionProfiles(t),
      needs: ["sessions"],
    },
    {
      key: "settings:model-favorites.json",
      category: "settings",
      path: favorites,
      lockDir: `${favorites}.lock`,
      valid: (t) => validFavorites(t),
    },
    { key: "settings:model-policy.json", category: "settings", path: join(agentDir, "model-policy.json"), valid: (t) => validPolicy(t) },
    // The same numbers on every device; each device counts its own requests (§app.provider-limits/per-device).
    {
      key: "settings:provider-limits.json",
      category: "settings",
      path: join(agentDir, "provider-limits.json"),
      valid: (t) => {
        const o = jsonObject(t);
        return o !== null && parseProviderLimits(o).ok;
      },
    },
    { key: "settings:mode.json", category: "settings", path: join(agentDir, "mode.json"), valid: (t) => jsonObject(t) !== null },
    // Merged profile by profile (§mesh.sync/profile-library), never replaced whole.
    { key: LIBRARY_KEY, category: "settings", path: join(agentDir, "subagent-profiles.json"), valid: (t) => parseSubagentProfiles(t).ok, merge: "profiles" },
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
    // The align mode's writing style and Visuals (§chat.alignment/settings-file), checked with its own strict parse.
    { key: `settings:${ALIGN_SETTINGS_FILE}`, category: "settings", path: join(agentDir, ALIGN_SETTINGS_FILE), valid: (t) => parseAlignSettingsText(t).ok },
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

/** The library's profiles in `text` (already checked by its spec), or null. */
const profilesOf = (text: string): SubagentProfile[] | null => {
  const p = parseSubagentProfiles(text);
  return p.ok ? p.value.profiles : null;
};

/** A file's mtime, or null. */
const mtimeOf = (path: string): number | null => {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return null;
  }
};

export interface DocSyncOptions {
  hostId: string;
  agentDir: string;
  /** Sova's state root (`<agent dir>/sova`). */
  stateDir: string;
  sidecarPath: string;
  peers?: () => readonly DocPeer[];
  /** A host's name as this host knows it (a peer's label), for kept copies. */
  deviceName?: (hostId: string) => string | undefined;
  categoryEnabled?: (c: DocCategory) => boolean;
  /** Whether category `c` is exchanged with peer `peerId` at all (this host's grant to that peer,
      §mesh.peers/grants). Absent: every category with every peer. */
  shares?: (peerId: string, c: DocCategory) => boolean;
  /** Whether this host grants `peerId` capability `cap`, for a document's `needs`. Absent: every one. */
  allows?: (peerId: string, cap: MeshCap) => boolean;
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
    this.observe();
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
    try {
      const raw = JSON.parse(readFileSync(this.opts.sidecarPath, "utf8")) as { version?: unknown; docs?: Record<string, unknown> };
      if (raw.version !== SIDECAR_VERSION || !raw.docs) return;
      for (const [k, v] of Object.entries(raw.docs)) {
        if (!isDocMeta(v)) continue;
        // Stamps that don't parse are dropped; the next look rebuilds them from the file.
        const { items, ...whole } = v;
        this.records[k] = items !== undefined && isItems(items) ? { ...whole, items } : whole;
      }
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
   * A file seen for the first time — at the first run ever, or later — is stamped with its mtime
   * (when it was last edited), and a missing one is not recorded, so a fresh host never outvotes
   * a real edit elsewhere.
   */
  observe(): string[] {
    this.watchThemes();
    const changed: string[] = [];
    for (const spec of this.specs()) {
      if (this.observeOne(spec)) changed.push(spec.key);
    }
    if (changed.length) this.persist();
    return changed;
  }

  private observeOne(spec: DocSpec): boolean {
    const local = readLocal(spec);
    const hash = hashOf(local);
    if (hash === undefined) return false; // local-only: not ours to report
    const rec = this.records[spec.key];
    if (spec.merge) return this.observeMerged(spec, local, hash, rec);
    if (rec && rec.hash === hash) return false;
    if (!rec && hash === null) return false; // never existed anywhere we know of
    const modifiedAt = hash !== null && (!rec || rec.hash === null) ? this.appearedAt(spec, rec) : this.now();
    this.records[spec.key] = { hash, modifiedAt, origin: this.opts.hostId };
    this.scheduleSync();
    return true;
  }

  /**
   * The date of a file that first appears here: its own mtime (never later than now), and after a
   * deletion this host recorded, just after that deletion (the file came back, and wins over it).
   */
  private appearedAt(spec: DocSpec, rec: DocMeta | undefined): number {
    const age = Math.min(mtimeOf(spec.path) ?? 0, this.now());
    return rec ? Math.max(age, rec.modifiedAt + 1) : age;
  }

  /**
   * The profile library: fold the file into its record and per-profile stamps. An edit of a library
   * that existed stamps what changed now and records a deletion for each profile that left; a file
   * that first appears (or a fresh seed, dated at the epoch) is dated by its age and deletes nothing;
   * a file that vanished deletes nothing either (it is just not offered while absent).
   */
  private observeMerged(spec: DocSpec, local: Local, hash: string | null, rec: DocMeta | undefined): boolean {
    const self = this.opts.hostId;
    if (hash === null) {
      if (!rec || rec.hash === null) return false;
      const items = observeItems(rec.items, null, { modifiedAt: this.now(), origin: self }, false);
      this.records[spec.key] = { hash: null, modifiedAt: 0, origin: self, items };
      return true;
    }
    const profiles = local.kind === "file" ? profilesOf(local.text) : null;
    if (!profiles) return false;
    if (rec && rec.hash === hash) {
      if (rec.items) return false;
      // A record from before per-profile stamps: each profile takes the whole file's date.
      this.records[spec.key] = { ...rec, items: observeItems(undefined, profiles, rec, false) };
      return true;
    }
    const appeared = !rec || rec.hash === null;
    const seed = mtimeOf(spec.path) === SEEDED_MTIME_MS;
    // A library that vanished recorded no deletion to come after, so one that (re)appears is dated
    // by its age alone; a seed is always 0.
    const modifiedAt = seed ? 0 : appeared ? this.appearedAt(spec, undefined) : this.now();
    const items = observeItems(rec?.items, profiles, { modifiedAt, origin: self }, !appeared && !seed);
    this.records[spec.key] = { hash, modifiedAt, origin: self, items };
    this.scheduleSync();
    return true;
  }

  // ---------------------------------------------------------------- peer-facing

  /** Whether `spec` is exchanged with `peerId` (this host's grant to it: its category and every
      capability it needs); every one with no peer named. */
  private sharesWith(peerId: string | undefined, spec: DocSpec): boolean {
    if (peerId === undefined) return true;
    if (this.opts.shares && !this.opts.shares(peerId, spec.category)) return false;
    const allows = this.opts.allows;
    return !allows || (spec.needs ?? []).every((cap) => allows(peerId, cap));
  }

  /** The manifest as `forPeer` may see it: only the documents this host shares with that peer. */
  manifest(forPeer?: string): DocManifest {
    const docs: Record<string, DocMeta> = {};
    for (const [key, meta] of Object.entries(this.records)) {
      const spec = this.specFor(key);
      if (!spec || !this.enabled(spec.category) || !this.sharesWith(forPeer, spec)) continue;
      // An absent library is not offered: an older peer would take it as a deletion.
      if (spec.merge && meta.hash === null) continue;
      if (readLocal(spec).kind !== "local-only") docs[key] = meta;
    }
    return { hostId: this.opts.hostId, now: this.now(), docs };
  }

  doc(key: string, forPeer?: string): DocReply | null {
    const spec = this.specFor(key);
    if (!spec || !this.enabled(spec.category) || !this.sharesWith(forPeer, spec)) return null;
    if (this.observeOne(spec)) this.persist();
    const meta = this.records[key];
    const local = readLocal(spec);
    if (!meta || local.kind === "local-only") return null;
    if (spec.merge && local.kind !== "file") return null;
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
    if (spec.merge) return this.applyMerged(spec, remote);
    const local = this.records[key];
    if (local && compareDocs(remote.meta, local) <= 0) return "older";
    if (remote.meta.hash !== null) {
      if (typeof remote.content !== "string" || remote.content.length > MAX_DOC_BYTES) return "invalid";
      if (sha(remote.content) !== remote.meta.hash || !spec.valid(remote.content)) return "invalid";
    }
    const expect = local?.hash ?? null;
    const before = readLocal(spec);
    const ok = this.install(spec, remote.meta.hash === null ? null : (remote.content as string), expect);
    if (!ok) return "changed";
    if (before.kind === "file") this.keep(spec, before.text, remote.meta.origin);
    const { items: _items, ...whole } = remote.meta;
    this.records[key] = whole;
    this.persist();
    return null;
  }

  /**
   * Merge a peer's library into ours, profile by profile. Nothing it lacks is erased; its newer
   * profiles and deletions are taken; the merged file is checked and written like any document.
   * A result that differs from what the peer sent is dated as our own newer edit, so the peer (an
   * older build replaces whole) takes the union back.
   */
  private applyMerged(spec: DocSpec, remote: DocReply): DocPushReply["rejected"][number]["reason"] | null {
    const key = spec.key;
    if (remote.meta.hash === null) return "older"; // an absent library deletes nothing
    if (typeof remote.content !== "string" || remote.content.length > MAX_DOC_BYTES) return "invalid";
    if (sha(remote.content) !== remote.meta.hash || !spec.valid(remote.content)) return "invalid";
    const theirProfiles = profilesOf(remote.content);
    if (!theirProfiles) return "invalid";
    const theirItems = remoteItems(remote.meta, theirProfiles);
    if (!theirItems) return "invalid";
    const rec = this.records[key];
    const local = readLocal(spec);
    if (local.kind === "local-only") return "local-only";
    const ourProfiles = local.kind === "file" ? profilesOf(local.text) : null;
    const ourItems = rec?.items ?? (ourProfiles ? observeItems(undefined, ourProfiles, rec ?? { modifiedAt: 0, origin: this.opts.hostId }, false) : {});
    const now = this.now();
    const remoteFirst = !rec || rec.hash === null || compareDocs(remote.meta, rec) > 0;
    const merged = mergeLibraries({ profiles: ourProfiles, items: ourItems }, { profiles: theirProfiles, items: theirItems }, this.opts.hostId, now, remoteFirst);
    const sameFile =
      ourProfiles !== null &&
      merged.profiles.length === ourProfiles.length &&
      merged.profiles.every((p, i) => p.id === ourProfiles[i]!.id && merged.items[p.id]!.hash === ourItems[p.id]?.hash);
    const expect = hashOf(local) ?? null;
    let whole: DocMeta;
    if (sameFile) {
      const itemsChanged = JSON.stringify(merged.items) !== JSON.stringify(ourItems);
      if (!itemsChanged && rec) return "older";
      whole = { ...(rec ?? { hash: expect, modifiedAt: 0, origin: this.opts.hostId }), items: merged.items };
    } else {
      const theirsExactly =
        merged.profiles.length === theirProfiles.length && merged.profiles.every((p, i) => p.id === theirProfiles[i]!.id && merged.items[p.id]!.hash === theirItems[p.id]?.hash);
      const text = theirsExactly ? remote.content : libraryText(merged.profiles);
      if (!spec.valid(text) || text.length > MAX_DOC_BYTES) return "invalid";
      if (!this.install(spec, text, expect)) return "changed";
      if (local.kind === "file") this.keep(spec, local.text, (merged.cause ?? remote.meta).origin, merged.changes);
      const hash = sha(text);
      whole =
        hash === remote.meta.hash
          ? { hash, modifiedAt: remote.meta.modifiedAt, origin: remote.meta.origin, items: merged.items }
          : { hash, modifiedAt: Math.max(now, (rec?.modifiedAt ?? 0) + 1, remote.meta.modifiedAt + 1), origin: this.opts.hostId, items: merged.items };
    }
    // What we hold now differs from what the peer sent and isn't newer as a whole: date it ours, so
    // a peer that replaces whole (an older build) takes the union.
    if (whole.hash !== remote.meta.hash && compareDocs(whole, remote.meta) <= 0)
      whole = { ...whole, modifiedAt: Math.max(now, remote.meta.modifiedAt + 1), origin: this.opts.hostId };
    this.records[key] = whole;
    this.persist();
    if (whole.hash !== remote.meta.hash || itemsAhead(whole.items, theirItems)) this.scheduleSync();
    return null;
  }

  /** Keep a settings document's replaced version (§mesh.sync/kept-copies); never fails the sync. */
  private keep(spec: DocSpec, content: string, by: string, changes?: ProfileChanges): void {
    if (spec.category !== "settings") return;
    try {
      const byName = this.opts.deviceName?.(by);
      keepCopy(this.opts.stateDir, { key: spec.key, at: this.now(), by, ...(byName ? { byName } : {}), content, ...(changes ? { changes } : {}) });
    } catch (e) {
      this.log(`keeping ${spec.key} failed: ${(e as Error).message}`);
    }
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
      // Never taken from a peer this host doesn't share the document with.
      const spec = this.specFor(key);
      if (spec && !this.sharesWith(from, spec)) {
        reply.rejected.push({ key, reason: "disabled" });
        continue;
      }
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
      const mine = this.manifest(peer.id).docs;
      const theirs: Record<string, DocMeta> = {};
      for (const [k, v] of Object.entries(remote.docs ?? {})) {
        const spec = this.specFor(k);
        if (spec && isDocMeta(v) && this.sharesWith(peer.id, spec)) theirs[k] = v;
      }
      const push: DocPush = { hostId: this.opts.hostId, now: this.now(), docs: {} };
      for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
        const l = mine[key];
        const r = theirs[key];
        if (this.specFor(key)?.merge) {
          await this.syncMerged(peer, key, l, r, push);
          continue;
        }
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

  /**
   * A merged document with one peer: pull when it holds a profile stamp (or deletion) newer than
   * ours, then push when we hold one newer than its. An older peer sends no stamps: its file is
   * pulled whenever it differs from ours (the union deletes nothing), and ours pushed when newer.
   */
  private async syncMerged(peer: DocPeer, key: string, l: DocMeta | undefined, r: DocMeta | undefined, push: DocPush): Promise<void> {
    const stamped = (m: DocMeta | undefined) => !!m && isItems(m.items);
    if (r && r.hash !== null && (!l || l.hash !== r.hash) && (!l || !stamped(r) || itemsAhead(r.items, l.items))) {
      const got = await peer.doc(key).catch(() => null);
      if (got) this.apply(key, got);
    }
    const now = this.manifest(peer.id).docs[key];
    if (!now || now.hash === null) return;
    const ahead = !r || r.hash === null || (stamped(r) ? itemsAhead(now.items, r.items) : now.hash !== r.hash && compareDocs(now, r) > 0);
    if (!ahead) return;
    const got = this.doc(key);
    if (got) push.docs[key] = got;
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
