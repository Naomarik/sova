// Fork a conversation through a delivered assistant reply: a NEW ordinary web-owned session
// file holding the active branch's entries through the selected assistant message — nothing
// later, nothing from abandoned branches, and none of the source's transient worker/team
// registry or wake-schedule state. The SOURCE file is never opened with the SDK: SessionManager.open()/
// forkFrom()/createBranchedSession() can all write to it (loadEntriesFromFile appends "\n" to a
// torn trailing line; a version migration rewrites the whole file; createBranchedSession
// rewrites itself). This module reads the file once with readFileSync, parses it STRICTLY (a
// torn or malformed line is a refusal, not a silently skipped entry), and writes the fork's
// bytes itself.
//
// The active branch is the parentId ancestry of the file's LAST entry — the rule the SDK's
// _buildIndex uses on open, and the one rewind markers depend on: a rewind appends an invisible
// custom entry parented on the new leaf, so the file's last entry is always the active leaf,
// whatever was abandoned above it. A cycle or a dangling parent link in that ancestry is a
// refusal, never a partial copy.
//
// The fork's header is minted by a DISCARDED SessionManager.create() (fresh uuidv7 id, the
// current header version, the parentSession reference, the source's own session dir and file
// naming); that instance never persists. The copied history stays verbatim except for spliced
// registry entries and runtime wake metadata. A new non-context entry records cache affinity
// in the fork only.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { canonicalPath } from "./paths";
import { FORK_CACHE_ENTRY, forkCacheData } from "./session-fork-cache";
import { FANOUT_MEMBER_ENTRY } from "./chat-manager";
import { LEGACY_REGISTRY_ENTRY_TYPE, WORKER_MANIFEST_ENTRY_TYPE } from "../pi-config/extensions/subagents/worker-transcript.ts";

/** The session format this module copies. A newer or older header is refused, never guessed. */
const SESSION_VERSION = 3;

/** A refusal's HTTP status, bounded so Hono's c.json(obj, status) typechecks. */
export type ForkStatus = 400 | 403 | 404 | 409 | 500;

/** Why a fork was refused. */
export type ForkRefusal =
  | "not_found" // the source file is gone
  | "invalid" // not a readable v3 session file (torn line, bad ids, broken or cyclic ancestry)
  | "unsupported" // a source this version refuses (legacy fanout member)
  | "not_on_branch" // the entry is not on the active branch (abandoned or unknown)
  | "not_assistant" // the entry is not an assistant reply
  | "tool_boundary" // the copied context would carry a tool call without its result
  | "internal";

export type ForkOutcome =
  | { ok: true; path: string; sessionId: string; cwd: string }
  | { ok: false; reason: ForkRefusal; message: string; status: ForkStatus };

/** One parsed non-empty line: the raw text (copied byte-for-byte where the chain is untouched)
 *  and its object. */
export interface SourceLine {
  raw: string;
  entry: any;
}

/** A session file as this module reads it: the header plus every entry line. */
export interface SourceDoc {
  header: any;
  lines: SourceLine[];
}

/**
 * Parse session bytes without the SDK. STRICT: the first line must be the v3 session header,
 * and every following non-empty line must parse to an entry with a string id and a parentId
 * that is a string or null. Anything else — a torn trailing line, a legacy id-less entry, a
 * newer version — is the caller's "invalid" refusal: this code would rather refuse than copy a
 * file it does not fully understand under a header that claims a format it was never written
 * for. Blank lines are skipped; they are whitespace, not corruption.
 */
export function parseSourceDoc(text: string): { ok: true; doc: SourceDoc } | { ok: false; why: string } {
  const lines = text.split("\n");
  let header: any = null;
  const entries: SourceLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    let v: any;
    try {
      v = JSON.parse(raw);
    } catch {
      return { ok: false, why: `line ${i + 1} is not JSON (a torn or corrupt write?)` };
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, why: `line ${i + 1} is not an object` };
    if (i === 0 || (header === null && entries.length === 0 && v.type === "session")) {
      if (v.type !== "session") return { ok: false, why: "the first line is not a session header" };
      if (v.version !== SESSION_VERSION) return { ok: false, why: `session version ${String(v.version)} is not ${SESSION_VERSION}` };
      if (typeof v.id !== "string" || !v.id) return { ok: false, why: "the header has no session id" };
      if (typeof v.cwd !== "string" || !v.cwd) return { ok: false, why: "the header has no working directory" };
      header = v;
      continue;
    }
    if (v.type === "session") return { ok: false, why: "a second session header appears mid-file" };
    if (typeof v.id !== "string" || !v.id) return { ok: false, why: `an entry on line ${i + 1} has no id` };
    if (v.parentId !== null && typeof v.parentId !== "string") return { ok: false, why: `entry ${v.id} has a malformed parentId` };
    entries.push({ raw, entry: v });
  }
  if (!header) return { ok: false, why: "the file has no session header" };
  return { ok: true, doc: { header, lines: entries } };
}

/**
 * The active branch, root-first: walk parentId from the LAST entry (file order), the SDK's own
 * leaf rule. The walk is guarded — a revisited id or a parent link to an entry that is not in
 * the file is a broken ancestry, refused rather than walked into a loop or a stump.
 */
export function activeBranchLines(doc: SourceDoc): { ok: true; branch: SourceLine[] } | { ok: false; why: string } {
  const byId = new Map<string, SourceLine>();
  for (const line of doc.lines) byId.set(line.entry.id, line);
  const leaf = doc.lines.length ? doc.lines[doc.lines.length - 1]! : null;
  if (!leaf) return { ok: true, branch: [] };
  const branch: SourceLine[] = [];
  const seen = new Set<string>();
  let cur: SourceLine | undefined = leaf;
  while (cur) {
    const id: string = cur.entry.id;
    if (seen.has(id)) return { ok: false, why: `the entry chain cycles at ${id}` };
    seen.add(id);
    branch.push(cur);
    const parent = cur.entry.parentId;
    if (parent === null || parent === undefined) break;
    const next = byId.get(parent);
    if (!next) return { ok: false, why: `entry ${id} points at a parent (${parent}) that is not in the file` };
    if (next === cur) return { ok: false, why: `entry ${id} is its own parent` };
    cur = next;
  }
  return { ok: true, branch: branch.reverse() };
}

/** Whether the file carries the legacy fanout marker: its copies open with an outline exception
 *  this fork must not inherit. Nothing writes the marker anymore. */
export function isFanoutSource(doc: SourceDoc): boolean {
  return doc.lines.some((l) => l.entry?.type === "custom" && l.entry.customType === FANOUT_MEMBER_ENTRY);
}

/**
 * The transient subagent/team registry entries a fork DROPS: they describe the source's own
 * workers and teams (process registries, not conversation), and a copy would make the fork's
 * runtime list, restore and manage the SOURCE's workers as its own — the restored-worker fold
 * and the team fold read these entries back from any file they sit in, with no owner-session
 * check. Conversation that merely MENTIONS workers (inline completion messages, tool calls and
 * their results) is kept: it is context, not registry. The team entry types are spelled as
 * literals because the module that owns them is outside the server's allowed pi-config imports
 * (worker-transcript.ts is inside it); tests pin the literals.
 */
export const DROPPED_REGISTRY_TYPES: ReadonlySet<string> = new Set([
  WORKER_MANIFEST_ENTRY_TYPE,
  LEGACY_REGISTRY_ENTRY_TYPE,
  "subagents-team-v1",
  "subagents-team-event-v1",
  "subagents-team-assignment-v1",
]);

/**
 * Splice the dropped registry entries out of a linear branch prefix and re-link the chain: each
 * kept entry's parentId becomes the previous KEPT entry's id (the prefix's own root parent for
 * the first). Copied wake_nudge results lose their runtime-only details so opening the fork
 * cannot re-arm the source's timers; their model-visible content remains unchanged.
 */
export function reconstructPath(prefix: SourceLine[]): SourceLine[] {
  // The strict parse plus the guarded ancestry walk guarantee prefix[0].parentId is null, so
  // rootParent is the true root anchor: a first kept entry can only ever need it when leading
  // registry entries were dropped, and an interior expectedParent is always a kept entry's id —
  // the rewrite can never manufacture a dangling parent.
  const rootParent = prefix.length ? prefix[0]!.entry.parentId : null;
  const out: SourceLine[] = [];
  for (const line of prefix) {
    const drop =
      line.entry?.type === "custom" && typeof line.entry.customType === "string" && DROPPED_REGISTRY_TYPES.has(line.entry.customType);
    if (drop) continue;
    const expectedParent = out.length ? out[out.length - 1]!.entry.id : rootParent;
    const message = line.entry.type === "message" ? line.entry.message : undefined;
    const clearWakeState = message?.role === "toolResult" && message.toolName === "wake_nudge" && message.details !== undefined;
    if (line.entry.parentId !== expectedParent || clearWakeState) {
      const entry = { ...line.entry, parentId: expectedParent };
      if (clearWakeState) {
        entry.message = { ...message };
        delete entry.message.details;
      }
      out.push({ raw: JSON.stringify(entry), entry });
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * The tool calls the copied CONTEXT would carry, and the results that answer them — answered by
 * the SDK itself: a NONPERSISTENT SessionManager over the kept prefix builds exactly the
 * projection the fork's first turn will build (compaction retention, context-edit replacement,
 * system-message elision), so this module keeps no second copy of those rules. The pairing rule
 * is the one that matters to a fork: every toolCall block in a surviving assistant message must
 * have a surviving toolResult message answering it, or the fork opens on a dangling call.
 */
function projectedToolPairing(header: any, prefix: SourceLine[]): { calls: Set<string>; results: Set<string> } | { error: string } {
  try {
    const sm = SessionManager.inMemory(
      header.cwd,
      undefined,
      [header, ...prefix.map((l) => l.entry)] as any[],
    );
    const messages: any[] = sm.buildSessionProjection().messages;
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block && typeof block === "object" && block.type === "toolCall" && typeof block.id === "string") calls.add(block.id);
        }
      } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
        results.add(message.toolCallId);
      }
    }
    return { calls, results };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export type PrefixPlan =
  | { ok: true; prefix: SourceLine[] }
  | { ok: false; reason: ForkRefusal; message: string; status: ForkStatus };

/**
 * The forkable prefix through the selected assistant reply, or a refusal. Later conversation is
 * excluded (it is not an ancestor) and so are abandoned branches (their entries are not on the
 * ancestry). A boundary whose copied context would carry a tool call without its result is
 * refused — the fork's first turn would open on a dangling call — with the message saying
 * whether it was the selected reply itself or an earlier aborted turn that dangles.
 */
export function forkPrefix(doc: SourceDoc, entryId: string): PrefixPlan {
  const walked = activeBranchLines(doc);
  if (!walked.ok) return { ok: false, reason: "invalid", message: `That session's entry chain is broken: ${walked.why}.`, status: 400 };
  const branch = walked.branch;
  const at = branch.findIndex((l) => l.entry.id === entryId);
  if (at < 0)
    return {
      ok: false,
      reason: "not_on_branch",
      message: "That reply is not on this chat's current branch anymore.",
      status: 400,
    };
  const target = branch[at]!;
  if (target.entry.type !== "message" || target.entry.message?.role !== "assistant")
    return {
      ok: false,
      reason: "not_assistant",
      message: "Only an assistant reply can be forked from.",
      status: 400,
    };
  const prefix = reconstructPath(branch.slice(0, at + 1));
  const pairing = projectedToolPairing(doc.header, prefix);
  if ("error" in pairing)
    return { ok: false, reason: "invalid", message: `That session's context did not project cleanly: ${pairing.error}.`, status: 400 };
  const missing = [...pairing.calls].filter((id) => !pairing.results.has(id));
  if (missing.length > 0) {
    const targetCalls: string[] = Array.isArray(target.entry.message?.content)
      ? target.entry.message.content.filter((b: any) => b?.type === "toolCall").map((b: any) => b.id as string)
      : [];
    const atTarget = targetCalls.some((id) => missing.includes(id));
    return {
      ok: false,
      reason: "tool_boundary",
      message: atTarget
        ? "That reply was still waiting on a tool result. Fork from a later reply in the same turn."
        : "An earlier reply in this conversation left a tool call unanswered, so this fork would start mid-turn.",
      status: 400,
    };
  }
  return { ok: true, prefix };
}

/**
 * Fork `sourcePath` through the assistant entry `entryId`: read once, select the branch prefix
 * through the reply, splice out transient registry state, and write the fork beside the source
 * in its own session dir (same cwd, same host) with a fresh id and a `parentSession` header
 * pointing back at the source. Nothing is appended to the source, no runtime is opened, and no
 * model is called. The discarded SessionManager only mints the id, the header and the file
 * name; it never persists.
 */
export function forkSessionFile(sourcePath: string, entryId: string): ForkOutcome {
  let text: string;
  try {
    text = readFileSync(sourcePath, "utf8");
  } catch {
    return { ok: false, reason: "not_found", message: "Session file not found.", status: 404 };
  }
  const parsed = parseSourceDoc(text);
  if (!parsed.ok) return { ok: false, reason: "invalid", message: `That file is not a readable session: ${parsed.why}.`, status: 400 };
  const doc = parsed.doc;
  if (isFanoutSource(doc)) return { ok: false, reason: "unsupported", message: "Legacy group sessions cannot be forked.", status: 400 };
  const planned = forkPrefix(doc, entryId);
  if (!planned.ok) return planned;
  try {
    const mint = SessionManager.create(doc.header.cwd, dirname(sourcePath), { parentSession: canonicalPath(sourcePath) });
    const target = mint.getSessionFile();
    const header = mint.getHeader();
    if (!target || !header || typeof header.id !== "string")
      return { ok: false, reason: "internal", message: "Could not mint the fork's session header.", status: 500 };
    if (existsSync(target)) return { ok: false, reason: "internal", message: "The fork's session file already exists.", status: 500 };
    const ids = new Set(planned.prefix.map((line) => line.entry.id));
    let cacheEntryId: string;
    do { cacheEntryId = randomBytes(4).toString("hex"); } while (ids.has(cacheEntryId));
    const cacheEntry = {
      type: "custom", id: cacheEntryId,
      parentId: planned.prefix.at(-1)?.entry.id ?? null,
      timestamp: new Date().toISOString(), customType: FORK_CACHE_ENTRY,
      // Read lineage from the whole source file: the selected reply can precede this fork's
      // inherited metadata, and later rewinds do not change the source's cache identity.
      data: forkCacheData(doc.header.id, doc.lines.map((line) => line.entry)),
    };
    writeFileSync(target, `${JSON.stringify(header)}\n${planned.prefix.map((l) => l.raw).join("\n")}\n${JSON.stringify(cacheEntry)}\n`, { flag: "wx" });
    return { ok: true, path: canonicalPath(target), sessionId: header.id, cwd: doc.header.cwd };
  } catch (err) {
    return { ok: false, reason: "internal", message: err instanceof Error ? err.message : String(err), status: 500 };
  }
}
