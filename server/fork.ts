import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CURRENT_SESSION_FORMAT, type ForkEditor, type ForkRefusal, type ForkRefusalCode, type ForkRequest, type ForkResult, type SessionSummary, type TmpAttachment } from "../shared/protocol";
import { stripImageNotes } from "../shared/image-note";
import { inlineTmpImages, MAX_ATTACHMENT_BYTES } from "./attachments";
import { activeConfigFailure, FANOUT_MEMBER_ENTRY, heldChat } from "./chat-manager";
import { readLive } from "./live";
import { canonicalPath, resolveSessionPath, sessionPathShape } from "./paths";
import { getSessionSummary } from "./sessions-index";
import { readActiveBranch } from "./transcript";
import { addWebSession } from "./web-sessions";
import { markOwned, recentForeignWriteAgeSec } from "./write-guard";

/**
 * POST /api/sessions/fork — the per-message Fork action: ONE new session branched off ONE entry of
 * another, in no group, with no first message.
 *
 * It is deliberately not a one-member fanout. Fanout's contract is a GROUP with a shared seed, a
 * member marker that turns the topic outline off, and a model per member; none of that belongs to
 * a fork the user asked for from a message, and inheriting it would give the child a workspace and
 * a loadout nobody chose. What IS shared with fanout is the part that was hard to get right, and
 * it is shared by reusing the reasoning rather than the code path: a BARE SessionManager (never a
 * held runtime's — `createBranchedSession` rebinds the manager it is called on), the old-format
 * refusal as a PRECONDITION (open() migrating a file would look like a foreign write to a runtime
 * we hold), and the same refusal spellings so one copy deck covers both.
 */

const HEAD_BYTES = 16 * 1024;

const refusal = (path: string, code: ForkRefusalCode, message: string): ForkRefusal => ({ path, code, message });

export type ForkOutcome =
  | { ok: true; result: ForkResult }
  | { ok: false; status: 400 | 404 | 500; error: string }
  | { ok: false; status: 409; refused: ForkRefusal };

/** A session entry as our own parser returns it. */
type Entry = Record<string, any>;

/**
 * Everything outside the rules, injected so they can be driven without a disk or an SDK. As in
 * `FanoutDeps`, EACH COMMENT IS A SPECIFICATION a fake is written against.
 */
export interface ForkDeps {
  /** The source path as this server keys sessions, or null when it is not a session file here. */
  resolveSource(raw: string): string | null;
  /** The header's format version, or null when the file is unreadable or headerless. */
  sourceVersion(path: string): Promise<number | null>;
  /** The source's ACTIVE branch, root-first — the entries Sova RENDERS. After a rewind the
      file's tail is the abandoned branch, so "the last lines of the file" is a different and
      wrong list (see server/transcript.ts activeBranch). */
  branch(path: string): Promise<Entry[]>;
  live(path: string): boolean;
  streaming(path: string): boolean;
  foreignWriter(path: string): boolean;
  misconfigured(path: string): boolean;
  /** Branch a new session off `path` through `leafId`, on a manager of its own, and do the
      bookkeeping every web-owned session needs. Returns the canonical path of the new file. */
  branchOff(path: string, leafId: string): Promise<string>;
  /** Remove a half-made child after a later step failed. */
  discard(path: string): void;
  summary(path: string): Promise<SessionSummary | null>;
}

/** Read just the header's version without loading the file. */
async function readVersion(path: string): Promise<number | null> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    await fh.read(head, 0, head.length, 0);
    const firstLine = head.toString("utf8").split("\n", 1)[0] ?? "";
    const header = JSON.parse(firstLine) as { type?: string; version?: unknown };
    if (header?.type !== "session") return null;
    return typeof header.version === "number" ? header.version : 1; // pre-versioning files
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

export const realForkDeps: ForkDeps = {
  resolveSource(raw) {
    if (!sessionPathShape(raw)) return null;
    const path = resolveSessionPath(raw);
    return path && existsSync(path) ? path : null;
  },
  sourceVersion: readVersion,
  branch: (path) => readActiveBranch(path),
  live: (path) => readLive().get(path) !== undefined,
  streaming: (path) => {
    const chat = heldChat(path);
    return !!chat && chat.session.isStreaming;
  },
  foreignWriter: (path) => {
    const chat = heldChat(path);
    return chat ? chat.hasForeignWrites() : recentForeignWriteAgeSec(path) !== null;
  },
  misconfigured: (path) => activeConfigFailure(path) !== undefined,

  /**
   * ONE FRESH MANAGER, never the one Sova holds for the source: `createBranchedSession` REBINDS
   * the manager it is called on to the new file, so calling it on a live runtime's manager would
   * repoint that runtime at the child and land the user's next turn in the fork's transcript.
   * A bare manager is also what keeps the SDK's construction-time model/thinking appends out of
   * the SOURCE — `createAgentSession` would write them there before the branch was taken.
   */
  async branchOff(path, leafId) {
    const sm = SessionManager.open(path);
    const created = sm.createBranchedSession(leafId);
    if (!created) throw new Error("Branching produced no session file");
    // `createBranchedSession` copies the branch ENTRY BY ENTRY, and a fanout member's marker is an
    // ordinary `custom` entry ON that branch — so forking a fanout member hands the child the
    // marker, and `isFanoutMember` then opens it with the topic outline OFF. A fork is an ordinary
    // chat; inheriting a loadout nobody chose is exactly the kind of failure that is invisible
    // (the child lists, opens and reads perfectly, it just quietly stops summarizing). Strip it.
    const entries = stripFanoutMarker(sm.getEntries());
    const header = sm.getHeader();
    // Written whole whenever the marker had to go, and when the SDK deferred the file (it writes a
    // branch immediately only if it contains an assistant message). `wx` on the create path; a
    // rewrite of the file we have just made is ours to make.
    if (!existsSync(created)) {
      writeFileSync(created, `${[JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join("\n")}\n`, { flag: "wx" });
    } else if (entries.length !== sm.getEntries().length) {
      writeFileSync(created, `${[JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join("\n")}\n`);
    }
    const canonical = canonicalPath(created);
    markOwned(canonical); // the fresh mtime is ours, not a foreign writer's
    const id = canonical.replace(/\.jsonl$/, "").split("_").pop() ?? "";
    if (id) addWebSession(id); // origin "web": the child opens for chat without a "recent" refusal
    return canonical;
  },

  discard(path) {
    try {
      unlinkSync(path);
    } catch {
      // already gone, or never written
    }
  },
  summary: (path) => getSessionSummary(path),
};

/**
 * The branch without any fanout member marker, RE-CHAINED so nothing is orphaned.
 *
 * Dropping an entry from a parent-linked list is not a filter: every later entry on the branch is
 * a child of something, and removing a link in the middle would leave the rest hanging off an id
 * that is no longer in the file — which `activeBranch`'s parentId walk stops at, so the child's
 * transcript would silently lose everything before the gap. Same re-chaining the SDK itself does
 * when it strips label entries in `createBranchedSession`.
 */
export function stripFanoutMarker(entries: readonly Entry[]): Entry[] {
  if (!entries.some((e) => e.type === "custom" && e.customType === FANOUT_MEMBER_ENTRY)) return [...entries];
  const out: Entry[] = [];
  let parentId: string | null = null;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === FANOUT_MEMBER_ENTRY) continue; // its children re-parent onto its own parent
    out.push({ ...entry, parentId });
    parentId = entry.id;
  }
  return out;
}

/** Validate the request body. Pure, so every 400 is testable without a disk. */
export function planFork(body: ForkRequest): { ok: true } | { ok: false; error: string } {
  if (typeof body?.path !== "string" || !body.path) return { ok: false, error: "path must be a session file path" };
  if (typeof body?.entryId !== "string" || !body.entryId) return { ok: false, error: "entryId must be a transcript entry id" };
  if (body?.position !== "before" && body?.position !== "at") return { ok: false, error: 'position must be "before" or "at"' };
  return { ok: true };
}

/**
 * The entry a row id names, on the ACTIVE branch.
 *
 * The transcript emits one row per assistant content block (`<entryId>:<n>`, plus `<entryId>:stop`
 * for an aborted or errored reply), so the id a client rendered is often not an entry id. An id
 * that is not on the branch is retried once with everything from its first ":" removed; entry ids
 * are uuids and carry no colon, so this can only rescue a block id and can never turn one entry's
 * id into another's.
 */
export function findOnBranch(branch: readonly Entry[], entryId: string): { entry: Entry; index: number } | null {
  let index = branch.findIndex((e) => e.id === entryId);
  if (index === -1 && entryId.includes(":")) {
    const stem = entryId.slice(0, entryId.indexOf(":"));
    index = branch.findIndex((e) => e.id === stem);
  }
  return index === -1 ? null : { entry: branch[index]!, index };
}

/**
 * What the new session's composer starts with, for a "before" fork of a USER entry: the message
 * itself, ready to edit and send again — text, the image files it named, and the image bytes it
 * carried. Nothing is sent.
 *
 * The three parts are not interchangeable. `text` is the DISPLAY text (pi-clipboard paths stripped
 * exactly as `TranscriptItem.text` strips them) because `attachments` stands in for those paths
 * and the composer writes them back on send — handing over the raw text as well as the chips would
 * send every path twice. `images` are the stored `ImageContent` bytes, which live nowhere in the
 * text at all and would otherwise be silently dropped: the approved difference from `rewound`,
 * which hands back text only.
 */
export function editorFor(entry: Entry, readBytes: (path: string) => Buffer | null = readIfPresent): ForkEditor | undefined {
  if (entry?.type !== "message" || entry.message?.role !== "user") return undefined;
  const content = entry.message?.content;
  // Without pi 0.87's image resize notes: the images come along, and sending them again adds new ones.
  const raw = typeof content === "string" ? content : stripImageNotes(textOf(content), content);
  const { text, attachments } = inlineTmpImages(raw, true);
  const stored = imageBlobs(content);

  // THE TWO CHANNELS MUST NOT OVERLAP, and "they probably don't" is not good enough: an image that
  // arrives as BOTH a staged file and re-uploaded bytes is attached twice, and one that arrives as
  // neither is lost with the composer claiming otherwise. They are told apart by CONTENT, not by
  // assuming a message never carries a path and its own bytes: every still-readable attachment is
  // hashed, and a stored block with the same hash is dropped from `images` because the FILE is the
  // better carrier (it survives as a real draft attachment). At most MAX_ATTACHMENTS_PER_ROW reads
  // on a rare, deliberate action.
  const staged = new Set<string>();
  for (const a of attachments ?? []) {
    if (!a.available) continue; // gone from disk: no bytes to compare, and nothing to stage
    const bytes = readBytes(a.path);
    if (bytes) staged.add(sha256(bytes));
  }
  const images = stored.filter((b) => !staged.has(b.hash)).map((b) => b.dataUrl);

  const editor: ForkEditor = {};
  if (text !== undefined && text !== "") editor.text = text;
  // Unavailable entries are KEPT, deliberately: they are the only record that an image was part of
  // this message, and the client needs them to say "1 image couldn't come along" instead of
  // silently dropping it. Filtering them here would make the omission invisible on both sides.
  if (attachments?.length) editor.attachments = attachments as TmpAttachment[];
  if (images.length) editor.images = images;
  return editor.text || editor.attachments || editor.images ? editor : undefined;
}

/** The file's bytes, or null when it is gone/unreadable/too large. Never throws: an unreadable
    attachment is an absent one, which the `available` flag already reports. */
function readIfPresent(path: string): Buffer | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_ATTACHMENT_BYTES) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

const sha256 = (b: Buffer | Uint8Array): string => createHash("sha256").update(b).digest("hex");

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
}

/** Stored ImageContent blocks, in order, as a data URL plus the hash of their decoded bytes —
    the hash is what tells a stored block apart from a file already being staged for it. */
function imageBlobs(content: unknown): { dataUrl: string; hash: string }[] {
  if (!Array.isArray(content)) return [];
  const out: { dataUrl: string; hash: string }[] = [];
  for (const b of content) {
    if (b?.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
      out.push({ dataUrl: `data:${b.mimeType};base64,${b.data}`, hash: sha256(Buffer.from(b.data, "base64")) });
    }
  }
  return out;
}

/**
 * The guards a fork must pass before the source is opened. Same shape and the same sentences as
 * fanout's `checkSource`, minus the leaf comparison (a fork names its own entry, so there is
 * nothing to be stale against) and plus the two that are this route's own.
 */
export async function checkForkSource(path: string, deps: ForkDeps): Promise<ForkRefusal | null> {
  if (deps.live(path)) return refusal(path, "tui-live", "It is open in a terminal, so this server must not read it out from under that process.");
  if (deps.streaming(path)) return refusal(path, "mid-turn", "It is mid-turn here. Wait for the turn to finish, then fork.");
  if (deps.foreignWriter(path)) return refusal(path, "busy", "Another process wrote to it just now.");
  if (deps.misconfigured(path)) return refusal(path, "config", "Its working directory is gone, so it cannot be opened.");
  const version = await deps.sourceVersion(path);
  if (version === null) return refusal(path, "missing", "Its session file could not be read.");
  // A rewrite-on-open would look like a foreign write to a runtime we hold for this session and
  // lock the user out of their own chat, so the version is a PRECONDITION, never a recovery.
  if (version !== CURRENT_SESSION_FORMAT)
    return refusal(path, "old-format", "It is in an older session format. Open it for chat once to update it, then fork.");
  return null;
}

/**
 * Fork one session at one entry.
 *
 * Rollback boundary: everything that can refuse is settled BEFORE the child file exists, and a
 * failure after it exists unlinks it — a header with no session behind it is a sidebar row that
 * opens onto nothing. There is no partial success to report: either one session was made, or none
 * was and the caller gets a reason.
 */
export async function runFork(body: ForkRequest, deps: ForkDeps = realForkDeps): Promise<ForkOutcome> {
  const plan = planFork(body);
  if (!plan.ok) return { ok: false, status: 400, error: plan.error };

  const path = deps.resolveSource(body.path);
  if (!path) return { ok: false, status: 404, error: "Session file not found" };
  const refused = await checkForkSource(path, deps);
  if (refused) return { ok: false, status: 409, refused };

  const branch = await deps.branch(path);
  const found = findOnBranch(branch, body.entryId);
  if (!found)
    return {
      ok: false,
      status: 409,
      refused: refusal(path, "not-on-branch", "That message is not on this session's current branch anymore."),
    };

  // "before" = pi's /fork: the child holds everything UP TO the entry's parent, and the entry
  // itself comes back for the composer. "at" = pi's /clone: the child holds the entry too.
  const leafId = body.position === "at" ? found.entry.id : found.entry.parentId;
  if (typeof leafId !== "string" || !leafId)
    return {
      ok: false,
      status: 409,
      refused: refusal(path, "nothing-before", "That is the first message in the session, so there is nothing before it to fork from."),
    };

  const editor = body.position === "before" ? editorFor(found.entry) : undefined;

  let created: string | null = null;
  try {
    created = await deps.branchOff(path, leafId);
    const session = await deps.summary(created);
    if (!session) throw new Error("the new session could not be read back");
    return { ok: true, result: { session, ...(editor ? { editor } : {}) } };
  } catch (err) {
    if (created) deps.discard(created); // its own debris only; the source is never touched
    return { ok: false, status: 500, error: (err instanceof Error ? err.message : String(err)) || "The fork could not be created" };
  }
}
