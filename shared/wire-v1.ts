// Wire 1 → wire 2: today's live events and row facts in the harness contract's
// words (shared/harness-wire.ts). The one mapping, used on both sides: the server maps pi's event to
// its v1 frame and that frame through `fromV1`; a browser that asked for wire 2 and got wire 1 (an
// older peer) maps the same frame through the same function, so wire 2 equals wire 1 seen through it
// by construction. Rows likewise: `factsFromMeta` on the server, `rowFacts` on any row.
//
// Pure: no DOM, no pi import, only shared helpers. The one module in shared/ and src/ that may read
// pi's event names (with src/lib/legacy-rows.ts); it goes when wire 1 does.

import type { RowFacts, SovaEvent, SovaPart } from "./harness-wire";
import { stripImageNotes } from "./image-note";
import type { EntryMeta, V1EventFrame } from "./protocol";

// ---- Helpers, as src/lib (message.ts, images.ts, context.ts) has them; images.ts imports the DOM.

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The text blocks of a string-or-array `content` field, joined. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (isObj(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Image blocks in a pi content array (`{type:"image", data, mimeType}`) as data URLs. */
function imagesFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content) {
    if (isObj(c) && c.type === "image" && typeof c.data === "string") out.push(`data:${str(c.mimeType) ?? "image/png"};base64,${c.data}`);
  }
  return out;
}

/** Tokens in context for one usage object (input + cacheRead + cacheWrite), or null without one. */
function usageTokens(usage: unknown): number | null {
  if (!isObj(usage)) return null;
  const n = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
  return n("input") + n("cacheRead") + n("cacheWrite");
}

/** The context fill an assistant message (or its EntryMeta) reports, or null: not an assistant's, no
    usage, an error or aborted reply, or a usage of zero. The browser's rule (src/lib/context.ts). */
function contextTokensOf(message: unknown): number | null {
  if (!isObj(message) || message.role !== "assistant") return null;
  if (message.stopReason === "error" || message.stopReason === "aborted") return null;
  const tokens = usageTokens(message.usage);
  return tokens !== null && tokens > 0 ? tokens : null;
}

/** "provider/model" of a message, when it names both. */
function modelOf(msg: Record<string, unknown>): string | undefined {
  const provider = str(msg.provider);
  const model = str(msg.model);
  return provider && model ? `${provider}/${model}` : undefined;
}

function partsOf(content: unknown): SovaPart[] {
  if (!Array.isArray(content)) return [];
  const out: SovaPart[] = [];
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c.type === "text") out.push({ kind: "text", text: str(c.text) ?? "" });
    else if (c.type === "thinking") out.push({ kind: "thinking", text: str(c.thinking) ?? "" });
    else if (c.type === "toolCall") out.push({ kind: "toolCall", id: str(c.id) ?? "", name: str(c.name) ?? "tool", args: c.arguments });
  }
  return out;
}

const toolOutput = (result: unknown) => (isObj(result) ? contentText(result.content) : typeof result === "string" ? result : "");
const toolImages = (result: unknown) => (isObj(result) ? imagesFromContent(result.content) : []);

// ---- Events

/** One streamed assistant event (`message_update`'s `assistantMessageEvent`, as toWireEvent sends it:
    a toolcall_start carries `id` and `toolName`). Its other types (start, done, error) map to none. */
function partEvent(ev: Record<string, unknown>): SovaEvent[] {
  const at = typeof ev.contentIndex === "number" ? { index: ev.contentIndex } : {};
  const delta = str(ev.delta) ?? "";
  const ended = (kind: "text" | "thinking"): SovaEvent[] => {
    const text = str(ev.content);
    return [{ type: "part.end", ...at, kind, ...(text !== undefined ? { text } : {}) }];
  };
  switch (str(ev.type)) {
    case "text_start":
      return [{ type: "part.start", ...at, kind: "text" }];
    case "text_delta":
      return [{ type: "part.delta", ...at, kind: "text", delta }];
    case "text_end":
      return ended("text");
    case "thinking_start":
      return [{ type: "part.start", ...at, kind: "thinking" }];
    case "thinking_delta":
      return [{ type: "part.delta", ...at, kind: "thinking", delta }];
    case "thinking_end":
      return ended("thinking");
    case "toolcall_start": {
      const id = str(ev.id);
      const name = str(ev.toolName);
      return [{ type: "part.start", ...at, kind: "toolCall", ...(id !== undefined ? { id } : {}), ...(name !== undefined ? { name } : {}) }];
    }
    case "toolcall_delta":
      return [{ type: "part.delta", ...at, kind: "toolCall", delta }];
    case "toolcall_end": {
      const tc = isObj(ev.toolCall) ? ev.toolCall : {};
      const id = str(tc.id);
      const name = str(tc.name);
      return [{ type: "part.end", ...at, kind: "toolCall", ...(id !== undefined ? { id } : {}), ...(name !== undefined ? { name } : {}), args: tc.arguments }];
    }
    default:
      return [];
  }
}

/**
 * A wire-1 event frame (pi's event as toWireEvent sends it, plus the `entryId` a message_end may
 * carry) as wire-2 events, in order. Every event the live view acts on today maps to one; the ones
 * it ignores (turn_start, turn_end, agent_end, queue_update, a message of any other role, …) map to
 * none.
 */
export function fromV1(frame: Pick<V1EventFrame, "event" | "entryId">): SovaEvent[] {
  const event = frame.event;
  if (!isObj(event)) return [];
  switch (str(event.type)) {
    case "agent_start":
      return [{ type: "run.start" }];
    case "agent_settled":
      return [{ type: "run.settled" }];
    case "message_start": {
      const msg = isObj(event.message) ? event.message : {};
      if (msg.role === "assistant") {
        const model = modelOf(msg);
        return [{ type: "message.start", role: "assistant", ...(model ? { model } : {}), parts: partsOf(msg.content) }];
      }
      if (msg.role === "user")
        return [{ type: "message.start", role: "user", text: stripImageNotes(contentText(msg.content), msg.content), images: imagesFromContent(msg.content) }];
      return [];
    }
    case "message_update":
      return isObj(event.assistantMessageEvent) ? partEvent(event.assistantMessageEvent) : [];
    case "message_end": {
      const msg = isObj(event.message) ? event.message : {};
      // The frame's own, as the browser puts it on the event (ChatView), else the event's.
      const entryId = str(frame.entryId || event.entryId) || undefined;
      const written = entryId ? { entryId } : {};
      if (msg.role === "user") return [{ type: "message.end", role: "user", ...written }];
      if (msg.role !== "assistant") return [];
      const model = modelOf(msg);
      const stop = msg.stopReason === "error" ? "error" : msg.stopReason === "aborted" ? "aborted" : "ok";
      const error = stop === "error" ? str(msg.errorMessage) : undefined;
      const tokens = contextTokensOf(msg);
      return [
        {
          type: "message.end",
          role: "assistant",
          ...written,
          ...(model ? { model } : {}),
          parts: partsOf(msg.content),
          stop,
          ...(error !== undefined ? { error } : {}),
          ...(tokens !== null ? { contextTokens: tokens } : {}),
        },
      ];
    }
    case "tool_execution_start": {
      const callId = str(event.toolCallId);
      return callId ? [{ type: "tool.start", callId, name: str(event.toolName) ?? "tool", args: event.args }] : [];
    }
    case "tool_execution_update": {
      const callId = str(event.toolCallId);
      return callId ? [{ type: "tool.update", callId, output: toolOutput(event.partialResult), images: toolImages(event.partialResult) }] : [];
    }
    case "tool_execution_end": {
      const callId = str(event.toolCallId);
      if (!callId) return [];
      const name = str(event.toolName);
      const details = isObj(event.result) ? event.result.details : undefined;
      return [
        {
          type: "tool.end",
          callId,
          ...(name !== undefined ? { name } : {}),
          args: event.args,
          isError: event.isError === true,
          output: toolOutput(event.result),
          images: toolImages(event.result),
          ...(details !== undefined ? { details } : {}),
        },
      ];
    }
    case "auto_retry_start":
      return [{ type: "activity", what: "retry", phase: "start" }];
    case "auto_retry_end":
      return [{ type: "activity", what: "retry", phase: "end" }];
    case "compaction_start":
      return [{ type: "activity", what: "compaction", phase: "start" }];
    case "compaction_end":
      // Only a compaction that wrote one (`result`) makes the fill stale.
      return [{ type: "activity", what: "compaction", phase: "end", wrote: isObj(event.result) }];
    default:
      return [];
  }
}

// ---- Row facts

/**
 * A row's EntryMeta as RowFacts, each fact read as the browser's predicates read it today: a change
 * row (src/lib/change-rows.ts), a context reset and a reply's fill (src/lib/context.ts), a
 * compaction's figures (timeline, tail-render, Thread), a tool result's tool and failure
 * (shared/row-counts.ts, src/lib/message.ts). No meta, no facts: the row reads its entry's first.
 */
export function factsFromMeta(meta: EntryMeta | undefined): RowFacts | undefined {
  if (!meta) return undefined;
  const facts: RowFacts = {};
  const { type } = meta;
  if (type === "model_change") facts.setting = "model";
  else if (type === "thinking_level_change") facts.setting = "thinking";
  else if (type === "custom" && meta.customType === "mode") facts.setting = "mode";
  if (type === "compaction" || (type === "message" && meta.role === "compactionSummary")) facts.resetsContext = true;
  if (type === "compaction") {
    const c: NonNullable<RowFacts["compaction"]> = {};
    if (typeof meta.tokensBefore === "number") c.tokensBefore = meta.tokensBefore;
    if (typeof meta.summary === "string") c.summary = meta.summary;
    if (meta.details !== undefined) c.details = meta.details;
    facts.compaction = c;
  }
  const tokens = type === "message" ? contextTokensOf(meta) : null;
  if (tokens !== null) facts.contextTokens = tokens;
  if (meta.role === "toolResult") {
    const tool: NonNullable<RowFacts["tool"]> = {};
    if (meta.toolName !== undefined) tool.name = meta.toolName;
    if (meta.toolCallId !== undefined) tool.callId = meta.toolCallId;
    if (meta.isError !== undefined) tool.isError = meta.isError;
    facts.tool = tool;
  }
  return facts;
}

/** A row's facts on either wire: its own `facts` (wire 2), else its `meta` mapped (wire 1). */
export function rowFacts(row: { facts?: RowFacts; meta?: EntryMeta }): RowFacts | undefined {
  return row.facts ?? factsFromMeta(row.meta);
}
