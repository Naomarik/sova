import { PROFILE_ENTRY, type ProfileEntryData } from "../shared/profiles";
import { removeOutputFiles } from "./shell-output";
import { keptLabels, redactPreviewLinks, redactPreviewLinksDeep } from "./preview-kept";
import { profileField, profileOnBranch } from "./session-profile";
import { type Dirent, statSync } from "node:fs";
import { type FileHandle, lstat, open, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { OVERSEER_ENTRY, type SessionSummary, type SessionTags } from "../shared/protocol";
import { activityOf, type LiveRecord, type RawLiveRecord, readLive, readOwnLiveRecords, workerCountsOf, workingSubagents } from "./live";
import { extraSessionRoots, LIVE_DIR, resolveSessionPath, sessionPathShape, SESSIONS_DIR } from "./paths";
import { isWebSession, removeWebSession } from "./web-sessions";
import type { HEntry } from "../shared/harness";
import { isLinkMessage } from "../shared/link-message";
import { isTopicBatch } from "../shared/topic-message";
import { parseWakeNudge } from "../shared/wake";
import { RECENT_WRITE_MS } from "./write-guard";
import { isArchived, setArchived } from "./archived-sessions";
import { dropGroupAssignments, readAssignments } from "./session-groups";
import { draftCounts, draftPreview, dropDrafts, readDrafts } from "./drafts";
import { dropSessionTitles, memoSessionTitleRecords, readSessionTitleRecords, type StoredTitle } from "./session-titles";
import { removeSessionAttachments } from "./attachments";
import { closeChat, cwdOverride, getModelRuntime, heldChatState, isSessionBusy, pendingDialogCount, shellInFlight } from "./chat-handle";
import { isUnread, isViewing, readSeen, turnErrorShows } from "./seen";
import { contextWindow } from "./models";
import { parseTargetCwd } from "./targets";
import { firstText, headerOf, joinedText, lineEntry, lineMay, toHEntry } from "./harness/pi/reader";
import { contextStep } from "./harness/pi/usage";
import { type AlignScan, readAlignScan } from "./align-state";
import { type WorkerParents, WorkerSessions } from "./worker-sessions";
import { isOverseerId, overseerDir, readOverseerState } from "./overseer-store";
import { readDecisionSettings } from "./decide-settings";
import { readSignals, settleGoAsk, type SignalsFile, signalsOverlay } from "./signals-store";
import { withOpenOffer } from "./session-offers";
import { dropSessionTags, tagsFor, tagsReader } from "./session-tags";
import { askTreesOf, branchesOverlay, pruneReadiness, readinessOverlay } from "./merge-readiness";
import { listGeneration } from "./list-generation";
import { projectOf, projectOverseerOfPath, readPoState } from "./project-overseer-store";
import { memoSovaChatNames, readSovaChatNames, setSovaChatName, type SovaChatName } from "./sova-chat-names";
import { rebuildSovaName } from "./sova-chat-origin";
import { SOVA_NAMED_FALLBACK, sovaNamedKind, type FixedNameKind, type SovaNamedKind } from "../shared/fixed-names";
import { projectOverseerUnread } from "./project-overseer-unread";
import { engineBuildsReader, type EngineBuildsReader } from "./build-loadout";
import { projectCodingIds, projectKeeps, projectSessionLookup } from "./project-sessions";
import { reservedRoots } from "./projects/contributions";
import { removeMemory } from "./memory/store";
import { removeSessionLabels } from "./message-labels";
import { removeSessionTimeSpent } from "./time-spent";
import { removeSessionTours } from "./tours/lifecycle";
import { byActivity } from "../src/lib/summary-diff";
import { queueChatRole } from "../shared/merge-queue";
import { opTrack } from "./stall-recorder";
import { runningJobCount } from "./background-jobs";

/**
 * What another layer adds to the list (organizations: a baton session's `baton`, an org session's `org`), and
 * the files it keeps (never deleted by Clean Up or an empty husk's archive). Registered as that layer loads, so
 * this module imports none of it.
 */
export interface SessionsPart {
  /** Once per listing pass: the fields of one file, or undefined. `project`: what the project layer says of it. */
  lookup(builds: EngineBuildsReader): { of(path: string, id: string, project?: SessionSummary["project"]): Pick<SessionSummary, "baton" | "org" | "folderOrg"> | undefined };
  /** Why the file may never be deleted here, or null. */
  keeps?(path: string): string | null;
  /** A gathering session's name (its public title), or undefined when the file isn't one (shared/fixed-names.ts). */
  gatheringTitle?(path: string): string | undefined;
}
const sessionParts: SessionsPart[] = [];
export function contributeSessions(part: SessionsPart): void {
  sessionParts.push(part);
}

/** One listing pass's lookups: the project layer's (by marker, build, then the session's folder), then every contributed part's. */
/** `mtimeMs`: the file's mtime as the listing holds it, so the project overseer marker check needs no stat. */
function fieldLookup(): (path: string, id: string, cwd?: string, mtimeMs?: number) => Pick<SessionSummary, "baton" | "org" | "folderOrg" | "project" | "projectOverseer"> {
  const builds = engineBuildsReader();
  const parts = sessionParts.map((p) => p.lookup(builds));
  const projects = projectSessionLookup(builds);
  return (path, id, cwd, mtimeMs) => {
    const out: Pick<SessionSummary, "baton" | "org" | "folderOrg" | "project" | "projectOverseer"> = {};
    const project = projects.of(path, id, cwd, mtimeMs);
    for (const l of parts) Object.assign(out, l.of(path, id, project) ?? {});
    if (project) out.project = project;
    if (!out.baton) {
      const po = projectOverseerOfPath(path, undefined, mtimeMs);
      if (po) out.projectOverseer = po;
    }
    return out;
  };
}

/** A gathering session's public title, from the layer that knows it; undefined for any other file. */
function gatheringTitleOf(path: string): string | undefined {
  for (const p of sessionParts) {
    const t = p.gatheringTitle?.(path);
    if (t?.trim()) return t;
  }
  return undefined;
}

// ---- fixed names (shared/fixed-names.ts) -----------------------------------------------------------------------

/** What makes a file one of the chats Sova names itself. `baton`: the list found it a baton session (undefined:
    unknown, so the gathering layer is asked). */
interface FixedFacts {
  id: string;
  path: string;
  overseer?: boolean;
  projectOverseer?: { projectId: string } | null;
  baton?: boolean;
  profile?: SessionSummary["profile"];
  /** The file's header time: tells a withdrawal's own chat from the release chat it followed. */
  createdAt?: string;
}
export interface FixedName {
  kind: FixedNameKind;
  name: string;
}

const nameLine = (t: string): string => t.replace(/\s+/g, " ").trim();

/** A project's name as it is now (a rename shows at the next read), or null when the project can't be read. */
function projectNameOf(projectId: string): string | null {
  try {
    return nameLine(projectOf(projectId).name) || null;
  } catch {
    return null;
  }
}

/**
 * The name Sova fixes for a chat, or null for every other chat. The overseers' names are derived (the project's
 * current name); a gathering's is its public title; a merge queue chat's or release chat's is the one Sova recorded
 * when it started the chat (server/sova-chat-names.ts, a store no rename writes). For a chat started before that
 * record, the name is rebuilt from Sova's own records with the start paths' formatters (server/sova-chat-origin.ts)
 * and recorded then, once; failing that, a merge chat's stored title when Sova wrote it (`auto`: the namer never
 * names a merge chat), else the kind's word. A release chat's `auto` title is never trusted: the namer may have
 * written it. Titles the user or the Overseer stored on these chats are never read.
 */
export function fixedNameOf(f: FixedFacts, names: Readonly<Record<string, SovaChatName>> = memoSovaChatNames(), titles: Readonly<Record<string, StoredTitle>> = memoSessionTitleRecords()): FixedName | null {
  if (f.overseer) return { kind: "overseer", name: "Overseer" };
  if (f.projectOverseer) {
    const project = projectNameOf(f.projectOverseer.projectId);
    return { kind: "project-overseer", name: project ? `Overseer \u00b7 ${project}` : "Overseer" };
  }
  if (f.baton !== false) {
    const t = gatheringTitleOf(f.path);
    if (t) return { kind: "gathering", name: nameLine(t) };
  }
  const given = names[f.id];
  const kind = sovaNamedKind(f.profile) ?? given?.kind;
  if (!kind) return null;
  if (given) return { kind, name: given.name };
  const rebuilt = rebuiltName(kind, f);
  if (rebuilt) return { kind, name: rebuilt };
  const stored = titles[f.id];
  return { kind, name: kind !== "release" && stored?.by === "auto" ? stored.title : SOVA_NAMED_FALLBACK[kind] };
}

/** Ids whose name couldn't be rebuilt, and when that was found: asked again a minute later at most. */
const unrebuilt = new Map<string, number>();
const UNREBUILT_MS = 60_000;

/** The rebuilt Sova name of a chat started before Sova recorded it, recorded now so it is read once. */
function rebuiltName(kind: SovaNamedKind, f: FixedFacts, now = Date.now()): string | null {
  const miss = unrebuilt.get(f.id);
  if (miss !== undefined && now - miss < UNREBUILT_MS) return null;
  const name = rebuildSovaName(kind, f.id, f.path, f.createdAt);
  if (!name) {
    if (unrebuilt.size > 2000) unrebuilt.clear();
    unrebuilt.set(f.id, now);
    return null;
  }
  unrebuilt.delete(f.id);
  setSovaChatName(f.id, kind, name);
  return name;
}

/** The facts of one file from what is cached of it (or, with nothing cached, its id from the file name). */
function fixedFactsOfPath(path: string, entry: CacheEntry | undefined = cache.get(path)): FixedFacts {
  const id = entry?.summary.id ?? idOf(path);
  const overseer = (entry ? entry.marked : true) && isOverseerId(id);
  return { id, path, overseer, projectOverseer: overseer ? null : projectOverseerOfPath(path, id, entry?.mtimeMs), profile: entry?.summary.profile, createdAt: entry?.summary.createdAt };
}

/** A file's fixed name, from its cached summary when there is one (else its file name and Sova's records). */
export function fixedNameOfPath(path: string): FixedName | null {
  return fixedNameOf(fixedFactsOfPath(path));
}

/** Whether a file is the Overseer's current conversation or an earlier one (the monitor's Open Session). */
export function overseerConversationOf(path: string): "current" | "earlier" | undefined {
  const entry = cache.get(path);
  if (entry && !entry.marked) return undefined;
  const id = entry?.summary.id ?? idOf(path);
  const st = readOverseerState();
  if (!st) return undefined;
  return st.current === id ? "current" : st.history.includes(id) ? "earlier" : undefined;
}

/** What the resource monitor says of a chat Sova names: its name, and whether it is the Overseer's current or an
    earlier conversation (Open Session goes to the Overseer page then). */
export interface MonitorFixed {
  title: string;
  overseer?: "current" | "earlier";
}
const MONITOR_FIXED_MS = 15_000;
const monitorFixedMemo = new Map<string, { at: number; v: MonitorFixed | null }>();

/**
 * The monitor's word on one session file (undefined: an ordinary session). `fresh` reads Sova's records now (a
 * history request); without it the answer is kept for 15 s, so the monitor's tick asks them at most that often.
 */
export function monitorFixedOf(path: string, fresh = false, now = Date.now()): MonitorFixed | undefined {
  const hit = monitorFixedMemo.get(path);
  if (!fresh && hit && now - hit.at < MONITOR_FIXED_MS) return hit.v ?? undefined;
  const f = fixedNameOfPath(path);
  const v: MonitorFixed | null = f ? { title: f.name, ...(f.kind === "overseer" ? { overseer: overseerConversationOf(path) ?? "earlier" } : {}) } : null;
  if (monitorFixedMemo.size > 2000) monitorFixedMemo.clear();
  monitorFixedMemo.set(path, { at: now, v });
  return v ?? undefined;
}

/** A row with its fixed name: `title` is the name, and no override provenance rides along (none applies). */
function withFixedName<T extends Pick<SessionSummary, "title" | "originalTitle" | "titleBy" | "fixedName">>(row: T, fixed: FixedName | null): T {
  if (!fixed) return row;
  const { originalTitle: _o, titleBy: _b, ...rest } = row;
  return { ...rest, title: fixed.name, fixedName: fixed.kind } as T;
}

/**
 * What an earlier overseer conversation was about (the History screens): Sova's automatic title for it, else its
 * first message, else "Untitled". Never the fixed name, and never a title somebody typed (a project overseer's file
 * stored its fixed name as one). Undefined when the file is not a session.
 */
export async function aboutOf(path: string, titles: Readonly<Record<string, StoredTitle>> = memoSessionTitleRecords()): Promise<string | undefined> {
  const s = await summarize(path).catch(() => null);
  if (!s) return undefined;
  const stored = titles[s.id];
  return stored?.by === "auto" ? stored.title : s.title;
}

/** Why a file may never be deleted here (another layer's, or a standalone project's), or null. */
function keptBy(path: string): string | null {
  for (const p of sessionParts) {
    const why = p.keeps?.(path);
    if (why) return why;
  }
  return projectKeeps(path);
}

/** SessionSummary.queueChat, from the file's own profile pick: the merge queue's thread or a reviewer. */
function queueChatField(profile: SessionSummary["profile"]): Pick<SessionSummary, "queueChat"> {
  const role = queueChatRole(profile);
  return role ? { queueChat: { role } } : {};
}

type BaseSummary = Omit<SessionSummary, "live" | "workers" | "origin" | "archived" | "busy">;

/** SessionSummary.chat, only while this server holds the chat: an in-memory read, like `busy`. */
const heldChatField = (path: string): Pick<SessionSummary, "chat"> => {
  const chat = heldChatState(path);
  return chat ? { chat } : {};
};

/** SessionSummary.jobsRunning: a shut-down chat's running background jobs (the list's `job running` marker). */
const jobsField = (id: string, path: string): Pick<SessionSummary, "jobsRunning"> => {
  if (heldChatState(path)) return {};
  const n = runningJobCount(id);
  return n > 0 ? { jobsRunning: n } : {};
};

const CHUNK = 16 * 1024;
const MAX_HEAD = 256 * 1024;
const MAX_TAIL = 256 * 1024;
const TITLE_MAX = 80;
const SUMMARY_MAX = 200;

/** A window lookup for "provider/model", from the caller's ModelRuntime. Optional everywhere:
 *  without one every summary reports `window: null` (getSessionSummary must stay runtime-free —
 *  tests call it directly). */
export type WindowResolver = (ref: string) => number | null;

/** Cached per (mtime, size). `contextModel` is the ref the window is looked up under; it is kept
 *  beside the summary because the window depends on the caller's runtime, not on the file.
 *  `outline` is how far the outline read got, which the next read of the grown file starts from. */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: BaseSummary;
  contextModel: string | null;
  outline: OutlineScan | null;
  /** The file's last finished assistant reply (tail window), for the unread dot and the turn-error mark. */
  lastReply: LastReply | null;
  /** The Ended line's excerpts, found in the same tail window (§app.overseer/list-overview). */
  ending: TailEnding;
  /** The file carries the Overseer marker. Whether it IS the Overseer's is decided per read
      (`overseerOf`): the answer changes with overseer-state.json, not with the file. */
  marked: boolean;
  /** How far the align read got (server/align-state.ts): the marker search resumes from it while
      the file only grows, and a file with no `align` result is never parsed. */
  align: AlignScan | null;
  /** isZeroInput's answer for this (mtime, size): the head read already says it, so the list's
      husk check never reads the file again while it is unchanged. */
  zeroInput: boolean;
}

const entries = new Map<string, CacheEntry>();
/** The summary cache, read-only here so that `storeEntry` and `dropEntry` stay its only writers:
    they are what keeps `idIndex` true. */
const cache: ReadonlyMap<string, CacheEntry> = entries;
/** `indexedSessionPaths`' answer until an id may have changed: replaced, never mutated, since a caller
    may keep one. Never updated in place either: paths can share an id, and the one that answers
    is the last in `cache`'s order, which only a fresh pass knows. */
let idIndex: ReadonlyMap<string, string> | null = null;

function storeEntry(path: string, entry: CacheEntry): void {
  if (entries.get(path)?.summary.id !== entry.summary.id) idIndex = null;
  entries.set(path, entry);
}

function dropEntry(path: string): void {
  if (entries.delete(path)) idIndex = null;
}

/** Worker-session detection (a subagent's / team member's own file). Kept apart from `cache` on
 *  purpose: the flag depends on OTHER files (owners append refs) and on the live registry, so it
 *  is recomputed on every listing, never baked into a file's cached head facts. */
const workerSessions = new WorkerSessions({ idOf: (p) => idOf(p) });
/** The session that runs worker `path` (worker-sessions.ts parentOf), from the last listing's scans; null: none known. */
/** SessionSummary.workerOf for a worker's row: its parent and name, from what the worker scan already read. */
function workerOfField(path: string, parents: Pick<WorkerParents, "workerOf"> = workerSessions): Pick<SessionSummary, "workerOf"> {
  try {
    const w = parents.workerOf(path);
    return w ? { workerOf: { id: idOf(w.parent), path: w.parent, ...(w.name ? { name: w.name } : {}) } } : {};
  } catch {
    return {};
  }
}

export async function workerParentOf(path: string): Promise<string | null> {
  return workerSessions.parentOf(path);
}

/** The worker-session paths among `files`; best-effort — a failure hides nothing. `changed`: only
 *  these (and files never scanned) can have changed since the last refresh. */
async function workerSessionPaths(files: string[], changed?: ReadonlySet<string>): Promise<Set<string>> {
  try {
    return await workerSessions.refresh(files, changed);
  } catch {
    return new Set();
  }
}

// Both redact kept preview links BEFORE they cut (§app.project-overseer/previews): a link cut short no
// longer matches, and its first characters would show.
function oneLine(s: string): string {
  const t = redactPreviewLinks(s).replace(/\s+/g, " ").trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** The outline's "now" line, whitespace-collapsed and capped for the sidebar's summary row. */
function summaryLine(s: string): string {
  const t = redactPreviewLinks(s).replace(/\s+/g, " ").trim();
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX - 1)}…` : t;
}

/** A user entry's first text, without pi 0.87's image resize notes: a title is the text as typed. */
const userText = (h: HEntry): string => firstText(h) ?? "";

/** A user message that never titles a session: a fired wake nudge, or a partner's message over a
    link (§mesh.links/transcript), or a topic batch (§chat.topics/row) — none is something the user said. */
const notTitle = (text: string): boolean => parseWakeNudge(text) !== null || isLinkMessage(text) || isTopicBatch(text);

/** Best-effort title from a user message line cut off by the read cap (huge pastes). */
function titleFromPartial(line: string): string | null {
  if (!/"type":"message"/.test(line) || !lineMay(line, "user")) return null;
  const m = /"(?:content|text)":"((?:[^"\\]|\\.){1,400})/.exec(line);
  if (!m?.[1]) return null;
  let s = m[1];
  // drop a dangling escape so JSON.parse can decode the fragment
  for (let i = 0; i < 6; i++) {
    try {
      return JSON.parse(`"${s}"`);
    } catch {
      s = s.slice(0, -1);
    }
  }
  return null;
}

/** "provider/model" of a model setting or an assistant reply, else null. */
function modelOf(h: HEntry | null): string | null {
  if (h?.kind === "setting" && h.what === "model" && h.provider && h.modelId) return `${h.provider}/${h.modelId}`;
  if (h?.kind === "assistant" && h.provider && h.model) return `${h.provider}/${h.model}`;
  return null;
}

const NL = 0x0a;

/**
 * The latest model in the file: scans backwards from EOF in 16KB chunks (cap 256KB) and returns
 * the model of the line closest to EOF that is a model_change or an assistant message with one.
 * Lines cut off by the cap or torn by a writer mid-append are skipped. Not branch-aware (the file
 * end wins), unlike the transcript's per-message resolution. null when the window has none.
 */
export async function readTailModel(path: string, size: number): Promise<string | null> {
  const win = await readTailWindowOf(path, size);
  return win ? tailModelIn(win) : null;
}

/**
 * The last MAX_TAIL bytes of a file, read once and shared by the tail readers (model, context,
 * ending) of one summary. `bof`: the window starts at the file's first byte, so its first line is
 * whole; otherwise that line started before the window and is never read. null when the file was
 * truncated under the read.
 */
interface TailWindow {
  buf: Buffer;
  bof: boolean;
}

async function readTailWindow(fh: FileHandle, size: number): Promise<TailWindow | null> {
  const floor = Math.max(0, size - MAX_TAIL);
  const buf = Buffer.alloc(size - floor);
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await fh.read(buf, got, buf.length - got, floor + got);
    if (bytesRead === 0) return null; // truncated under us: the next request retries
    got += bytesRead;
  }
  return { buf, bof: floor === 0 };
}

async function readTailWindowOf(path: string, size: number): Promise<TailWindow | null> {
  const fh = await open(path, "r");
  try {
    return await readTailWindow(fh, size);
  } finally {
    await fh.close();
  }
}

/** The window's complete lines, last first (a torn trailing line included: its parse fails). */
function* linesBack(win: TailWindow): Generator<Buffer> {
  const buf = win.buf;
  let stop = buf.length;
  for (;;) {
    const i = stop > 0 ? buf.lastIndexOf(NL, stop - 1) : -1;
    if (i < 0 && !win.bof) return; // the line's start is before the window
    yield buf.subarray(i + 1, stop);
    if (i < 0) return;
    stop = i;
  }
}

/** readTailModel's answer from a window. */
function tailModelIn(win: TailWindow): string | null {
  for (const line of linesBack(win)) {
    if (line.includes('"model_change"') || line.includes('"assistant"')) {
      // A torn trailing line or one that isn't JSON reads as null: skipped.
      const m = modelOf(lineEntry(line));
      if (m) return m;
    }
  }
  return null;
}

/** One `topic-outline` snapshot, as the summary row shows it. */
interface TailOutline {
  now: string;
  gist: string;
  generatedAt: number;
  topics: number;
}

/**
 * How far a file's outline read got, kept with its cached summary so that the next read, once the
 * file has only grown, starts where this one stopped (readOutline).
 */
interface OutlineScan {
  /** The latest outline found, carried from earlier reads while the file only grows. */
  found: TailOutline | null;
  /** The file size this read went up to: a smaller file next time was not appended to. */
  size: number;
  /** Just past the last newline this read saw: where the first line it could not read WHOLE
      starts. The next read starts here, so a line a writer was halfway through is read again. */
  resume: number;
  /** The bytes just before `resume`. Other bytes there next time mean the file was rewritten, not
      appended to (SessionManager.open() migrates old files in place, from whichever process opens
      them), so nothing is carried. */
  mark: Buffer;
}

const MARK_BYTES = 64;

/** Past the last MAX_TAIL bytes, a first read goes on back in chunks this big. */
const DEEP_CHUNK = 1024 * 1024;

/**
 * The topic-outline's latest snapshot in [floor, size), scanned backwards like readTailModel: the
 * last `topic-outline` custom entry's rolling "now" line, its "overall" gist, when it was
 * generated, and how many topics that same entry carried. The gist is the sidebar's summary row
 * (the "now" line is the fallback for snapshots without one); the live record's broadcast
 * may be newer (outlineOverlay). The count comes from the ACCEPTED entry (the one whose "now"
 * reads), so it always describes the snapshot shown next to it. `found` is null when the range has
 * none; `resume` is OutlineScan's. null when the file was truncated under the read.
 */
async function scanOutline(fh: FileHandle, size: number, floor: number): Promise<{ found: TailOutline | null; resume: number } | null> {
  let resume = -1; // set by the first newline met walking back from `size`
  let end = size;
  let carry = Buffer.alloc(0); // bytes after the first newline seen so far: a line's start is still unread
  while (end > floor) {
    const start = Math.max(floor, end - (size - end < MAX_TAIL ? CHUNK : DEEP_CHUNK));
    const chunk = Buffer.alloc(end - start);
    const { bytesRead } = await fh.read(chunk, 0, chunk.length, start);
    if (bytesRead < chunk.length) return null; // truncated under us: the next request retries
    end = start;
    const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
    // Complete lines are those after a newline in this buffer (or all of it at BOF).
    let stop = buf.length;
    for (;;) {
      const i = stop > 0 ? buf.lastIndexOf(NL, stop - 1) : -1;
      if (i < 0 && start > 0) break; // line start not read yet: carry it into the next chunk
      if (resume < 0) resume = start + i + 1;
      const line = buf.subarray(i + 1, stop);
      if (line.includes('"topic-outline"')) {
        try {
          const h = lineEntry(line);
          const data = h?.kind === "state" && h.key === "topic-outline" ? (h.data as any) : null;
          if (data && typeof data.now === "string") {
            const now = summaryLine(data.now);
            // An empty "now" (drafting/none) is no summary: keep scanning for one that reads.
            if (now) {
              const found = {
                now,
                gist: typeof data.overall === "string" ? summaryLine(data.overall) : "",
                generatedAt: typeof data.generatedAt === "number" && Number.isFinite(data.generatedAt) ? data.generatedAt : 0,
                topics: Array.isArray(data.topics) ? data.topics.length : 0,
              };
              return { found, resume };
            }
          }
        } catch {
          // torn trailing line or not JSON: skip
        }
      }
      if (i < 0) return { found: null, resume };
      stop = i;
    }
    carry = buf.subarray(0, stop);
  }
  // No newline in the range: the line it ends in started before `floor`, and stays unread.
  return { found: null, resume: resume < 0 ? floor : resume };
}

/** The MARK_BYTES before `offset` (fewer near the start of the file, or if it got shorter). */
async function bytesBefore(fh: FileHandle, offset: number): Promise<Buffer> {
  const from = Math.max(0, offset - MARK_BYTES);
  const buf = Buffer.alloc(offset - from);
  const { bytesRead } = await fh.read(buf, 0, buf.length, from);
  return buf.subarray(0, bytesRead);
}

/**
 * The file's latest outline for its summary, and how far the read got.
 *
 * If the file has only grown since the read `prev` — it is no shorter, and the bytes just before
 * where `prev` stopped are the same — only the bytes after that point are read, and `prev`'s
 * outline is carried unless they hold a newer one. Anything else — a first read, a file that
 * shrank or was rewritten — reads back from the end until it finds one, as far as the start of the
 * file. A tail window alone lost the outline of any session whose last snapshot was more than
 * MAX_TAIL from the end (an image read back is ~150 KB a line): the row had none while the
 * thread's strip, which reads the whole file, showed it, so opening the session popped the strip
 * in (§app/insights, opening a session). Each file is read that far once per (process, content):
 * what is carried is this process's own, and each server that lists a file reads its growth for
 * itself.
 * null when the file was truncated under the read.
 */
async function readOutline(fh: FileHandle, size: number, prev: OutlineScan | null): Promise<OutlineScan | null> {
  const grown = prev !== null && size >= prev.size && (await bytesBefore(fh, prev.resume)).equals(prev.mark);
  const scan = await scanOutline(fh, size, grown ? Math.max(0, prev.resume - 1) : 0);
  if (!scan) return null;
  return { found: scan.found ?? (grown ? prev.found : null), size, resume: scan.resume, mark: await bytesBefore(fh, scan.resume) };
}

/** Context fill read off the tail: tokens, plus the model of the assistant message that spent
 *  them ("provider/model") when it carried one. */
interface TailContext {
  tokens: number;
  model: string | null;
}

/**
 * contextForBranch's rule (server/harness/pi/usage.ts) applied to ONE entry, walking backwards:
 * "stale" for a compaction or its summary (the fill before it no longer describes the context), a
 * TailContext for an assistant reply that counts (contextStep), null to keep scanning. A reply
 * with no usage, a failed or aborted one, one reporting 0 context tokens, and pi 0.86.0's
 * top-level usage records are all skipped.
 */
function contextOf(h: HEntry | null): TailContext | "stale" | null {
  if (!h) return null;
  const step = contextStep(h); // null: an error/aborted or zero-usage reply, keep walking
  if (step === "compacted") return "stale";
  if (step === null || h.kind !== "assistant") return null;
  return { tokens: step, model: h.provider && h.model ? `${h.provider}/${h.model}` : null };
}

/**
 * The context fill at the file's LAST assistant reply, scanned backwards from EOF exactly like
 * readTailModel (16KB chunks, cap 256KB, torn/capped lines skipped). Same rule as the head's
 * contextForBranch, but on the raw file tail instead of the active branch: the first compaction
 * met walking back from EOF means there is no number (null), otherwise the first assistant
 * message with a usage object gives input + cacheRead + cacheWrite. null when the window has
 * neither. Not branch-aware — on a rewound session the tail can be a reply the head never sees.
 */
export async function readTailContext(path: string, size: number): Promise<TailContext | null> {
  const win = await readTailWindowOf(path, size);
  return win ? tailContextIn(win) : null;
}

/** readTailContext's answer from a window. */
function tailContextIn(win: TailWindow): TailContext | null {
  for (const line of linesBack(win)) {
    if (line.includes('"assistant"') || line.includes("compaction")) {
      // A torn trailing line or one that isn't JSON reads as null: skipped.
      const hit = contextOf(lineEntry(line));
      if (hit === "stale") return null;
      if (hit) return hit;
    }
  }
  return null;
}

/** When a reply happened, ms epoch: the message's own time (ms), else the entry's ISO one. */
function entryTime(h: { sentAt?: unknown; at?: unknown }): number | null {
  const m = h.sentAt;
  if (typeof m === "number" && Number.isFinite(m)) return m;
  const t = typeof h.at === "string" ? Date.parse(h.at) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** A turn is still open while its last reply is one of these: it asked for a tool, is being
    written, or was handed off to finish later. Every other stopReason ended the turn. */
const UNFINISHED_STOPS = new Set(["toolUse", "pending", "deferred"]);
/** How much of a reply's errorMessage the list keeps. */
export const REPLY_ERROR_MAX = 300;

/** The file's last finished assistant reply: when (ms epoch), how it stopped, and, for an error, why. */
export interface LastReply {
  at: number;
  stopReason: string;
  error?: string;
  /** The failed reply's own model's provider (only set on stopReason "error"). */
  provider?: string;
}

/** An entry as a finished reply, or null when it is not one. */
export function finishedReply(h: HEntry | null): LastReply | null {
  if (h?.kind !== "assistant") return null;
  const stop: unknown = h.stop;
  if (typeof stop !== "string" || UNFINISHED_STOPS.has(stop)) return null;
  const at = entryTime(h);
  if (at === null) return null;
  const msg: unknown = h.error;
  const error = stop === "error" && typeof msg === "string" && msg.trim() ? redactPreviewLinks(msg.trim()).slice(0, REPLY_ERROR_MAX) : undefined;
  const provider = stop === "error" && typeof h.provider === "string" ? h.provider : undefined;
  return { at, stopReason: stop, ...(error ? { error } : {}), ...(provider ? { provider } : {}) };
}

/**
 * The file's LAST finished assistant reply, scanned backwards from EOF like readTailModel (16KB
 * chunks, cap 256KB, torn lines skipped). A reply that leaves the turn open — a tool-use step, one
 * still pending, one deferred — is skipped, so "finished since you looked" means a turn ended.
 * null when the window has none.
 */
export async function readTailReply(path: string, size: number): Promise<LastReply | null> {
  return (await readTailEnding(path, size)).reply;
}

/** How much of the last user message and of the final reply the Ended line keeps (§app.overseer/list-overview). */
export const ENDING_EXCERPT = 200;

/** How a session ended, from its tail window: the opening of its last finished reply and of its
    last user message (a wake nudge, a link message or a topic batch is not one), each with its time. */
export interface TailEnding {
  /** `stop` and `error` are the reply's stop reason and error (LastReply's); `close` is the last
      ENDING_CLOSE characters of its text, kept preview links redacted, whitespace collapsed (the
      roundup's question check, §app.overseer/roundup). */
  reply?: { at: number; text: string; stop?: string; error?: string; close?: string };
  user?: { at: number; text: string };
}

/** A short excerpt, whitespace collapsed, kept preview links redacted before the cut, and copied so
    it never keeps its (possibly huge) source string alive (a slice is a view in Bun). */
function excerpt(text: string): string {
  const t = redactPreviewLinks(text.slice(0, ENDING_EXCERPT * 10)).replace(/\s+/g, " ").trim();
  const cutText = t.length > ENDING_EXCERPT ? `${t.slice(0, ENDING_EXCERPT - 1)}…` : t;
  return Buffer.from(cutText, "utf8").toString("utf8");
}

/** How much of the final reply's ending the tail keeps for the roundup's question check. */
export const ENDING_CLOSE = 1200;

/** The reply's last ENDING_CLOSE characters, redacted and collapsed like excerpt, and copied. */
function closeOf(text: string): string {
  const t = redactPreviewLinks(text.slice(-ENDING_CLOSE * 10)).replace(/\s+/g, " ").trim();
  return Buffer.from(t.slice(-ENDING_CLOSE), "utf8").toString("utf8");
}

/**
 * One backward scan of the tail window (readTailReply's): the last finished reply, and the excerpts
 * the Ended line shows (its text's opening, and the last user message's), found within the same
 * bounded window, so a listing never reads a whole transcript for them.
 */
export async function readTailEnding(path: string, size: number): Promise<{ reply: LastReply | null; ending: TailEnding }> {
  const win = await readTailWindowOf(path, size);
  return win ? tailEndingIn(win) : { reply: null, ending: {} };
}

/** readTailEnding's answer from a window. */
function tailEndingIn(win: TailWindow): { reply: LastReply | null; ending: TailEnding } {
  let reply: LastReply | null = null;
  const ending: TailEnding = {};
  for (const line of linesBack(win)) {
    const wantReply = !reply && line.includes('"assistant"');
    const wantUser = !ending.user && line.includes('"user"');
    // A torn trailing line or one that isn't JSON reads as null: skipped.
    const h = wantReply || wantUser ? lineEntry(line) : null;
    if (wantReply && h?.kind === "assistant") {
      const hit = finishedReply(h);
      if (hit) {
        reply = hit;
        const said = joinedText(h, { images: false });
        const close = closeOf(said);
        ending.reply = { at: hit.at, text: excerpt(said), stop: hit.stopReason, ...(hit.error ? { error: hit.error } : {}), ...(close ? { close } : {}) };
      }
    } else if (wantUser && h) {
      if (h.kind === "user") {
        const said = joinedText(h, { images: false });
        const at = entryTime(h);
        if (said.trim() && !notTitle(said) && at !== null) ending.user = { at, text: excerpt(said) };
      }
    }
    if (reply && ending.user) break;
  }
  return { reply, ending };
}

/**
 * Read only the head of a session file: header, first model_change, first user message.
 * Reads 16KB chunks and stops as soon as the first user message is seen (cap 256KB).
 * The model here is only the fallback for when readTailModel finds none near EOF.
 */
/** `input`: the head holds something written in it, so the session is no empty husk: a user message
    of any kind, or a saved command (shell mode's `!`/`!!`, pi's bashExecution, §chat.shell-mode/card). A wake
    nudge, a partner's link message or a command never titles a session, but each is still something
    written in it: a session whose only entries are link messages or commands is never an empty husk.
    (A command is still no input to the transcript's counts, rewind or titles: those read rows.) */
type HeadFacts = { header: any; title: string | null; model: string | null; overseer: boolean; input: boolean; profile?: ProfileEntryData | null };

export async function readHead(path: string): Promise<HeadFacts | null> {
  const fh = await open(path, "r");
  try {
    return await readHeadFrom(fh);
  } finally {
    await fh.close();
  }
}

/** readHead on a handle the caller opened (and closes). */
async function readHeadFrom(fh: FileHandle): Promise<HeadFacts | null> {
  // The Overseer marker is written right after the header, before any user message, so the
  // head read (which stops at the first user message) always sees it.
  let overseer = false;
  let profile: ProfileEntryData | null = null;
  let input = false;
  let header: any = null;
  let title: string | null = null;
  let model: string | null = null;
  let pending = "";
  let pos = 0;
  const buf = Buffer.alloc(CHUNK);
  const decoder = new TextDecoder("utf-8");
  while (pos < MAX_HEAD) {
    const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
    pending += decoder.decode(buf.subarray(0, bytesRead), { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!header) {
        if (!headerOf(e)) return null; // not a pi session
        header = e;
        continue;
      }
      // A `null` line has always failed the head read (the file is left out of the list).
      if (e === null) throw new TypeError("a null entry in the session's head");
      const h = toHEntry(e);
      if (h?.kind === "setting" && h.what === "model" && !model && h.provider && h.modelId) model = `${h.provider}/${h.modelId}`;
      if (h?.kind === "state" && h.key === OVERSEER_ENTRY) overseer = true;
      // The profile is fixed at the first message, so the newest entry before it is the session's.
      // Its fold still reads the raw entry (SessionState replaces it).
      if (h?.kind === "state" && h.key === PROFILE_ENTRY) profile = profileOnBranch([e]);
      if (h?.kind === "assistant" && !model && h.provider && h.model) model = `${h.provider}/${h.model}`;
      if (h?.kind === "user") {
        input = true;
        if (title === null && !notTitle(userText(h))) title = oneLine(userText(h));
      }
      // A saved command keeps the session (§chat.shell-mode/card); it never titles it.
      if (h?.kind === "shell") input = true;
      if (title !== null && model) return { header, title, model, overseer, input, profile };
    }
    // Stop at the first user message even without a model: model_change precedes it.
    if (title !== null) return { header, title, model, overseer, input, profile };
  }
  if (pending.trim() && title === null) {
    if (pos < MAX_HEAD) {
      // EOF: final line without trailing newline (or a writer mid-append)
      try {
        const e = JSON.parse(pending);
        const h = header ? toHEntry(e) : null;
        if (!header && headerOf(e)) header = e;
        else if (h?.kind === "user") {
          input = true;
          if (!notTitle(userText(h))) title = oneLine(userText(h));
        } else if (h?.kind === "shell") input = true;
      } catch {
        // partial line: ignore
      }
    } else if (header) {
      const t = titleFromPartial(pending);
      if (t !== null) input = true;
      if (t !== null && !notTitle(t)) title = oneLine(t);
    }
  }
  return header ? { header, title, model, overseer, input, profile } : null;
}

/**
 * The header's `parentSession` — the file a branched session was forked from (SessionHeader,
 * `SessionHeader.parentSession` in dist/core/session-manager.d.ts) — as the canonical path AND
 * the session id the group store
 * keys on, and only while that file is still there: a fork marker that points at a deleted
 * transcript is worse than none. sessionPathShape is what keeps this safe as well as honest: it
 * is pure string work — no syscall — and it only ever yields a .jsonl inside the (always local)
 * sessions dir, so the one ASYNC stat below never touches a session's cwd. It is also the same construction the
 * listing uses (SESSIONS_DIR + name), so `parent` is byte-identical to that session's own `path`.
 * Part of the cached summary, so a parent deleted after this session's last write keeps showing
 * until this file is touched again.
 */
async function existingParent(raw: unknown): Promise<{ parent: string; parentId: string } | null> {
  const path = sessionPathShape(typeof raw === "string" ? raw : null);
  if (!path) return null;
  const there = await stat(path).then(
    () => true,
    () => false,
  );
  return there ? { parent: path, parentId: idOf(path) } : null;
}

export async function listSessionFiles(): Promise<string[]> {
  const files: string[] = [];
  let top: Dirent[] = [];
  try {
    top = await readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    // no sessions dir yet: the extra roots below still count
  }
  await Promise.all(
    top.map(async (d) => {
      const p = join(SESSIONS_DIR, d.name);
      if (d.isFile() && d.name.endsWith(".jsonl")) files.push(p);
      else if (d.isDirectory() && p !== LIVE_DIR) {
        try {
          // real files only: symlinks could alias another session or point outside
          for (const f of await readdir(p, { withFileTypes: true }))
            if (f.isFile() && f.name.endsWith(".jsonl")) files.push(join(p, f.name));
        } catch {
          // unreadable dir: skip
        }
      }
    }),
  );
  // Each attached organization's workspace sessions dir (server/paths.ts extraSessionRoots): the
  // baton sessions, listed like any other. Flat, real files only, like the sessions dir.
  await Promise.all(
    extraSessionRoots().map(async (root) => {
      try {
        for (const f of await readdir(root, { withFileTypes: true })) if (f.isFile() && f.name.endsWith(".jsonl")) files.push(join(root, f.name));
      } catch {
        // missing or unreadable: skip
      }
    }),
  );
  return files;
}

/**
 * The cached summary with its context window resolved for THIS caller. The tokens come from the
 * file (and are cached with it); the window comes from the model catalog, so a summary first
 * cached by a runtime-less call still gets its window as soon as a resolver shows up.
 * The ref is the assistant message's own provider/model, else the summary's tail model — which
 * means that after a model switch the window is the CURRENT model's, i.e. the one the next reply
 * will actually use, not the one that produced these tokens.
 */
function withWindow(entry: CacheEntry, resolveWindow?: WindowResolver): BaseSummary {
  const summary = overseerOf(entry);
  const ctx = summary.context;
  if (!ctx || !resolveWindow) return summary;
  const ref = entry.contextModel ?? summary.model;
  const window = ref ? resolveWindow(ref) : null;
  return window === ctx.window ? summary : { ...summary, context: { tokens: ctx.tokens, window } };
}

/** A marked file is the Overseer's only while overseer-state.json knows its id (current or
    history); a marked file it doesn't know (a fork of one) is listed as an ordinary session. */
function overseerOf(entry: CacheEntry): BaseSummary {
  return entry.marked && isOverseerId(entry.summary.id) ? { ...entry.summary, overseer: true } : entry.summary;
}

const gistListeners = new Set<(path: string) => void>();
/** Called with a session's path when a read finds its summary line new or changed (the automatic
    namer's nudge, server/session-autotitle.ts). Also on this process's first read of each file. */
export function onSummaryLineChanged(fn: (path: string) => void): () => void {
  gistListeners.add(fn);
  return () => gistListeners.delete(fn);
}
function gistChanged(path: string): void {
  for (const fn of gistListeners) {
    try {
      fn(path);
    } catch (err) {
      console.error("[sessions] summary-line listener failed", err);
    }
  }
}

/** Session-file syscalls of the listing's own reads (tests, measurement): stats of a file it may
    summarize, and opens of one it reads. The align and worker scans keep their own. */
export const listIo = { stats: 0, opens: 0 };
/** Readings of worker parents so far: one per listing, however many worker rows it has. */
export const workerParentReadings = () => workerSessions.parentReadings;
let fullSummaryCount = 0;
/** Full summaries built so far (tests): a poll that reads one field stays on the base summary. */
export const fullSummaries = () => fullSummaryCount;

async function summarize(path: string, resolveWindow?: WindowResolver): Promise<BaseSummary | null> {
  let st;
  try {
    listIo.stats++;
    st = await stat(path);
  } catch {
    return null;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return withWindow(hit, resolveWindow);
  try {
    // One handle for the head, the outline and one tail window the three tail readers share.
    listIo.opens++;
    const fh = await open(path, "r");
    let head: HeadFacts | null;
    let win: TailWindow | null = null;
    let scan: OutlineScan | null = null;
    try {
      head = await readHeadFrom(fh);
      if (!head || typeof head.header.id !== "string") return null;
      win = await readTailWindow(fh, st.size);
      scan = await readOutline(fh, st.size, hit?.outline ?? null);
    } finally {
      await fh.close();
    }
    const h = head.header;
    const model = (win ? tailModelIn(win) : null) ?? head.model;
    const outline = scan?.found ?? null;
    const ctx = win ? tailContextIn(win) : null;
    const { reply: lastReply, ending } = win ? tailEndingIn(win) : { reply: null, ending: {} as TailEnding };
    const align = await readAlignScan(path, st.size, hit?.align ?? null);
    // A workspace session (an org's baton or overseer file) is listed under the dir it opens in on
    // THIS host; its header keeps the dir of the host that created it (§app.organizations/portability).
    const hostCwd = extraSessionRoots().includes(dirname(path)) ? cwdOverride(path) : undefined;
    const cwd = hostCwd ?? (typeof h.cwd === "string" ? h.cwd : "");
    const parent = await existingParent(h.parentSession);
    // Remote sessions use local placeholders, never mount mappings.
    const remote = parseTargetCwd(cwd);
    const summary: BaseSummary = {
      id: h.id,
      path,
      cwd,
      title: head.title || "Untitled",
      createdAt: typeof h.timestamp === "string" ? h.timestamp : new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
      lastActiveAt: new Date(st.mtimeMs).toISOString(),
      model,
      ...(outline ? { outlineNow: outline.now, outlineAt: outline.generatedAt, outlineTopics: outline.topics } : {}),
      ...(outline?.gist ? { outlineGist: outline.gist } : {}),
      ...(ctx ? { context: { tokens: ctx.tokens, window: null } } : {}),
      ...(parent ?? {}),
      ...(remote ? { target: remote.target, remoteCwd: remote.remoteCwd } : {}),
      ...(align.summary ? { align: align.summary } : {}),
      ...(profileField(head.profile) ? { profile: profileField(head.profile) } : {}),
      ...queueChatField(profileField(head.profile)),
    };
    const entry: CacheEntry = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      summary,
      contextModel: ctx?.model ?? null,
      outline: scan,
      lastReply,
      ending,
      marked: head.overseer,
      align,
      zeroInput: st.size <= MAX_HEAD && !head.input,
    };
    storeEntry(path, entry);
    if (summary.outlineGist && summary.outlineGist !== hit?.summary.outlineGist) gistChanged(path);
    return withWindow(entry, resolveWindow);
  } catch {
    return null;
  }
}

/** The file's merge-queue mark, from its base summary: the file is read only when the cache can't answer. */
export async function queueChatOf(path: string): Promise<SessionSummary["queueChat"]> {
  return (await summarize(path))?.queueChat;
}

function liveField(l: LiveRecord | undefined): SessionSummary["live"] {
  return l ? { pid: l.pid, status: l.status, ...(l.workers ? { workers: l.workers } : {}) } : null;
}

/**
 * The outline broadcast a row is overlaid with: a foreign writer's (a TUI, another server) when
 * its record carries one, else this server's own, for a chat it hosts. `readLive` leaves our own
 * records out, because they never mean somebody else holds the file, so without this a hosted
 * chat's row had only the file's tail to go on while its thread's Current goal strip read this same
 * record (getSessionInsight, `includeOwn`).
 */
function liveOutline(l: LiveRecord | undefined, own: RawLiveRecord | undefined): unknown {
  return l?.outline ?? own?.rec?.presence?.outline;
}

/** A live outline broadcast (liveOutline) can be newer than the file's last `topic-outline` entry
 *  (insights' overlayOutline, reduced to the summary line + topic count): prefer it when it's at
 *  least as new. The broadcast's `topics` is an array of heading strings, so its length is the
 *  count; a broadcast without that array leaves the file's count alone. */
function outlineOverlay(s: BaseSummary, outline: unknown): { outlineNow?: string; outlineGist?: string; outlineAt?: number; outlineTopics?: number } {
  if (!outline || typeof outline !== "object") return {};
  const o = outline as { now?: unknown; overall?: unknown; generatedAt?: unknown; topics?: unknown };
  if (typeof o.now !== "string" || !o.now.trim()) return {};
  const at = typeof o.generatedAt === "number" && Number.isFinite(o.generatedAt) ? o.generatedAt : 0;
  if (s.outlineAt !== undefined && at < s.outlineAt) return {};
  const now = summaryLine(o.now);
  if (!now) return {};
  // `overall` only rides the broadcast under `shareWithSessions: "summary"`; without it the file's
  // gist stands (a stale purpose still beats a fresh process update).
  const gist = typeof o.overall === "string" ? summaryLine(o.overall) : "";
  return {
    outlineNow: now,
    ...(gist ? { outlineGist: gist } : {}),
    outlineAt: Math.max(at, s.outlineAt ?? 0),
    ...(Array.isArray(o.topics) ? { outlineTopics: o.topics.filter((t) => typeof t === "string").length } : {}),
  };
}

/**
 * The user's own title for a session, laid over the derived one (server/session-titles.ts). The
 * ORIGINAL — the first user message, which is what the file says — rides along as `originalTitle`
 * whenever an override is showing, so a reader can still tell which session this is and clearing
 * the override has something to go back to. Applied here, at the two places a SessionSummary is
 * handed out, rather than in `summarize`: that result is cached per file mtime, and a rename
 * changes no byte of the file.
 */
function withTitle(s: BaseSummary, titles: Readonly<Record<string, StoredTitle>>): BaseSummary {
  const stored = titles[s.id];
  if (!stored) return s;
  // Who set it rides along even when the title equals the derived one: an explicit title is
  // explicit whatever it says, and the list's Name sessions button must not count that row.
  return stored.title !== s.title ? { ...s, title: stored.title, originalTitle: s.title, titleBy: stored.by } : { ...s, titleBy: stored.by };
}

/** A session's display title from what is already in memory (the cached summary and the titles
    as last read), with no read of its transcript beyond a chat Sova names itself, whose name comes from Sova's own
    small records (at most every 15 s, monitorFixedOf); undefined when the session was never summarized here. */
export function cachedTitleOf(path: string): string | undefined {
  // A chat Sova names itself reads that name even before its file was summarized here (kept 15 s: monitorFixedOf).
  const fixed = monitorFixedOf(path);
  if (fixed) return fixed.title;
  const hit = cache.get(path);
  return hit ? withTitle(hit.summary, memoSessionTitleRecords()).title : undefined;
}

/** A session's display title as the list shows it (its stored title, else its name or first message,
    else "Untitled"), reading the file when its summary is not cached or is stale; undefined when the
    file is not a session. */
export async function displayTitleOf(path: string): Promise<string | undefined> {
  const s = await summarize(path).catch(() => null);
  if (!s) return undefined;
  return fixedNameOf(fixedFactsOfPath(path))?.name ?? withTitle(s, memoSessionTitleRecords()).title;
}

/** ms epoch of a session's last assistant reply, from the cached tail read; undefined when unknown. */
export function lastReplyAtOf(path: string): number | undefined {
  return cache.get(path)?.lastReply?.at;
}

/** A session's last finished reply, from the cached tail read; undefined when unknown. */
export function lastReplyOf(path: string): LastReply | undefined {
  return cache.get(path)?.lastReply ?? undefined;
}

/** How the session ended, as the list's cache read it from the file's tail (no read here); undefined
    while the file isn't cached. */
export function endingOf(path: string): TailEnding | undefined {
  return cache.get(path)?.ending;
}

/**
 * The attention overlay of one row: the live record's activity (a TUI's, else this server's own
 * runtime's), the hosted chat's live-pending dialogs, and the seen store's stamp, unread dot and
 * turn-error mark. Never part of the cached summary: every input changes without the file changing.
 */
function attentionFields(
  s: BaseSummary,
  l: LiveRecord | undefined,
  own: RawLiveRecord | undefined,
  seen: Record<string, number>,
): Pick<SessionSummary, "activity" | "pendingDialogs" | "seenAt" | "unread" | "turnError"> {
  const a = l?.activity ?? activityOf(own?.rec);
  const dialogs = pendingDialogCount(s.path);
  const seenAt = seen[s.id];
  const lastReply = cache.get(s.path)?.lastReply ?? undefined;
  const running = isSessionBusy(s.path) || a?.state === "working";
  const viewing = isViewing(s.id);
  const unread = isUnread({ seenAt, lastReplyAt: lastReply?.at, viewing, running });
  const turnError = turnErrorShows({ seenAt, lastReply, viewing, running });
  return {
    ...(a ? { activity: { state: a.state, ...(a.since ? { since: a.since } : {}), ...(a.error ? { error: a.error } : {}) } } : {}),
    ...(dialogs > 0 ? { pendingDialogs: dialogs } : {}),
    ...(seenAt !== undefined ? { seenAt } : {}),
    ...(unread ? { unread: true as const } : {}),
    ...(turnError && lastReply ? { turnError: lastReply.error ? { message: lastReply.error, ...(lastReply.provider ? { provider: lastReply.provider } : {}) } : {} } : {}),
  };
}

/**
 * The decision overlays of one row (Settings → Decisions): attention signals and worker checks
 * from signals.json, present only while they should show (signals-store.ts), and the session's
 * tags. Like attentionFields, never part of the cached summary: the stores change, the file doesn't.
 */
function decisionFields(
  s: BaseSummary,
  l: LiveRecord | undefined,
  own: RawLiveRecord | undefined,
  seen: Record<string, number>,
  attention: boolean,
  /** One listing pass's reads of the tag and signal stores, shared by its rows. */
  reads?: { tags: (id: string) => SessionTags | undefined; signals: SignalsFile },
): Pick<SessionSummary, "signals" | "workerSignals" | "tags"> {
  const tags = reads ? reads.tags(s.id) : tagsFor(s.id);
  if (!attention) return tags ? { tags } : {};
  const data = reads?.signals ?? readSignals();
  const ctx = { enabled: true, seenAt: seen[s.id], viewing: isViewing(s.id) };
  const running = isSessionBusy(s.path) || (l?.activity ?? activityOf(own?.rec))?.state === "working";
  // An open offer card asks the user too (§app.decisions/asks-user, §chat.offers/card).
  const signals = withOpenOffer(s.id, signalsOverlay(s.id, { ...ctx, running }, data), running);
  return {
    ...(signals ? { signals } : {}),
    ...(tags ? { tags } : {}),
  };
}

/**
 * The one async overlay of a finished row: a project overseer's count of unseen replies
 * (`unreadReplies`, §app.overseer/seen), on its current conversation only and only while `unread`
 * is set. The list and every single-row refresh both end here, so a row never loses its count on a
 * refresh. Each project's counter is kept between reads (server/project-overseer-unread), shared
 * with the project overseer page: a rebuild re-reads only what the file gained.
 */
async function withUnreadReplies(row: SessionSummary): Promise<SessionSummary> {
  const projectId = row.unread ? row.projectOverseer?.projectId : undefined;
  if (!projectId) return row;
  try {
    if (readPoState({ projectId })?.current !== row.id) return row;
    return { ...row, unreadReplies: await projectOverseerUnread(projectId, row.path, row.seenAt) };
  } catch {
    // An unreadable state or file: the count is unknown, and absent says so.
    return row;
  }
}

/** How long a finished listing serves further callers, from its build's start (§app.session-list/listing-reuse). */
export const LIST_REUSE_MS = 1_000;
type Listing = { generation: number; startedAt: number; stamp: number; built: Promise<{ rows: SessionSummary[]; files: string[] }> };
let listing: Listing | null = null;
/** One more per build started, of either kind: a higher stamp is a build that started later. */
let listStamp = 0;

/** All sessions, newest activity first, with fresh live presence merged in. Callers share a build
    that is running or started less than LIST_REUSE_MS ago, unless something in this process changed
    since it started (server/list-generation.ts). Each caller gets its own array; rows are shared
    and never mutated. */
export function listSessions(): Promise<SessionSummary[]> {
  const now = Date.now();
  const generation = listGeneration();
  let l = listing;
  if (!l || l.generation !== generation || now - l.startedAt >= LIST_REUSE_MS || now < l.startedAt) {
    const mine: Listing = { generation, startedAt: now, stamp: ++listStamp, built: buildSessions() };
    listing = l = mine;
    mine.built.catch(() => {
      if (listing === mine) listing = null;
    });
  }
  return l.built.then((b) => [...b.rows]);
}

/** The last listing's rows by path (buildSessions hands an unchanged row out as the same object). */
let lastRows = new Map<string, SessionSummary>();

/** The last listing's rows by path, as built (no read): what the project cards' glance joins the monitor's sessions to. */
export const lastListedRows = (): ReadonlyMap<string, SessionSummary> => lastRows;

/** Deep equality that also holds key order and undefined-valued keys: JSON- and deepStrictEqual-identical. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i]!;
    if (k !== kb[i] || !sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** How often the tracked listing reads every folder and stats every file anyway: the net for a
    change no watch event told of. */
export const SWEEP_MS = 5 * 60_000;
/** How often the tracked listing stats every file it knows (no folder read) and re-reads those whose
    mtime or size moved: the net for a write whose watch event was lost (Bun's watch drops a second
    event that follows the first within a few ms), at the feed's safety-net pace. */
export const STAT_SWEEP_MS = 60_000;

/**
 * The session feed's file tracker: while a watch reports which session files changed
 * (server/session-feed-watch.ts `files`), the feed's listing (listSessionsTracked) reuses the last
 * file set and cached summaries and reads only the files named since its last build. `all`: the
 * watch could not say (or nothing is known yet), so the next build reads every folder.
 */
const tracker = { active: 0, all: true, dirty: new Set<string>(), files: null as string[] | null, sweptAt: 0, statAt: 0, listed: 0, chain: Promise.resolve() as Promise<unknown> };

/** Start tracking (the feed's watch starts it with itself); returns the note sink and its stop. */
export function trackSessionFiles(): { note: (path: string | null) => void; stop: () => void } {
  tracker.active++;
  let stopped = false;
  return {
    note: (path) => {
      if (stopped) return;
      if (path === null) tracker.all = true;
      else tracker.dirty.add(path);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (--tracker.active === 0) {
        // Untracked time is unseen time: the next tracked build starts from a full read.
        tracker.all = true;
        tracker.files = null;
        tracker.dirty.clear();
      }
    },
  };
}

/** Builds the tracked listing has run, and how many were full (tests, measurement). */
export const trackedStats = { builds: 0, full: 0, statSweeps: 0, lastDirty: 0, joined: 0 };

/** Which builds the feed's listing has read, against which have started: a signal heard at `now()`
    is in a list only when `listed()` came out higher. With no tracker the feed's list is listSessions,
    joining nothing of its own accord: nothing to compare. */
export const listStamps = {
  now: (): number => listStamp,
  listed: (): number => (tracker.active > 0 ? tracker.listed : Infinity),
};

/**
 * listSessions for the session feed: the same rows (a full build gives the same list), but while a
 * tracker runs only the files a watch named since the last build are stat'ed and read; every other
 * file's cached summary stands. A full build runs when nothing is known yet, when the watch could
 * not say what changed, and at least every SWEEP_MS; every STAT_SWEEP_MS each known file is
 * stat'ed and re-read only if it moved. Without a tracker it is listSessions. Builds
 * run one at a time.
 *
 * `join`: a listSessions build that started within LIST_REUSE_MS and later than the last list read
 * here stands in for a build of this one's own. It read every file, so it holds whatever a tracked
 * build would have, up to its own start; the caller compares listStamps for what came after. Never
 * the other way: a tracked build skips what a watch never named, and listSessions promises more.
 */
export function listSessionsTracked(opts: { join?: boolean } = {}): Promise<SessionSummary[]> {
  if (tracker.active === 0) return listSessions();
  const shared = opts.join ? joinableListing() : null;
  if (shared) return joinListing(shared);
  return ownTrackedBuild();
}

function ownTrackedBuild(): Promise<SessionSummary[]> {
  const run = tracker.chain.then(buildTracked, buildTracked);
  tracker.chain = run.catch(() => undefined);
  return run.then((rows) => [...rows]);
}

function joinableListing(now = Date.now()): Listing | null {
  const l = listing;
  return l && l.stamp > tracker.listed && now >= l.startedAt && now - l.startedAt < LIST_REUSE_MS ? l : null;
}

async function joinListing(l: Listing): Promise<SessionSummary[]> {
  tracker.listed = l.stamp;
  trackedStats.joined++;
  let built: Awaited<Listing["built"]>;
  try {
    built = await l.built;
  } catch {
    return ownTrackedBuild();
  }
  // Its file set is the newest there is: the next tracked build starts from it, and what the watch
  // noted meanwhile stays dirty for that build, so a row can't leave with the next list.
  if (tracker.active > 0) tracker.files = built.files;
  return [...built.rows];
}

async function buildTracked(): Promise<SessionSummary[]> {
  const now = Date.now();
  tracker.listed = ++listStamp;
  trackedStats.builds++;
  const full = tracker.all || tracker.files === null || now - tracker.sweptAt >= SWEEP_MS || now < tracker.sweptAt;
  // Taken before any await: what is noted during this build is the next build's.
  const dirty = tracker.dirty;
  tracker.dirty = new Set();
  if (full) {
    tracker.all = false;
    tracker.sweptAt = now;
    tracker.statAt = now;
    trackedStats.full++;
    try {
      const b = await buildSessions();
      if (tracker.active > 0) tracker.files = b.files;
      return b.rows;
    } catch (err) {
      tracker.all = true;
      throw err;
    }
  }
  try {
    if (now - tracker.statAt >= STAT_SWEEP_MS || now < tracker.statAt) {
      tracker.statAt = now;
      trackedStats.statSweeps++;
      await addMoved(tracker.files!, dirty);
    }
    trackedStats.lastDirty = dirty.size;
    const files = await trackedFiles(tracker.files!, dirty);
    const b = await buildSessions({ files, dirty });
    if (tracker.active > 0 && !tracker.all) tracker.files = b.files;
    return b.rows;
  } catch (err) {
    tracker.all = true;
    throw err;
  }
}

/** Adds to `dirty` each of `files` whose stat no longer matches its cached summary (or that has
    none, or is gone). */
async function addMoved(files: readonly string[], dirty: Set<string>): Promise<void> {
  await Promise.all(
    files.map(async (p) => {
      if (dirty.has(p)) return;
      listIo.stats++;
      const st = await stat(p).catch(() => null);
      const hit = cache.get(p);
      if (!st || !hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) dirty.add(p);
    }),
  );
}

/** The last file set with each named path added (a listable session file now) or dropped (gone,
    or no longer a plain file). Listed in listSessionFiles' places only: the watch reports only
    from the folders that lists. */
async function trackedFiles(prev: readonly string[], dirty: ReadonlySet<string>): Promise<string[]> {
  if (dirty.size === 0) return [...prev];
  const present = new Map<string, boolean>();
  await Promise.all(
    [...dirty].map(async (p) => {
      listIo.stats++;
      const st = await lstat(p).catch(() => null);
      present.set(p, !!st && st.isFile() && p.endsWith(".jsonl"));
    }),
  );
  const out = prev.filter((p) => present.get(p) !== false);
  const had = new Set(prev);
  for (const [p, there] of present) if (there && !had.has(p)) out.push(p);
  return out;
}

/** A clean file's summary (`dirty` names every file that may have changed): the cached one, with
    no stat; a file with none is read like any other. */
function summaryOf(path: string, resolveWindow: WindowResolver | undefined, dirty: ReadonlySet<string> | undefined): Promise<BaseSummary | null> {
  if (dirty && !dirty.has(path)) {
    const hit = cache.get(path);
    if (hit) return Promise.resolve(withWindow(hit, resolveWindow));
  }
  return summarize(path, resolveWindow);
}

/** The husk check (isZeroInput) from the summary cache when it holds this file, else from the file. */
async function zeroInputOf(path: string): Promise<boolean> {
  const hit = cache.get(path);
  if (hit) return hit.zeroInput;
  listIo.stats++;
  const st = await stat(path).catch(() => null);
  return !!st && (await isZeroInput(path, st.size));
}

/** Every row. `track`: the file set to list and the files that may have changed since the cached
    summaries were read (only those are stat'ed and read); without it every folder is read and
    every file stat'ed. Returns the rows and the file set they came from. */
function buildSessions(track?: { files: string[]; dirty: ReadonlySet<string> }): Promise<{ rows: SessionSummary[]; files: string[] }> {
  return opTrack("buildSessions", () => buildSessionsNow(track), (b) => b.rows.length);
}

async function buildSessionsNow(track?: { files: string[]; dirty: ReadonlySet<string> }): Promise<{ rows: SessionSummary[]; files: string[] }> {
  const files = track ? track.files : await listSessionFiles();
  const live = readLive();
  const own = readOwnLiveRecords();
  const resolveWindow = await windowResolver();
  const drafts = readDrafts();
  const titles = readSessionTitleRecords();
  const sovaNames = readSovaChatNames();
  const groups = readAssignments();
  const seen = readSeen();
  const attention = readDecisionSettings().features.attention;
  const fields = fieldLookup();
  const stores = { tags: tagsReader(), signals: readSignals() };
  // A kept preview link never reaches the list (§app.project-overseer/previews): a title or summary line
  // that holds one (the overseer saw it in its tool result) shows "[preview link]" in its place.
  const previewLabels = keptLabels();
  // A member whose file is gone KEEPS its assignment, on purpose: the workspace's "This
  // session's file is gone" pane IS that assignment rendered (spec 14-workspaces "Gone from
  // disk"), and pruning here — on every listing pass — would race the pane's own Remove From
  // Group gesture, so the member would vanish silently instead of showing its state. Only
  // Archive cleanup prunes, and only the ids it deleted itself (cleanupSessions, below). The
  // batch prompt already answers a gone member with its own "missing" refusal code.
  const [results, workers] = await Promise.all([
    Promise.all(files.map((f) => summaryOf(f, resolveWindow, track?.dirty))),
    workerSessionPaths(files, track?.dirty),
  ]);
  const present = new Set(files);
  for (const k of cache.keys()) if (!present.has(k)) dropEntry(k);
  const out: SessionSummary[] = [];
  const parents = workerSessions.parents();
  for (const s of results) {
    if (!s) continue;
    // Empty husks — no user message anywhere in the file — are never listed, so abandoned
    // new-session stubs don't clutter the archive. Hidden
    // only when the whole file was read: a first user message beyond the head cap never hides
    // a session. cleanupSessions("husks") still finds and deletes them by path.
    // Exception: a husk with a stored composer draft (text or images) is a new session the user
    // is writing in, not an abandoned stub, so it is listed as a draft row (draftPreview).
    const draft = drafts[s.id];
    const hasDraft = draftCounts(draft);
    let preview: string | undefined;
    // A baton or project overseer file is never a husk: a fresh baton held by the operator (or
    // waiting for its first link) needs them before anyone has written in it.
    const special = fields(s.path, s.id, s.cwd, cache.get(s.path)?.mtimeMs);
    if (s.title === "Untitled") {
      if (await zeroInputOf(s.path)) {
        // A husk waiting on a dialog (a command run in a new session) is waiting on the user: listed.
        // So is one that carries a profile: a One at a time profile counts from its pick, so the
        // session holding it must be somewhere the user can find it (§chat.profiles/singleton).
        if (!hasDraft && pendingDialogCount(s.path) === 0 && !special.baton && !special.projectOverseer && !s.profile) continue;
        if (hasDraft) preview = draftPreview(redactPreviewLinks(draft.text), draft.attachments);
      }
    }
    const l = live.get(s.path);
    const ownRec = own.get(s.path);
    // The husk check above reads the DERIVED title on purpose: what keeps an empty session out of
    // the list is that nobody has written in it, which renaming it doesn't change.
    const fixed = fixedNameOf({ id: s.id, path: s.path, overseer: !!s.overseer, projectOverseer: special.projectOverseer, baton: !!special.baton, profile: s.profile, createdAt: s.createdAt }, sovaNames, titles);
    const row: SessionSummary = {
      ...withFixedName(withTitle(s, titles), fixed),
      ...outlineOverlay(s, liveOutline(l, ownRec)),
      live: liveField(l),
      workers: l?.workers ?? (ownRec ? workerCountsOf(ownRec.rec) : undefined),
      origin: isWebSession(s.id) ? "web" : "external",
      archived: isArchived(s.id),
      ...(workers.has(s.path) ? { workerSession: true as const, ...workerOfField(s.path, parents) } : {}),
      ...(groups[s.id] !== undefined ? { groupId: groups[s.id] } : {}),
      busy: isSessionBusy(s.path),
      ...heldChatField(s.path),
      ...jobsField(s.id, s.path),
      ...attentionFields(s, l, ownRec, seen),
      ...decisionFields(s, l, ownRec, seen, attention, stores),
      ...(preview !== undefined ? { draftPreview: preview } : {}),
      ...(hasDraft ? { hasDraft: true as const } : {}),
      ...special,
    };
    // Merge readiness (§chat.worktrees/readiness): the last background answer; git is never awaited here.
    const readiness = readinessOverlay(row);
    // The branches its chat's status row counts, each queue entry as the queue has it now (no Git here either).
    const branches = branchesOverlay(row);
    const withMerge = readiness || branches ? { ...row, ...(readiness ? { readiness } : {}), ...(branches ? { branches } : {}) } : row;
    // A go-ahead ask whose version landed is noted when first seen; one in the queue is hidden while the queue says so.
    const settled = settleGoAsk(withMerge, askTreesOf(withMerge), stores.signals);
    stores.signals = settled.data;
    out.push(redactPreviewLinksDeep(settled.row, previewLabels));
  }
  pruneReadiness(out);
  for (let i = 0; i < out.length; i++) out[i] = await withUnreadReplies(out[i]!);
  // A row equal to the last listing's (same keys, in order, same values) is that object itself:
  // rows are shared and never mutated, and a reader that keys work by row (the session feed's
  // comparison) does it once per change instead of once per row per listing.
  for (let i = 0; i < out.length; i++) {
    const prev = lastRows.get(out[i]!.path);
    if (prev && sameValue(prev, out[i])) out[i] = prev;
  }
  lastRows = new Map(out.map((r) => [r.path, r]));
  out.sort(byActivity);
  return { rows: out, files };
}

/**
 * The model runtime as a window lookup, resolved ONCE per listing call. Best-effort: with no
 * auth configured (or in a test's throwaway agent dir) ModelRuntime.create() can fail, and then
 * every context gauge simply reports `window: null` instead of failing the listing.
 */
async function windowResolver(): Promise<WindowResolver | undefined> {
  try {
    const runtime = await getModelRuntime();
    return (ref) => contextWindow(ref, runtime);
  } catch {
    return undefined;
  }
}

/** One summary. `resolveWindow` is optional on purpose: without it the context gauge has no
 *  window (tests and any caller that must not spin up a ModelRuntime). */
/** The stores a single-row summary reads besides its file, read once and shared by every row of
    one request (the Overseer's history, a batch of refreshes). */
export interface SummaryReads {
  live: Map<string, LiveRecord>;
  own: Map<string, RawLiveRecord>;
  groups: Record<string, string>;
  titles: ReturnType<typeof readSessionTitleRecords>;
  sovaNames: ReturnType<typeof readSovaChatNames>;
  seen: Record<string, number>;
  attention: boolean;
  fields: ReturnType<typeof fieldLookup>;
}

export function summaryReads(): SummaryReads {
  return {
    live: readLive(),
    own: readOwnLiveRecords(),
    groups: readAssignments(),
    titles: readSessionTitleRecords(),
    sovaNames: readSovaChatNames(),
    seen: readSeen(),
    attention: readDecisionSettings().features.attention,
    fields: fieldLookup(),
  };
}

export async function getSessionSummary(path: string, resolveWindow?: WindowResolver, reads?: SummaryReads): Promise<SessionSummary | null> {
  fullSummaryCount++;
  const s = await summarize(path, resolveWindow);
  if (!s) return null;
  const r = reads ?? summaryReads();
  const l = r.live.get(path);
  const ownRec = r.own.get(path);
  const groupId = r.groups[s.id];
  const worker = await workerSessions.isWorker(s.path).catch(() => false);
  const special = r.fields(s.path, s.id, s.cwd);
  const fixed = fixedNameOf({ id: s.id, path: s.path, overseer: !!s.overseer, projectOverseer: special.projectOverseer, baton: !!special.baton, profile: s.profile, createdAt: s.createdAt }, r.sovaNames, r.titles);
  const row: SessionSummary = {
    ...withFixedName(withTitle(s, r.titles), fixed),
    ...outlineOverlay(s, liveOutline(l, ownRec)),
    live: liveField(l),
    workers: l?.workers ?? (ownRec ? workerCountsOf(ownRec.rec) : undefined),
    origin: isWebSession(s.id) ? "web" : "external",
    archived: isArchived(s.id),
    ...(worker ? { workerSession: true as const, ...workerOfField(s.path) } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    busy: isSessionBusy(s.path),
    ...heldChatField(s.path),
    ...jobsField(s.id, s.path),
    ...attentionFields(s, l, ownRec, r.seen),
    ...decisionFields(s, l, ownRec, r.seen, r.attention),
    ...special,
  };
  const readiness = readinessOverlay(row);
  const branches = branchesOverlay(row);
  const withMerge = readiness || branches ? { ...row, ...(readiness ? { readiness } : {}), ...(branches ? { branches } : {}) } : row;
  return withUnreadReplies(redactPreviewLinksDeep(settleGoAsk(withMerge, askTreesOf(withMerge)).row));
}

const archivedListeners = new Set<(sessionId: string) => void>();
/** Called with a session's id when it is archived, or deleted by cleanup: archiving a member ends
    every link it is in (§mesh.links/record; server/mesh/links.ts registers `endFor`). */
export function onSessionArchived(fn: (sessionId: string) => void): () => void {
  archivedListeners.add(fn);
  return () => archivedListeners.delete(fn);
}
function sessionArchived(id: string): void {
  // Archiving or deleting a chat removes its memory (§chat.memory/log); turning it on again prepares anew.
  removeMemory(id);
  for (const fn of archivedListeners) {
    try {
      fn(id);
    } catch (err) {
      console.error("[sessions] archive listener failed", err);
    }
  }
}

/** The transcript unlink is irreversible: residual tour cleanup must not misreport its outcome. */
async function cleanDeletedTours(id: string): Promise<void> {
  try { await removeSessionTours(id); }
  catch { console.error("[sessions] Deleted chat tour cleanup is pending; a later sweep will retry."); }
}

export const SUBAGENTS_WORKING = "Subagents are working in this session. Stop them or wait for them to finish before archiving.";

export type ArchiveResult =
  // `deleted`: an empty husk's file was deleted instead of archived (the toast says so, with no Undo).
  | { ok: true; summary: SessionSummary & { deleted?: true } }
  | { ok: false; status: 404 | 409; error: string };

/**
 * POST /api/sessions/archive: set or clear the manual archive mark of a web-spawned session.
 * Only Sova's own id list changes; the session file is never touched, except that an empty husk
 * outside any attached org's workspace is deleted (below). Archiving a session
 * that's live in a TUI is refused (it would stay on top anyway), and so is one that's mid-turn or
 * has subagents working (archiving closes its runtime, which would kill them); unarchiving always
 * works.
 */
export async function archiveSession(path: string, archived: boolean): Promise<ArchiveResult> {
  const s = await getSessionSummary(path, await windowResolver());
  if (!s) return { ok: false, status: 404, error: "Session file not found" };
  if (archived && s.live) {
    return { ok: false, status: 409, error: "This session is open in a TUI, so it stays on top while live. Nothing was archived." };
  }
  if (archived && s.origin !== "web") {
    return { ok: false, status: 409, error: "Only sessions started in Sova can be archived. This one is already in the archive." };
  }
  if (archived && isSessionBusy(s.path)) {
    return { ok: false, status: 409, error: "The agent is mid-turn; abort or wait before archiving." };
  }
  // Archiving disposes the held runtime and its subagents die with it, so it waits for them. Read
  // fresh here, never from the summary the browser's list was built on: that list is a poll, and a
  // subagent started since it ran is exactly the one this must not kill.
  if (archived && workingSubagents(s.path) > 0) {
    return { ok: false, status: 409, error: SUBAGENTS_WORKING };
  }
  // An empty husk — no user message anywhere in the file — never shows in the archive (the list
  // skips it), so archiving one deletes the file outright instead of marking an id whose row can
  // never render: same bookkeeping the cleanup "husks" mode does per file. A husk WITH a stored
  // draft is a new session the user is writing in, not an abandoned stub — it archives normally.
  // So does an attached org's workspace session: a fresh baton waiting on its first link is a
  // husk by shape, and baton.json and overseer state name the file, so it is never deleted here.
  // A chat running a command from shell mode is none either: its close saves the command
  // (§chat.shell-mode/lifecycle), so the file is checked again once it closed.
  if (archived && !keptBy(s.path) && !shellInFlight(s.path)) {
    const st = await stat(s.path).catch(() => null);
    if (st && (await isZeroInput(s.path, st.size))) {
      if (!draftCounts(readDrafts()[s.id])) {
        await closeChat(s.path, "Session archived; its runtime was closed.");
        const closed = await stat(s.path).catch(() => null);
        if (closed && !(await isZeroInput(s.path, closed.size))) {
          await markArchived(s.id, s.path);
          return { ok: true, summary: { ...s, archived: true } };
        }
        await unlink(s.path);
        await cleanDeletedTours(s.id);
        dropEntry(s.path);
        setArchived(s.id, false);
        removeWebSession(s.id);
        dropDrafts([s.id]);
        dropSessionTitles([s.id]);
        dropSessionTags([s.id]);
        removeSessionAttachments(s.id);
        removeSessionTimeSpent(s.id);
        removeSessionLabels(s.id);
        dropGroupAssignments([s.id]);
        sessionArchived(s.id);
        return { ok: true, summary: { ...s, archived: true, deleted: true } };
      }
    }
  }
  if (archived) await markArchived(s.id, s.path);
  else if (s.archived) setArchived(s.id, false);
  return { ok: true, summary: { ...s, archived } };
}

/**
 * The one way a session becomes archived (§chat.transcript/instant-open, "An archived chat"): the
 * mark first, so nothing opens it from then on (a tab reconnecting meanwhile is told `closed`), then
 * its chat closed quietly (its open tabs keep what they show and don't reconnect), then what hangs
 * on it ended (its workers stopped with any report still waiting to open it, its links, its memory).
 * A chat still starting now is closed by its own start once that finishes (server/chat-host.ts).
 */
export async function markArchived(id: string, path: string): Promise<void> {
  setArchived(id, true);
  await closeChat(path, "Session archived; its runtime was closed.", { quiet: "archived" });
  await removeOutputFiles(path);
  sessionArchived(id);
}

/**
 * Session id → path, from the listing cache this server already keeps — no disk access at all.
 * Warm after any listing (the sidebar refreshes constantly); empty on a cold start, which is why
 * the one caller falls back to a real walk only for ids it cannot find here, rather than paying
 * for a directory scan on every press of Send.
 */
export function indexedSessionPaths(): ReadonlyMap<string, string> {
  if (idIndex) return idIndex;
  const out = new Map<string, string>();
  for (const [path, entry] of cache) out.set(entry.summary.id, path);
  return (idIndex = out);
}

/** The session id of a session file: the uuidv7 after the last "_" of its name. */
export function idOf(path: string): string {
  return basename(path, ".jsonl").split("_").pop() ?? "";
}

/**
 * True when the file is an empty husk: all of it was read and it holds no user message of any
 * kind and no saved command (readHead stops at the first titling message). A link or wake message,
 * or a command run from shell mode, counts: it never titles the session, but the session is not empty. Never guessed from a head-capped read of a big file,
 * so a session whose first user message sits beyond MAX_HEAD is never treated as empty.
 */
export async function isZeroInput(path: string, size: number): Promise<boolean> {
  if (size > MAX_HEAD) return false;
  const head = await readHead(path);
  return head !== null && !head.input;
}

export type CleanupRequest =
  | { mode: "age"; minAgeDays: number; dryRun: boolean }
  | { mode: "husks"; dryRun: boolean }
  | { mode: "paths"; paths: string[]; dryRun: boolean };

export interface CleanupResult {
  /** Files deleted; 0 on a dry run (deletedIds then holds the candidates). */
  deletedCount: number;
  deletedIds: string[];
  skipped: { live: number; busy: number; recent: number; failed: number };
  /** paths mode only: every path refused with why — nothing deleted for it, and not counted in
   *  skipped, which stays the live/busy/recent/failed vocabulary. */
  refused?: { path: string; reason: string }[];
}

/**
 * POST /api/sessions/cleanup: permanently deletes transcript files from disk — sessions older
 * than minAgeDays (by last write), empty husks, or (mode "paths") the named session files. Live,
 * mid-turn, and just-written sessions are always skipped and counted, whatever the mode; held web
 * runtimes are disposed first, like the archive gesture. The index cache, both id lists, the drafts
 * and the session's attachments folder are updated per deleted file.
 *
 * paths mode is the irreversible second step after archiving: only files carrying the archive
 * mark are deleted, and every path is re-validated with resolveSessionPath (the same validation
 * the route and the archive gesture apply), so a path outside the sessions dir is refused. The
 * rest is refused with the reason in `refused` too: an unarchived session (archive it first), a
 * file that's gone, and a file whose header doesn't parse — never delete what can't be read as
 * a pi session. Every mode leaves an attached org's workspace sessions alone (refused, in paths mode).
 */
export async function cleanupSessions(req: CleanupRequest, opts: { queueChats?: boolean } = {}): Promise<CleanupResult> {
  const targets = req.mode === "paths" ? req.paths : await listSessionFiles();
  const live = readLive();
  const now = Date.now();
  const cutoff = req.mode === "age" ? now - req.minAgeDays * 86_400_000 : 0;
  const skipped = { live: 0, busy: 0, recent: 0, failed: 0 };
  const deletedIds: string[] = [];
  const refusals: { path: string; reason: string }[] = [];
  /** Ids whose file is really gone, so their group assignment goes too (one write after the loop). */
  const forgotten: string[] = [];
  let codingIds: Set<string> | undefined;
  for (const target of targets) {
    // paths mode re-validates what the route already checked, so a direct caller gets the same rule.
    const path = req.mode === "paths" ? resolveSessionPath(target) : target;
    if (!path) {
      refusals.push({ path: target, reason: "Not a session file under the pi sessions dir." });
      continue;
    }
    // An attached org's workspace sessions (batons, project-overseer conversations) belong to the
    // org: baton.json and overseer state name them, so no mode ever deletes one. Silent in the
    // bulk modes, like the Overseer's files, so the dry run's count is what the real run deletes.
    const kept = keptBy(path);
    if (kept) {
      if (req.mode === "paths") refusals.push({ path, reason: kept });
      continue;
    }
    let st;
    try {
      st = await stat(path);
    } catch {
      if (req.mode === "paths") refusals.push({ path, reason: "Session file not found." });
      continue;
    }
    const matches = req.mode === "age" ? st.mtimeMs < cutoff : req.mode === "husks" ? await isZeroInput(path, st.size) : true;
    if (!matches) continue;
    // A project's coding session is empty until the operator's first message (New Coding Session):
    // its build statechart names it, so it is never swept as a husk.
    if (req.mode === "husks" && (codingIds ??= projectCodingIds()).has(idOf(path))) continue;
    // Overseer files (current and history) are never swept by age or as husks: a fresh Overseer
    // is a husk by definition, and its history is pruned by /clear itself (paths mode).
    if (req.mode !== "paths" && (await summarize(path))?.overseer) continue;
    // The merge queue's own chats are kept until the user clears them from the Merge Queue tab's History
    // (`opts.queueChats`, that route's alone): never swept, and refused by an ordinary paths delete.
    if (!opts.queueChats && (await summarize(path))?.queueChat) {
      if (req.mode === "paths") refusals.push({ path, reason: "That is one of the merge queue's own chats: clear it from the Merge Queue tab's History." });
      continue;
    }
    if (live.has(path)) {
      skipped.live++;
      continue;
    }
    // Working subagents count as busy: deleting disposes the runtime, which would kill them. So does
    // a command from shell mode in flight: deleting would stop it and lose it (§chat.shell-mode/lifecycle).
    if (isSessionBusy(path) || workingSubagents(path) > 0 || shellInFlight(path)) {
      skipped.busy++;
      continue;
    }
    if (req.mode === "paths" && !isArchived(idOf(path))) {
      refusals.push({ path, reason: "Not archived — archive it first, then delete it." });
      continue;
    }
    if (now - st.mtimeMs < RECENT_WRITE_MS) {
      skipped.recent++;
      continue;
    }
    if (req.mode === "paths") {
      // Never delete what doesn't read as a pi session: the same header check a summary makes.
      const head = await readHead(path).catch(() => null);
      if (!head || typeof head.header.id !== "string") {
        refusals.push({ path, reason: "Couldn't read its transcript, so nothing was deleted." });
        continue;
      }
    }
    const id = idOf(path);
    if (req.dryRun) {
      deletedIds.push(id);
      continue;
    }
    try {
      await closeChat(path, "Session deleted by archive cleanup; its runtime was closed.");
      // A husk whose close saved a command it ran (§chat.shell-mode/lifecycle) is no husk any more: kept.
      if (req.mode === "husks") {
        const closed = await stat(path).catch(() => null);
        if (closed && !(await isZeroInput(path, closed.size))) {
          skipped.busy++;
          continue;
        }
      }
      await unlink(path);
      await cleanDeletedTours(id);
      dropEntry(path);
      setArchived(id, false);
      removeWebSession(id);
      dropDrafts([id]);
      dropSessionTitles([id]);
      dropSessionTags([id]);
      removeSessionAttachments(id);
      removeSessionTimeSpent(id);
      removeSessionLabels(id);
      sessionArchived(id);
      deletedIds.push(id);
      forgotten.push(id);
    } catch {
      skipped.failed++;
    }
  }
  dropGroupAssignments(forgotten);
  return {
    deletedCount: req.dryRun ? 0 : deletedIds.length,
    deletedIds,
    skipped,
    ...(req.mode === "paths" ? { refused: refusals } : {}),
  };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Distinct existing cwds from the index, most recently used first. */
export async function listCwds(): Promise<string[]> {
  return recentCwds(await listSessions(), overseerDir(), isDir, reservedRoots());
}

/** listCwds over a given list, for the tests. The Overseer's own folder is its state, not a
    project: its files, and anything that was ever started there, never offer it. The same holds for
    every attached org's workspace (`workspaces`) and the org's own conversations there (baton
    sessions, the project overseer); a project's coding sessions still offer the project's folder. */
export function recentCwds(
  list: readonly Pick<SessionSummary, "cwd" | "overseer" | "org">[],
  overseerCwd: string,
  exists: (p: string) => boolean = isDir,
  workspaces: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const hidden = new Set([overseerCwd, ...workspaces]);
  for (const s of list) {
    if (!s.cwd || seen.has(s.cwd) || s.overseer || hidden.has(s.cwd) || (s.org && s.org.kind !== "coding")) continue;
    if (exists(s.cwd)) seen.add(s.cwd);
  }
  return [...seen];
}
