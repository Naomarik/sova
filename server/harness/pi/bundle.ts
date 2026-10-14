// Saved sessions, pi's half (§chat.saved-sessions/branch, /cleaning, /import): a session's active branch as a
// portable transcript, and a saved transcript back into a blank session. Modelled on fork.ts and sharing its
// strict reader: the SOURCE file is read once with readFileSync and never opened with the SDK, a torn or
// malformed line is a refusal, and the bytes written are this module's own.
//
// Export keeps only conversation-shaping entries (messages other than the system prompt's, extension
// messages, compactions, branch summaries, context edits, model and thinking changes, the session name and
// labels), re-linked into one chain. Every string leaf goes through the caller's `clean` (redaction and path
// tokens live in the route), thinking blocks are dropped unless asked for, images are dropped by id, long tool
// output is clipped on request, and a compaction loses its system-prompt checkpoint. The worker and team
// registry entries are never copied; they are summarised (`workers`) for the card instead.
//
// Import reads a transcript as untrusted: strictly, one linear chain, only the same conversation-shaping
// entries (everything else is dropped and counted), and the tool-pairing check fork uses. It writes into the
// blank session's file after that file's own entries (its profile, mode and sandbox picks stay), with ids
// that can't collide with them.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  BundleExport,
  BundleExportOptions,
  BundleImage,
  BundleImportOptions,
  BundleOutcome,
  BundleRead,
  BundleStringSite,
  BundleWorker,
  EntryId,
  HarnessBundles,
  HEntry,
  SessionKey,
} from "../../../shared/harness";
import { readWorkerManifests } from "../../../pi-config/extensions/subagents/worker-transcript.ts";
import { activeBranchLines, DROPPED_REGISTRY_TYPES, parseSourceDoc, type SourceLine } from "./fork";
import { toHEntry } from "./reader";

/** The entry types a saved transcript may carry: the ones that shape the conversation. */
export const KEPT_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "message",
  "custom_message",
  "compaction",
  "branch_summary",
  "context_edit",
  "model_change",
  "thinking_level_change",
  "session_info",
  "label",
]);
/** The message roles a saved transcript may carry. The system prompt's own messages never travel. */
export const KEPT_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

/** Keys whose values are structure, never prose: ids, links, roles, types, signatures and image bytes. */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "parentId",
  "type",
  "role",
  "timestamp",
  "toolCallId",
  "mimeType",
  "api",
  "provider",
  "model",
  "modelId",
  "responseModel",
  "responseId",
  "stopReason",
  "customType",
  "firstKeptEntryId",
  "targetId",
  "fromId",
  "thinkingLevel",
  "thinkingSignature",
  "textSignature",
  "signature",
  "redacted",
  "display",
  "isError",
  "usage",
  "toolName",
  "name",
]);

const IMAGE_DROPPED = "[image left out when this session was saved]";
const THINKING_OMITTED = "[thinking left out when this session was saved]";

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every string leaf of `v` through `f`, structural keys left alone; a new value (the input is never mutated). */
export function mapStrings(v: unknown, f: (s: string) => string, key = ""): unknown {
  if (typeof v === "string") return STRUCTURAL_KEYS.has(key) ? v : f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = typeof x === "string" ? mapStrings(x, f, k) : STRUCTURAL_KEYS.has(k) && k !== "name" ? x : mapStrings(x, f, k);
    return out;
  }
  return v;
}

/** Where a message's strings sit, for the cleaner's report. */
function siteOf(entry: any): BundleStringSite {
  const base = { entryId: typeof entry.id === "string" ? entry.id : null, ...(typeof entry.timestamp === "string" ? { at: entry.timestamp } : {}) };
  switch (entry.type) {
    case "message": {
      const role = entry.message?.role;
      if (role === "user" || role === "bashExecution") return { ...base, where: "user" };
      if (role === "assistant") return { ...base, where: "assistant" };
      if (role === "toolResult") return { ...base, where: "tool-result", ...(typeof entry.message.toolName === "string" ? { tool: entry.message.toolName } : {}) };
      if (role === "branchSummary" || role === "compactionSummary") return { ...base, where: "summary" };
      return { ...base, where: "note" };
    }
    case "custom_message":
      return { ...base, where: "note" };
    case "compaction":
    case "branch_summary":
      return { ...base, where: "summary" };
    default:
      return { ...base, where: "setting" };
  }
}

/** Clip one text to head + marker + tail when longer than both. */
function clip(text: string, head: number, tail: number): string | null {
  if (text.length <= head + tail) return null;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} characters of tool output left out when this session was saved …]\n${text.slice(text.length - tail)}`;
}

interface ExportCounters {
  images: BundleImage[];
  thinkingDropped: number;
  toolOutputsTrimmed: number;
}

/** A content array (or string) with images decided, thinking dropped, strings cleaned. */
function cleanContent(content: unknown, entry: any, site: BundleStringSite, o: BundleExportOptions, c: ExportCounters, path: string): unknown {
  if (typeof content === "string") return o.clean(content, site);
  if (!Array.isArray(content)) return mapStrings(content, (s) => o.clean(s, site));
  const out: unknown[] = [];
  content.forEach((block: any, i: number) => {
    if (!isObj(block)) {
      out.push(block);
      return;
    }
    if (block.type === "thinking") {
      if (!o.includeThinking) {
        c.thinkingDropped++;
        return;
      }
      out.push({ ...block, thinking: typeof block.thinking === "string" ? o.clean(block.thinking, site) : block.thinking });
      return;
    }
    if (block.type === "image") {
      const id = `${site.entryId ?? "?"}/${path}${i}`;
      const data = typeof block.data === "string" ? block.data : "";
      c.images.push({
        id,
        entryId: site.entryId,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream",
        bytes: Math.floor((data.length * 3) / 4),
        where: site.where,
        ...(site.at ? { at: site.at } : {}),
      });
      if (o.dropImages === "all" || o.dropImages.has(id)) out.push({ type: "text", text: IMAGE_DROPPED });
      else out.push(block);
      return;
    }
    if (block.type === "toolCall") {
      const callSite: BundleStringSite = { ...site, where: "tool-call", ...(typeof block.name === "string" ? { tool: block.name } : {}) };
      out.push({ ...block, arguments: mapStrings(block.arguments, (s) => o.clean(s, callSite)) });
      return;
    }
    out.push(mapStrings(block, (s) => o.clean(s, site)));
  });
  // An assistant message that held only thinking keeps a visible stand-in: an empty content array is no reply.
  if (entry?.type === "message" && entry.message?.role === "assistant" && out.length === 0 && content.length > 0) out.push({ type: "text", text: THINKING_OMITTED });
  return out;
}

/** One kept entry, cleaned (a new object). */
function cleanEntry(entry: any, o: BundleExportOptions, c: ExportCounters): any {
  const site = siteOf(entry);
  const e: any = { ...entry };
  switch (entry.type) {
    case "message": {
      const m: any = { ...entry.message };
      if ("content" in m) m.content = cleanContent(m.content, entry, site, o, c, "");
      if (m.role === "toolResult") {
        // Runtime-only details of a wake (the source's timers) never travel; other details are cleaned.
        if (m.toolName === "wake_nudge") delete m.details;
        else if (m.details !== undefined) m.details = mapStrings(m.details, (s) => o.clean(s, site));
        if (o.trimToolOutput && Array.isArray(m.content)) {
          let trimmed = false;
          m.content = m.content.map((b: any) => {
            if (!isObj(b) || b.type !== "text" || typeof b.text !== "string") return b;
            const cut = clip(b.text, o.trimToolOutput!.headChars, o.trimToolOutput!.tailChars);
            if (cut === null) return b;
            trimmed = true;
            return { ...b, text: cut };
          });
          if (trimmed) c.toolOutputsTrimmed++;
        }
      }
      if (m.role === "bashExecution") {
        for (const k of ["command", "output"]) if (typeof m[k] === "string") m[k] = o.clean(m[k], site);
        if (o.trimToolOutput && typeof m.output === "string") {
          const cut = clip(m.output, o.trimToolOutput.headChars, o.trimToolOutput.tailChars);
          if (cut !== null) {
            m.output = cut;
            c.toolOutputsTrimmed++;
          }
        }
      }
      for (const k of ["summary", "errorMessage"]) if (typeof m[k] === "string") m[k] = o.clean(m[k], site);
      if (m.role === "custom" && m.details !== undefined) m.details = mapStrings(m.details, (s) => o.clean(s, site));
      e.message = m;
      return e;
    }
    case "custom_message":
      e.content = cleanContent(entry.content, entry, site, o, c, "");
      if (entry.details !== undefined) e.details = mapStrings(entry.details, (s) => o.clean(s, site));
      return e;
    case "compaction":
      // The system-prompt checkpoint holds this computer's context files and environment: never saved.
      delete e.systemMessage;
      if (typeof e.summary === "string") e.summary = o.clean(e.summary, site);
      if (e.details !== undefined) e.details = mapStrings(e.details, (s) => o.clean(s, site));
      return e;
    case "branch_summary":
      if (typeof e.summary === "string") e.summary = o.clean(e.summary, site);
      if (e.details !== undefined) e.details = mapStrings(e.details, (s) => o.clean(s, site));
      return e;
    case "context_edit":
      if (e.replacement !== null && e.replacement !== undefined) e.replacement = cleanContent(e.replacement, entry, site, o, c, "r");
      return e;
    case "session_info":
      if (typeof e.name === "string") e.name = o.clean(e.name, site);
      return e;
    case "label":
      if (typeof e.label === "string") e.label = o.clean(e.label, site);
      return e;
    default:
      return e;
  }
}

/** Whether an entry may travel (type, and for a message its role). */
export function isKeptEntry(entry: any): boolean {
  if (!isObj(entry) || typeof entry.type !== "string" || !KEPT_ENTRY_TYPES.has(entry.type)) return false;
  if (entry.type === "message") return isObj(entry.message) && typeof entry.message.role === "string" && KEPT_ROLES.has(entry.message.role);
  return true;
}

/**
 * Link kept entries into one chain (each parented on the one before, the first on `rootParent`), and fix the
 * references that point into it: a compaction's firstKeptEntryId moves to the first kept entry at or after the
 * one it named (or the compaction itself); a label or context edit whose target isn't kept is dropped.
 */
export function relink(kept: any[], order: readonly string[], rootParent: string | null = null): any[] {
  const keptIds = new Set(kept.map((e) => e.id as string));
  const pos = new Map(order.map((id, i) => [id, i] as const));
  const out: any[] = [];
  for (const entry of kept) {
    const e = { ...entry };
    if ((e.type === "label" || e.type === "context_edit") && !keptIds.has(e.targetId)) {
      keptIds.delete(e.id);
      continue;
    }
    if (e.type === "compaction") {
      if (!keptIds.has(e.firstKeptEntryId)) {
        const from = pos.get(e.firstKeptEntryId);
        const self = pos.get(e.id) ?? Infinity;
        const next = from === undefined ? undefined : kept.find((k) => (pos.get(k.id) ?? -1) >= from && (pos.get(k.id) ?? Infinity) <= self && k.type !== "label");
        e.firstKeptEntryId = next?.id ?? e.id;
      }
    }
    e.parentId = out.length ? out[out.length - 1].id : rootParent;
    out.push(e);
  }
  return out;
}

/** The model-visible messages of a header plus entries, as pi itself projects them (compaction, context edits). */
function projection(cwd: string, entries: any[]): { messages: any[] } | { error: string } {
  try {
    const sm = SessionManager.inMemory(cwd, undefined, [{ type: "session", version: 3, id: "projection", timestamp: new Date(0).toISOString(), cwd }, ...entries] as any[]);
    return { messages: sm.buildSessionProjection().messages as any[] };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Tool calls in the projected context with no result answering them. */
function danglingCalls(messages: any[]): Set<string> {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b?.type === "toolCall" && typeof b.id === "string") calls.add(b.id);
    if (m.role === "toolResult" && typeof m.toolCallId === "string") results.add(m.toolCallId);
  }
  return new Set([...calls].filter((id) => !results.has(id)));
}

/** A rough token count of what the model sees: characters / 4, an image as 1,600. */
export function approxTokensOf(messages: any[]): number {
  let chars = 0;
  let images = 0;
  const walk = (v: unknown): void => {
    if (typeof v === "string") chars += v.length;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) {
      if (v.type === "image") {
        images++;
        return;
      }
      for (const [k, x] of Object.entries(v)) if (k !== "usage" && k !== "details" && k !== "timestamp") walk(x);
    }
  };
  messages.forEach(walk);
  return Math.ceil(chars / 4) + images * 1600;
}

/** The model and thinking level in force at the end of `entries`. */
function settingsAt(entries: any[]): { model?: { provider: string; id: string }; thinking?: string } {
  let model: { provider: string; id: string } | undefined;
  let thinking: string | undefined;
  for (const e of entries) {
    if (e.type === "model_change" && typeof e.provider === "string" && typeof e.modelId === "string") model = { provider: e.provider, id: e.modelId };
    else if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string") thinking = e.thinkingLevel;
    else if (e.type === "message" && e.message?.role === "assistant" && typeof e.message.provider === "string" && typeof e.message.model === "string" && !model)
      model = { provider: e.message.provider, id: e.message.model };
  }
  return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

const isConversationMessage = (e: any) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant" || e.message?.role === "toolResult" || e.message?.role === "bashExecution");

/** The index on `branch` the "since the last summary" scope starts at: the newest compaction's first kept entry (or itself). */
function sinceSummaryStart(branch: SourceLine[]): number | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!.entry;
    if (e.type !== "compaction") continue;
    const kept = branch.findIndex((l) => l.entry.id === e.firstKeptEntryId);
    return kept >= 0 && kept < i ? kept : i;
  }
  return null;
}

/** What the subagent extension's completion message says a worker reported: its text after the header lines. */
function reportsOf(branch: SourceLine[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { entry } of branch) {
    // A completion message, or an agent_wait result: both quote each worker's settle under the same header.
    const content =
      entry.type === "custom_message" && entry.customType === "subagent-complete"
        ? entry.content
        : entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "agent_wait"
          ? entry.message.content
          : undefined;
    if (content === undefined) continue;
    const text: string = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";
    for (const part of text.split(/^(?=### )/m)) {
      const head = /^### ([A-Za-z0-9_-]+) \(/.exec(part);
      if (!head) continue;
      const body = part
        .split("\n")
        .slice(1)
        .filter((l) => !/^(Error|Session|Model): /.test(l) && !/^\[(Final answer|Full message|Use agent_transcript)/.test(l))
        .join("\n")
        .trim();
      if (body && body !== "(no output for this task)") out.set(head[1]!, body);
    }
  }
  return out;
}

const REPORT_CHARS = 2000;
const TASK_CHARS = 600;
const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} […]` : s);

/** How a worker ended, in the card's words. */
function outcomeOf(status: string | undefined, taskOutcome: string | undefined, error: string | undefined): string {
  // A settled task says how it ended, whatever the worker does now (an idle worker waits for more).
  if (taskOutcome === "success" || taskOutcome === "done" || taskOutcome === "completed") return "done";
  if (taskOutcome === "error") return error ? `failed: ${clipText(error, 200)}` : "failed";
  if (taskOutcome === "aborted") return "stopped";
  if (status === "done") return taskOutcome ? taskOutcome : "done";
  if (status === "error") return error ? `failed: ${clipText(error, 200)}` : "failed";
  if (status === "killed") return "stopped";
  if (status === "lost") return "lost (its process died)";
  if (status === "running") return "running when saved";
  if (status === "waiting") return "idle when saved";
  return "unknown";
}

/** Each subagent and team member the conversation started, from its own registry entries (never a model call). */
export function workerSummaries(lines: SourceLine[], branch: SourceLine[]): BundleWorker[] {
  const entries = lines.map((l) => l.entry);
  const active = new Set(branch.map((l) => l.entry.id as string));
  const { manifests } = readWorkerManifests(entries, { activeEntryIds: active });
  const teams = new Map<string, { name: string; objective?: string }>();
  for (const e of entries) {
    if (e?.type !== "custom" || e.customType !== "subagents-team-v1" || !isObj(e.data)) continue;
    const t = e.data.team;
    if (e.data.op === "create" && isObj(t) && typeof t.id === "string") teams.set(t.id, { name: typeof t.name === "string" ? t.name : t.id, ...(typeof t.objective === "string" ? { objective: t.objective } : {}) });
  }
  const reports = reportsOf(branch);
  const out: BundleWorker[] = [];
  for (const m of [...manifests.values()].sort((a, b) => (a.firstAt ?? a.at) - (b.firstAt ?? b.at))) {
    if (m.onActiveBranch === false) continue;
    const team = m.team ? teams.get(m.team.teamId) : undefined;
    const report = reports.get(m.workerId);
    out.push({
      kind: m.team ? "team-member" : "subagent",
      ...(m.team ? { team: team?.name ?? m.team.teamId } : {}),
      role: m.team?.role ?? m.name ?? m.workerId,
      task: clipText(m.spec?.taskPreview ?? "", TASK_CHARS),
      outcome: outcomeOf(m.status, m.taskOutcome as string | undefined, m.error),
      ...(report ? { report: clipText(report, REPORT_CHARS) } : {}),
    });
  }
  return out;
}

const fail = (reason: "not_found" | "invalid" | "tool_boundary" | "too_big" | "internal", message: string) => ({ ok: false as const, reason, message });

/** Export a session file's active branch as a cleaned, portable transcript. The file is only read. */
export function exportSessionFile(path: string, o: BundleExportOptions): BundleOutcome<BundleExport> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return fail("not_found", "Session file not found.");
  }
  const parsed = parseSourceDoc(text);
  if (!parsed.ok) return fail("invalid", `That file is not a readable session: ${parsed.why}.`);
  const walked = activeBranchLines(parsed.doc);
  if (!walked.ok) return fail("invalid", `That session's entry chain is broken: ${walked.why}.`);
  let branch = walked.branch;
  const fullBranch = branch;
  let start = 0;
  if (o.scope === "since-summary") {
    const at = sinceSummaryStart(branch);
    if (at === null) return fail("invalid", "That session has no summary yet, so there is nothing to start from but the whole conversation.");
    start = at;
  }
  branch = branch.slice(start);
  const order = branch.map((l) => l.entry.id as string);
  const picked = branch
    .map((l) => l.entry)
    .filter((e) => !(e.type === "custom" && typeof e.customType === "string" && DROPPED_REGISTRY_TYPES.has(e.customType)))
    .filter(isKeptEntry);
  const counters: ExportCounters = { images: [], thinkingDropped: 0, toolOutputsTrimmed: 0 };
  let kept = relink(picked.map((e) => cleanEntry(e, o, counters)), order);
  // A turn cut short at the end (a tool call with no result yet) is left off; one inside the history refuses.
  for (;;) {
    const p = projection(o.placeholderCwd, kept);
    if ("error" in p) return fail("invalid", `That session's context did not project cleanly: ${p.error}.`);
    const dangling = danglingCalls(p.messages);
    if (!dangling.size) break;
    const lastAssistant = kept.map((e) => e.type === "message" && e.message?.role === "assistant").lastIndexOf(true);
    const tailCalls: string[] = lastAssistant >= 0 && Array.isArray(kept[lastAssistant].message.content) ? kept[lastAssistant].message.content.filter((b: any) => b?.type === "toolCall").map((b: any) => b.id) : [];
    if (![...dangling].every((id) => tailCalls.includes(id)))
      return fail("tool_boundary", "An earlier reply in this conversation left a tool call unanswered, so it can't be saved as it is.");
    kept = relink(kept.slice(0, lastAssistant), kept.slice(0, lastAssistant).map((e) => e.id));
  }
  const p = projection(o.placeholderCwd, kept);
  const messagesSeen = "error" in p ? [] : p.messages;
  const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: o.placeholderCwd };
  const transcript = `${[header, ...kept].map((e) => JSON.stringify(e)).join("\n")}\n`;
  const settings = settingsAt(fullBranch.map((l) => l.entry));
  return {
    ok: true,
    value: {
      transcript,
      bytes: Buffer.byteLength(transcript, "utf8"),
      entries: kept.length,
      messages: kept.filter(isConversationMessage).length,
      approxTokens: approxTokensOf(messagesSeen),
      images: counters.images,
      thinkingDropped: counters.thinkingDropped,
      toolOutputsTrimmed: counters.toolOutputsTrimmed,
      ...settings,
      hasSummary: sinceSummaryStart(fullBranch) !== null,
      workers: workerSummaries(parsed.doc.lines, fullBranch),
    },
  };
}

interface ReadEntries {
  entries: any[];
  dropped: Record<string, number>;
}

/** A saved transcript read strictly: v3 header, one linear chain, only kept entries (the rest dropped and counted), re-linked. */
function readSaved(transcript: string, maxBytes: number): BundleOutcome<ReadEntries> {
  if (Buffer.byteLength(transcript, "utf8") > maxBytes) return fail("too_big", `That saved session is bigger than ${Math.round(maxBytes / 1024 / 1024)} MB, so it can't be opened.`);
  const parsed = parseSourceDoc(transcript);
  if (!parsed.ok) return fail("invalid", `That saved session can't be read: ${parsed.why}.`);
  const lines = parsed.doc.lines;
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const e = lines[i]!.entry;
    if (seen.has(e.id)) return fail("invalid", `That saved session can't be read: entry ${e.id} appears twice.`);
    seen.add(e.id);
    const expected = i === 0 ? null : lines[i - 1]!.entry.id;
    if (e.parentId !== expected) return fail("invalid", "That saved session can't be read: its entries aren't one chain.");
  }
  const dropped: Record<string, number> = {};
  const kept: any[] = [];
  for (const { entry } of lines) {
    if (!isKeptEntry(entry)) {
      const name = entry.type === "message" ? `message:${String(entry.message?.role)}` : entry.type === "custom" ? `custom:${String(entry.customType)}` : String(entry.type);
      dropped[name] = (dropped[name] ?? 0) + 1;
      continue;
    }
    if (entry.type === "message" && entry.message.content !== undefined && typeof entry.message.content !== "string" && !Array.isArray(entry.message.content))
      return fail("invalid", `That saved session can't be read: message ${entry.id} has malformed content.`);
    if (entry.type === "compaction" && typeof entry.firstKeptEntryId !== "string") return fail("invalid", `That saved session can't be read: summary ${entry.id} names no first kept entry.`);
    // Nothing state-like rides along inside a kept entry either: a compaction's prompt checkpoint is this
    // computer's to build.
    const e = { ...entry };
    if (e.type === "compaction") delete e.systemMessage;
    kept.push(e);
  }
  const relinked = relink(kept, lines.map((l) => l.entry.id));
  const p = projection("/", relinked);
  if ("error" in p) return fail("invalid", `That saved session's context did not project cleanly: ${p.error}.`);
  if (danglingCalls(p.messages).size) return fail("tool_boundary", "That saved session has a tool call without its result, so it can't be continued.");
  return { ok: true, value: { entries: relinked, dropped } };
}

/** Read a saved transcript for a preview or a check: strict, filtered, as HEntries. */
export function readBundleText(transcript: string, o: { maxBytes: number }): BundleOutcome<BundleRead> {
  const r = readSaved(transcript, o.maxBytes);
  if (!r.ok) return r;
  const p = projection("/", r.value.entries);
  const settings = settingsAt(r.value.entries);
  return {
    ok: true,
    value: {
      entries: r.value.entries.map((e) => toHEntry(e)).filter((h): h is HEntry => h !== null),
      dropped: r.value.dropped,
      approxTokens: "error" in p ? 0 : approxTokensOf(p.messages),
      hasSummary: r.value.entries.some((e) => e.type === "compaction"),
      ...(settings.model ? { model: settings.model } : {}),
    },
  };
}

/** The approximate context size if the conversation started from its last summary. */
export function approxTokensFromSummary(entries: any[]): number | null {
  const lines = entries.map((entry) => ({ raw: "", entry }));
  const at = sinceSummaryStart(lines);
  if (at === null) return null;
  const sliced = relink(entries.slice(at), entries.map((e) => e.id));
  const p = projection("/", sliced);
  return "error" in p ? null : approxTokensOf(p.messages);
}

const newId = (taken: Set<string>): string => {
  let id: string;
  do id = randomBytes(4).toString("hex");
  while (taken.has(id));
  taken.add(id);
  return id;
};

/**
 * Write a saved transcript into the blank session at `path`, after that file's own entries (whose runtime the
 * caller closed). Refused when the file already holds conversation. Ids that collide with the blank file's own
 * are renamed (and every reference to them). Optionally a note follows the history (the continuation note).
 */
export function importIntoFile(
  path: string,
  transcript: string,
  o: BundleImportOptions,
): BundleOutcome<{ leafId: EntryId; entries: number }> {
  let own: string;
  try {
    own = readFileSync(path, "utf8");
  } catch {
    return fail("not_found", "Session file not found.");
  }
  const target = parseSourceDoc(own);
  if (!target.ok) return fail("invalid", `That session can't be written into: ${target.why}.`);
  // Blank: no conversation yet (its own state picks, and any note an extension showed on open, are fine).
  if (target.doc.lines.some((l) => (l.entry.type === "message" && l.entry.message?.role !== "system") || l.entry.type === "compaction"))
    return fail("invalid", "That session already has a conversation. Continue a saved session in a new, empty session.");
  const r = readSaved(transcript, o.maxBytes);
  if (!r.ok) return r;
  let entries = r.value.entries.map((e) => mapStrings(e, o.restore) as any);
  if (o.fromSummary) {
    const at = sinceSummaryStart(entries.map((entry) => ({ raw: "", entry })));
    if (at !== null) entries = relink(entries.slice(at), entries.map((e) => e.id));
  }
  // Ids: the blank file's own are taken; any imported id that collides gets a fresh one everywhere.
  const taken = new Set<string>(target.doc.lines.map((l) => l.entry.id as string));
  const rename = new Map<string, string>();
  for (const e of entries) {
    if (taken.has(e.id)) rename.set(e.id, newId(taken));
    else taken.add(e.id);
  }
  const ref = (id: unknown) => (typeof id === "string" && rename.has(id) ? rename.get(id)! : id);
  const lastOwn = target.doc.lines.length ? (target.doc.lines[target.doc.lines.length - 1]!.entry.id as string) : null;
  const now = new Date().toISOString();
  const written: any[] = [];
  for (const e of entries) {
    const x = { ...e, id: ref(e.id), parentId: written.length ? written[written.length - 1].id : lastOwn };
    for (const k of ["firstKeptEntryId", "targetId", "fromId"]) if (k in x) x[k] = ref(x[k]);
    written.push(x);
  }
  if (o.model) {
    written.push({
      type: "model_change",
      id: newId(taken),
      parentId: written.length ? written[written.length - 1].id : lastOwn,
      timestamp: now,
      provider: o.model.provider,
      modelId: o.model.id,
    });
  }
  if (o.note) {
    written.push({
      type: "custom_message",
      id: newId(taken),
      parentId: written.length ? written[written.length - 1].id : lastOwn,
      timestamp: now,
      customType: o.note.noteType,
      content: o.note.content,
      display: true,
      ...(o.note.details !== undefined ? { details: o.note.details } : {}),
    });
  }
  if (!written.length) return fail("invalid", "That saved session has no conversation to continue.");
  const body = own.endsWith("\n") ? own : `${own}\n`;
  const tmp = `${path}.import-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, `${body}${written.map((e) => JSON.stringify(e)).join("\n")}\n`, { flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    return fail("internal", err instanceof Error ? err.message : String(err));
  }
  return { ok: true, value: { leafId: written[written.length - 1].id, entries: written.length } };
}

/** pi's HarnessBundles: a SessionKey is the session file's path. */
export const piBundles: HarnessBundles = {
  exportSession: (key: SessionKey, o) => exportSessionFile(key, o),
  readBundle: (transcript, o) => readBundleText(transcript, o),
  importInto: (key: SessionKey, transcript, o) => importIntoFile(key, transcript, o),
};

/** One extension message (display: true) appended to a session file no runtime holds, parented on its last
    entry (the active leaf): the note telling a continued session's agent where its worktrees are. */
export function appendNoteToClosedFile(path: string, noteType: string, content: string, details?: unknown, display = true): BundleOutcome<{ id: EntryId }> {
  let own: string;
  try {
    own = readFileSync(path, "utf8");
  } catch {
    return fail("not_found", "Session file not found.");
  }
  const doc = parseSourceDoc(own);
  if (!doc.ok) return fail("invalid", `That session can't be written into: ${doc.why}.`);
  const taken = new Set<string>(doc.doc.lines.map((l) => l.entry.id as string));
  const last = doc.doc.lines.length ? (doc.doc.lines[doc.doc.lines.length - 1]!.entry.id as string) : null;
  const entry = { type: "custom_message", id: newId(taken), parentId: last, timestamp: new Date().toISOString(), customType: noteType, content, display, ...(details !== undefined ? { details } : {}) };
  const tmp = `${path}.note-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, `${own.endsWith("\n") ? own : `${own}\n`}${JSON.stringify(entry)}\n`, { flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    return fail("internal", err instanceof Error ? err.message : String(err));
  }
  return { ok: true, value: { id: entry.id } };
}

/** One image of a session's history by its export id (`<entry id>/<content index>`, `r` before the index for a
    context edit's replacement), for the save review's thumbnail: its bytes and type, or null. */
export function imageOfSession(path: string, imageId: string): { mimeType: string; data: Buffer } | null {
  const m = /^([^/]+)\/(r?)(\d+)$/.exec(imageId);
  if (!m) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const parsed = parseSourceDoc(text);
  if (!parsed.ok) return null;
  const line = parsed.doc.lines.find((l) => l.entry.id === m[1]);
  if (!line) return null;
  const e = line.entry;
  const content = m[2] ? e.replacement : e.type === "message" ? e.message?.content : e.content;
  const block = Array.isArray(content) ? content[Number(m[3])] : undefined;
  if (!isObj(block) || block.type !== "image" || typeof block.data !== "string") return null;
  return { mimeType: typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream", data: Buffer.from(block.data, "base64") };
}
