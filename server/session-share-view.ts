import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { stripImageNotes } from "../shared/image-note";
import { parseLinkMessage } from "../shared/link-message";
import {
  SESSION_SHARE_EXCERPT_MAX,
  SESSION_SHARE_IMAGE_MAX_BYTES,
  SESSION_SHARE_IMAGE_TYPES,
  SESSION_SHARE_PAGE,
  type SessionShareImageRef,
  type SessionShareItem,
  type SessionShareMode,
  type SessionShareOutline,
  type SessionShareSpan,
  type SessionShareView,
} from "../shared/session-share";
import { parseWakeNudge } from "../shared/wake";
import { serverRedactor } from "./overseer-redact";
import { parseLines, type Entry } from "./transcript";

/**
 * The session share view (§app/session-share/content, /never): a session's branch reduced to what a
 * share link's holder may read. An ALLOWLIST over raw entries, built field by field, never a
 * TranscriptItem passed along: user messages (their text and images) and the assistant's reply
 * text (markdown, `vis` fences included). Thinking, tool calls and results, `!` commands, system
 * and custom messages, compactions, model and thinking changes, usage, every custom card, wake
 * nudges and link partners' messages are dropped because nothing here names them. Every string
 * passes the server's secret redactor; the session's cwd becomes relative and the home directory
 * `~`; image paths (/tmp, attachments) leave the text.
 *
 * Images are never inlined: an item names them by index (`images: [{n, mime}]`), the n-th image
 * block embedded in a shown message on the shared branch, in order, and the image route serves one
 * (`sessionShareImage`). Only the four raster types; never a file named by a path.
 *
 * A slice (§app.session-share/slice) is cut from the branch BEFORE anything is built
 * (`sliceBranch`), so item numbers, image indices and pages are the slice's own, and nothing before
 * its start is ever read into a view.
 */

/** What the view needs of a share (server/session-shares.ts's record). `cutEntryId` null: live,
    the session's current branch. `from`: the slice's first entry; null, from the first message. */
export interface ShareSource {
  sessionPath: string;
  cutEntryId: string | null;
  from: string | null;
  title: string;
  sharedAt: string;
  mode: SessionShareMode;
  /** The share's id, for a recipient's view: its views then carry a `lineage`. */
  lineageKey?: string;
}

type ImageBlock = { data: string; mime: string };

interface Built {
  items: SessionShareItem[];
  /** Each item's entry id, by `n` (operator-only: the outline). */
  ids: string[];
  images: ImageBlock[];
  through: string | null;
  earlier: boolean;
}

const IMAGE_TYPES: ReadonlySet<string> = new Set(SESSION_SHARE_IMAGE_TYPES);

/** Parsed files, re-read only when their size or mtime changed (a live share reads on each append). */
const parsed = new Map<string, { size: number; mtimeMs: number; entries: Entry[] }>();

async function entriesOf(path: string): Promise<Entry[] | null> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const had = parsed.get(path);
  if (had && had.size === st.size && had.mtimeMs === st.mtimeMs) return had.entries;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const entries = parseLines(text);
  parsed.set(path, { size: st.size, mtimeMs: st.mtimeMs, entries });
  return entries;
}

/**
 * The branch a share shows, chosen strictly (§app.session-share/never): root → `cutEntryId`, or,
 * with no cut, root → the file's last entry that has an id (the leaf, as activeBranch takes it).
 * Unlike transcript.ts's forgiving activeBranch, an id-less record never turns a branched file into
 * one flat list (every abandoned branch included): it is ignored. A genuine pre-id file (no entry
 * has an id, no header of version 2 or later) is linear, as transcript.ts reads it, and has no cut.
 * null, anything ambiguous: a cut not in the file, two entries with one id, a parent that isn't
 * there, a cycle.
 */
export function branchTo(entries: Entry[], cutEntryId: string | null): Entry[] | null {
  const body = entries.filter((e) => e.type !== "session");
  const withId = body.filter((e) => typeof e.id === "string" && e.id);
  if (!withId.length) {
    const version = entries.find((e) => e.type === "session")?.version;
    return cutEntryId || (typeof version === "number" && version >= 2) ? null : body;
  }
  const byId = new Map<string, Entry>();
  for (const e of withId) {
    if (byId.has(e.id)) return null;
    byId.set(e.id, e);
  }
  let cur = byId.get(cutEntryId ?? withId.at(-1)!.id);
  if (!cur) return null;
  const path: Entry[] = [];
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    path.push(cur);
    const parent: unknown = cur.parentId;
    if (parent === null) break;
    if (typeof parent !== "string") return null;
    cur = byId.get(parent);
    if (!cur) return null;
  }
  return path.reverse();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A text scrubber: secrets out, then the session's cwd relative and the home directory `~`. */
function scrubberFor(cwd: string | undefined): (text: string) => string {
  const secrets = serverRedactor();
  const home = homedir();
  const rules: [RegExp, string][] = [];
  // Standalone only: never the tail of a longer path, never a longer name's head.
  const at = (p: string) => `(?<![\\w./~-])${escapeRe(p.replace(/\/+$/, ""))}`;
  if (cwd && cwd !== "/" && cwd.startsWith("/")) {
    rules.push([new RegExp(`${at(cwd)}/`, "g"), ""]);
    rules.push([new RegExp(`${at(cwd)}(?![\\w.-])`, "g"), "."]);
  }
  if (home && home !== "/") rules.push([new RegExp(`${at(home)}(?![\\w.-])`, "g"), "~"]);
  return (text: string) => {
    let out = secrets.redact(text);
    for (const [re, to] of rules) out = out.replace(re, to);
    return out;
  };
}

const textBlocks = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
};

/** A message's own image blocks, only the served raster types. */
function imageBlocks(content: unknown): ImageBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ImageBlock[] = [];
  for (const b of content)
    if (b && b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string" && IMAGE_TYPES.has(b.mimeType)) out.push({ data: b.data, mime: b.mimeType });
  return out;
}

/** The most characters of one item's text as sent; a longer one is cut, ending in "…", after
    every scrub. */
export const SESSION_SHARE_TEXT_MAX = 256 * 1024;
/** The most characters of one message's text read at all: the bound on every scrub's work. */
export const SESSION_SHARE_TEXT_CEILING = 4 * SESSION_SHARE_TEXT_MAX;

/** What ends a path token: whitespace, quotes, backticks, brackets and separators. */
const STOP = /[\s`'"<>()[\]{},;]/;

/**
 * `text` cut to at most `max` characters and then back to the last token boundary (a STOP
 * character), ending in "…": a cut never leaves part of a path, a generated name or a secret for
 * a scrubber to miss; a token longer than what is left goes whole. STOP characters are ASCII, so
 * no surrogate pair is split. Linear.
 */
export function cutAtToken(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  while (end > 0 && !STOP.test(text[end]!)) end--;
  return `${text.slice(0, end)}…`;
}
/** A /tmp image's name, matched at the character after "/tmp/" (sticky: no scan). */
const TMP_NAME = /[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif)(?![A-Za-z0-9_])/iy;
/** A generated paste or upload name on its own (fixed length after its prefix: linear). */
const PASTE_NAME = /(?:pi-(?:clipboard|wsl-clip)|sova)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|webp|gif)(?![A-Za-z0-9_])/gi;
const ATTACHMENTS = "/sova/attachments/";
/** What stands in for an image path inside code, or anywhere it isn't a word of its own. */
export const IMAGE_PATH_STAND_IN = "[image]";

/**
 * `text` without the image paths it names, wherever they stand, prose, inline code, fences and vis
 * source alike: a pasted image's path says where a file sits on this host. A path is an image in
 * /tmp, or a whole token containing an attachments folder (absolute, `~` or relative); then a
 * generated paste name left on its own. A path that is a word of its own (whitespace or the text's
 * edge on both sides) is removed with one space before it (the image block stands for a pasted
 * one); any other becomes IMAGE_PATH_STAND_IN. Linear: each literal is found with indexOf, and a
 * token is widened by hand, never past the previous replacement.
 */
export function withoutImagePaths(text: string): string {
  const hits: [number, number][] = [];
  for (const lit of [ATTACHMENTS, "/tmp/"]) {
    let floor = 0;
    for (let i = text.indexOf(lit); i >= 0; i = text.indexOf(lit, Math.max(i + 1, floor))) {
      let left = i;
      let right: number;
      if (lit === ATTACHMENTS) {
        while (left > floor && !STOP.test(text[left - 1]!)) left--;
        right = i + lit.length;
        while (right < text.length && !STOP.test(text[right]!)) right++;
      } else {
        TMP_NAME.lastIndex = i + lit.length;
        if (!TMP_NAME.exec(text)) continue;
        right = TMP_NAME.lastIndex;
      }
      hits.push([left, right]);
      floor = right;
    }
  }
  let out = text;
  if (hits.length) {
    // An attachments token may hold a /tmp path: keep the outer of overlapping hits.
    hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    out = "";
    let at = 0;
    for (const [l, r] of hits) {
      if (l < at) continue;
      const alone = (l === 0 || /\s/.test(text[l - 1]!)) && (r === text.length || /\s/.test(text[r]!));
      const from = alone && l > at && text[l - 1] === " " ? l - 1 : l;
      out += text.slice(at, from) + (alone ? "" : IMAGE_PATH_STAND_IN);
      at = r;
    }
    out += text.slice(at);
  }
  return out.replace(PASTE_NAME, IMAGE_PATH_STAND_IN);
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An entry's time as a canonical ISO time, or undefined: only a whole ISO 8601 time that parses
    goes out, re-written, never the string as the file has it. */
export function canonicalTime(t: unknown): string | undefined {
  if (typeof t !== "string" || !ISO_TIME.test(t)) return undefined;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * The branch from `from` on: the suffix of `branch` that starts at that entry, or the whole branch
 * when `from` is null. null when `from` isn't on the branch (a rewind above it, another branch, a
 * start after the cut): the share then reads as gone. Pure.
 */
export function sliceBranch(branch: Entry[], from: string | null): Entry[] | null {
  if (from === null) return branch;
  const at = branch.findIndex((e) => e.id === from);
  return at < 0 ? null : branch.slice(at);
}

/** A message the view shows, before any scrub: its entry, role, unscrubbed text and images. */
interface Shown {
  e: Entry;
  role: "user" | "assistant";
  text: string;
  blocks: ImageBlock[];
}

/**
 * The messages of `branch` a view shows, in order, decided before any scrub (so a count or span is
 * cheap): user and assistant messages with text or an image, not a wake nudge or a link partner's
 * message. Pure.
 */
export function shownEntries(branch: Entry[]): Shown[] {
  const out: Shown[] = [];
  for (const e of branch) {
    if (e.type !== "message") continue;
    const m = e.message ?? {};
    const role = m.role;
    if (role !== "user" && role !== "assistant") continue;
    const raw = cutAtToken(textBlocks(m.content), SESSION_SHARE_TEXT_CEILING);
    // Not the user's words: a wake nudge, a link partner's message.
    if (role === "user" && (parseWakeNudge(raw) || parseLinkMessage(raw))) continue;
    const text = withoutImagePaths(role === "user" ? stripImageNotes(raw, m.content) : raw).trim();
    const blocks = imageBlocks(m.content);
    if (!text && !blocks.length) continue;
    out.push({ e, role, text, blocks });
  }
  return out;
}

/** `slice` is the branch as built; `earlier`, whether the slice dropped a shown message. */
function build(entries: Entry[], slice: Entry[], earlier: boolean): Built {
  const header = entries.find((e) => e.type === "session");
  const scrub = scrubberFor(typeof header?.cwd === "string" ? header.cwd : undefined);
  const items: SessionShareItem[] = [];
  const ids: string[] = [];
  const images: ImageBlock[] = [];
  const refs = (blocks: ImageBlock[]): SessionShareImageRef[] | undefined =>
    blocks.length ? blocks.map((b) => ({ n: images.push(b) - 1, mime: b.mime })) : undefined;
  let through: string | null = null;
  for (const e of slice) {
    const at = canonicalTime(e.timestamp);
    if (at) through = at;
  }
  for (const { e, role, text, blocks } of shownEntries(slice)) {
    const at = canonicalTime(e.timestamp);
    const imgs = refs(blocks);
    ids.push(typeof e.id === "string" ? e.id : "");
    items.push({ kind: role === "user" ? "user" : "reply", n: items.length, text: cutAtToken(scrub(text), SESSION_SHARE_TEXT_MAX), ...(at ? { at } : {}), ...(imgs ? { images: imgs } : {}) });
  }
  return { items, ids, images, through, earlier };
}

type Src = Pick<ShareSource, "sessionPath" | "cutEntryId" | "from">;

/** Per share, the lineage its views were last built in, and that view's start and last entry. */
const lineages = new Map<string, { id: string; from: string | null; tip: string | null }>();

/**
 * The share's lineage for a view of `slice`: kept only while the slice extends the last one built
 * (same start, and that view's last entry still on it), so every view of a lineage extends every
 * earlier one and an item's number always names the same message; else a new random id (a moved
 * start, a rewind, an end moved back or onto another branch). Opaque: nothing of the session is in
 * it. A stale or out-of-order build can only start a new lineage (a spare reset), never keep one.
 */
function lineageOf(key: string, from: string | null, slice: Entry[]): string {
  const ids = new Set<string>();
  for (const e of slice) if (typeof e.id === "string") ids.add(e.id);
  const prev = lineages.get(key);
  const same = !!prev && prev.from === from && (prev.tip === null || ids.has(prev.tip));
  const id = same ? prev!.id : randomBytes(9).toString("base64url");
  lineages.set(key, { id, from, tip: [...ids].at(-1) ?? null });
  return id;
}

/** The strict branch and its slice, or null (gone). */
async function sliced(src: Src): Promise<{ entries: Entry[]; branch: Entry[]; slice: Entry[] } | null> {
  const entries = await entriesOf(src.sessionPath);
  if (!entries) return null;
  const branch = branchTo(entries, src.cutEntryId);
  const slice = branch && sliceBranch(branch, src.from);
  return slice ? { entries, branch, slice } : null;
}

async function built(src: Src & { lineageKey?: string }): Promise<(Built & { lineage?: string }) | null> {
  const got = await sliced(src);
  if (!got) return null;
  const earlier = shownEntries(got.branch.slice(0, got.branch.length - got.slice.length)).length > 0;
  const made = build(got.entries, got.slice, earlier);
  return src.lineageKey ? { ...made, lineage: lineageOf(src.lineageKey, src.from, got.slice) } : made;
}

/**
 * The view a share's holder reads (and the operator's Preview: the same function, no token).
 * The newest SESSION_SHARE_PAGE items, or those before item `before`. null: the session file is
 * gone or unreadable, or the snapshot's cut is no longer in it (a migrated or replaced file).
 */
export async function sessionShareView(src: ShareSource, opts: { before?: number | null } = {}): Promise<SessionShareView | null> {
  const b = await built(src);
  if (!b) return null;
  const before = opts.before;
  const end = typeof before === "number" && Number.isSafeInteger(before) ? Math.max(0, Math.min(before, b.items.length)) : b.items.length;
  const start = Math.max(0, end - SESSION_SHARE_PAGE);
  return {
    title: serverRedactor().redact(src.title),
    sharedAt: src.sharedAt,
    mode: src.mode,
    through: b.through,
    items: b.items.slice(start, end),
    ...(start > 0 ? { before: start } : {}),
    images: b.images.length,
    ...(b.earlier ? { earlier: true as const } : {}),
    ...(b.lineage ? { lineage: b.lineage } : {}),
  };
}

/**
 * The share page's picker (operator only): every message the whole session shows at `cutEntryId`,
 * as a scrubbed excerpt with its entry id. null: as the view's null.
 */
export async function sessionShareOutline(src: Pick<ShareSource, "sessionPath"> & { cutEntryId: string }): Promise<SessionShareOutline | null> {
  const b = await built({ sessionPath: src.sessionPath, cutEntryId: src.cutEntryId, from: null });
  if (!b) return null;
  return {
    cut: src.cutEntryId,
    items: b.items.map((it, i) => ({
      id: b.ids[i]!,
      n: it.n,
      kind: it.kind,
      ...(it.at ? { at: it.at } : {}),
      excerpt: cutAtToken(it.text.replace(/\s+/g, " ").trim(), SESSION_SHARE_EXCERPT_MAX),
      images: it.images?.length ?? 0,
    })),
  };
}

/**
 * Where a sliced share sits among the messages the whole view shows, 1-based: `first` its first
 * message, `last` its last (null while live), `total` those the session's current branch shows.
 * undefined: a whole-session share, or one that no longer reads.
 */
export async function shareSpan(src: Src): Promise<SessionShareSpan | undefined> {
  if (src.from === null) return undefined;
  const got = await sliced(src);
  if (!got) return undefined;
  const before = shownEntries(got.branch.slice(0, got.branch.length - got.slice.length)).length;
  const current = src.cutEntryId === null ? got.branch : branchTo(got.entries, null);
  return {
    first: before + 1,
    last: src.cutEntryId === null ? null : before + shownEntries(got.slice).length,
    total: current ? shownEntries(current).length : 0,
  };
}

/** Magic bytes: served only as the raster image it really is. */
function sniff(b: Uint8Array): string | null {
  const eq = (offset: number, ...bytes: number[]) => bytes.every((x, i) => b[offset + i] === x);
  if (b.length >= 8 && eq(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (b.length >= 3 && eq(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 12 && eq(0, 0x52, 0x49, 0x46, 0x46) && eq(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (b.length >= 6 && eq(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  return null;
}

/**
 * Image `n` of the shared branch, as its sniffed type and bytes, or null: no such image, over
 * SESSION_SHARE_IMAGE_MAX_BYTES, or not really a png, jpeg, webp or gif.
 */
export async function sessionShareImage(src: Src, n: number): Promise<{ mime: string; bytes: Buffer } | null> {
  if (!Number.isSafeInteger(n) || n < 0) return null;
  const img = (await built(src))?.images[n];
  if (!img || img.data.length > Math.ceil(SESSION_SHARE_IMAGE_MAX_BYTES / 3) * 4 + 4) return null;
  const bytes = Buffer.from(img.data, "base64");
  if (!bytes.length || bytes.length > SESSION_SHARE_IMAGE_MAX_BYTES) return null;
  const mime = sniff(bytes);
  return mime ? { mime, bytes } : null;
}

/** The session's current leaf (the strict branch's last entry; a rewind's marker pins it) and its
    time: what a snapshot's cut is set to at mint and on Update to now. null: no file, or empty. */
export async function currentLeaf(sessionPath: string): Promise<{ entryId: string; at: string | null } | null> {
  const entries = await entriesOf(sessionPath);
  const leaf = entries ? branchTo(entries, null)?.at(-1) : undefined;
  if (!leaf || typeof leaf.id !== "string") return null;
  return { entryId: leaf.id, at: canonicalTime(leaf.timestamp) ?? null };
}

/** A source's bounds, when it reads (else null): the time of its newest entry (a snapshot's cut
    time) and of its start entry (null with no start, or no canonical time). */
export async function sliceBounds(src: Src): Promise<{ through: string | null; fromAt: string | null } | null> {
  const got = await sliced(src);
  if (!got) return null;
  let through: string | null = null;
  for (const e of got.slice) through = canonicalTime(e.timestamp) ?? through;
  return { through, fromAt: src.from === null ? null : (canonicalTime(got.slice[0]?.timestamp) ?? null) };
}

/** Whether a share still reads: its file is there and parses, its branch (the cut's, or the
    current one) is unambiguous, and a slice's start is on it. false is the view's null: the dead
    page, and its sockets close. */
export async function sourceReadable(src: Src): Promise<boolean> {
  return (await sliced(src)) !== null;
}

/** Forget parsed files (tests). */
export function resetShareViewCache(): void {
  parsed.clear();
  lineages.clear();
}
