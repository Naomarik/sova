// The pi side of the wire (shared/protocol.ts WireVersion): what a pi event and a pi entry become on it.
// Wire 1 is pi's own shapes, as Sova has always sent them: the event passed through (toV1Event), a message_end
// tagged with the entry pi wrote it as, and an entry's facts in pi's fields (metaOf). Wire 2 is wire 1 mapped
// by shared/wire-v1.ts, the one mapping the browser also uses for an older server's frames, so a consumer on
// either wire sees the same events and the same facts by construction.

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { EntryMeta, V1EventFrame, V2EventFrame } from "../../../shared/protocol";
import { hideTourCredentialsDeep, RECORD_TOUR_TOOL } from "../../../shared/tour";
import { fromV1 } from "../../../shared/wire-v1";
import { mcpToolOf } from "./mcp-tools";

const SIGNATURE_KEYS = new Set(["thinkingSignature", "textSignature", "thoughtSignature"]);

/** `v` without any provider signature (encrypted reasoning) at any depth; `v` itself when it holds
    none, so the common case copies nothing. */
export function withoutSignatures<T>(v: T): T {
  if (Array.isArray(v)) {
    let out: unknown[] | null = null;
    v.forEach((x, i) => {
      const y = withoutSignatures(x);
      if (y !== x) (out ??= v.slice())[i] = y;
    });
    return (out ?? v) as T;
  }
  if (!v || typeof v !== "object") return v;
  let out: Record<string, unknown> | null = null;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (SIGNATURE_KEYS.has(k)) {
      out ??= { ...(v as Record<string, unknown>) };
      delete out[k];
      continue;
    }
    const y = withoutSignatures(x);
    if (y !== x) (out ??= { ...(v as Record<string, unknown>) })[k] = y;
  }
  return (out ?? v) as T;
}

/** Strip the per-delta `partial` snapshot (same as pi's rpc toJsonEvent) to keep frames small, and
    every provider signature (§chat.transcript/slim-rows: encrypted reasoning never reaches the
    browser; message_end, turn_end and agent_end carry whole messages), and record_tour's supplied
    credentials (§app.tours/sites: every view of its arguments shows "[hidden]"). */
export function toV1Event(event: any): unknown {
  return hideTourCredentialsDeep(withoutSignatures(wireEvent(withoutNewerFields(event))));
}

const without = (o: any, key: string) => {
  if (!o || typeof o !== "object" || !(key in o)) return o;
  const { [key]: _dropped, ...rest } = o;
  return rest;
};

/** `list` with `f` over each element; `list` itself when nothing changed, so the common case copies nothing. */
const mapKept = <T>(list: T[], f: (x: T) => T): T[] => {
  let out: T[] | null = null;
  list.forEach((x, i) => {
    const y = f(x);
    if (y !== x) (out ??= list.slice())[i] = y;
  });
  return out ?? list;
};

/** A usage as pi 1.0.3 had it: its cost without `totalFromProvider` (pi-ai 1.5.0). */
function v1Usage(usage: any): any {
  const cost = without(usage?.cost, "totalFromProvider");
  return cost === usage?.cost ? usage : { ...usage, cost };
}

/** A tool call as pi 1.0.3 had it: without `argumentsError` (pi-ai 1.5.0: arguments that did not parse). */
const v1Block = (block: any) => (block?.type === "toolCall" ? without(block, "argumentsError") : block);

/** A message as pi 1.0.3 had it, whatever its role: without the time it took (`durationMs`, on an
    assistant's reply and a tool's result), its usage's `totalFromProvider`, and a tool call's
    `argumentsError`. A tool result's `details` and `content` are the tool's own and pass whole. */
function v1Message(message: any): any {
  if (!message || typeof message !== "object") return message;
  let out = without(message, "durationMs");
  const usage = v1Usage(out.usage);
  if (usage !== out.usage) out = { ...out, usage };
  if (out.role === "assistant" && Array.isArray(out.content)) {
    const content = mapKept(out.content, v1Block);
    if (content !== out.content) out = { ...out, content };
  }
  return out;
}

/** `o` with `key`'s value mapped; `o` itself when the value came back as it was. */
const withKey = (o: any, key: string, f: (v: any) => any) => {
  if (!o || typeof o !== "object" || !(key in o)) return o;
  const v = f(o[key]);
  return v === o[key] ? o : { ...o, [key]: v };
};
const v1Messages = (list: unknown) => (Array.isArray(list) ? mapKept(list, v1Message) : list);

/**
 * Wire 1 is a fixed contract: older servers, peers and clients read its frames as pi 1.0.3 shaped them, so
 * a field a later pi adds to an event stays out, by the place pi puts it (never by name at any depth: a
 * tool's own `details` may hold the same word). Since 1.0.3 pi added: `aborted` on `agent_settled` and
 * `structuredContent` on `tool_execution_end`'s result (1.1.0); `durationMs` on `tool_execution_end`, on a
 * tool result's message and on an assistant's message (1.1.0, 1.5.0); `totalFromProvider` in a usage's
 * cost and `argumentsError` on a tool call (pi-ai 1.5.0). A message reaches a frame in `message_start`,
 * `message_end`, `turn_end` (its message and tool results), `agent_end`, an `entry_appended` message
 * entry, and `message_update` (the frame's `usage`, a `toolcall_end`'s tool call, and the whole message a
 * `done` or `error` carries; `partial` never goes out). Wire 2 is mapped from these frames by named
 * fields (shared/wire-v1.ts), so it is unchanged too.
 */
function withoutNewerFields(event: any): any {
  switch (event?.type) {
    case "agent_settled":
      return without(event, "aborted");
    case "tool_execution_end":
      return withKey(without(event, "durationMs"), "result", (r) => without(r, "structuredContent"));
    case "message_start":
    case "message_end":
      return withKey(event, "message", v1Message);
    case "turn_end":
      return withKey(withKey(event, "message", v1Message), "toolResults", v1Messages);
    case "agent_end":
      return withKey(event, "messages", v1Messages);
    case "entry_appended":
      return withKey(event, "entry", (entry) => (entry?.type === "message" ? withKey(entry, "message", v1Message) : entry));
    case "message_update": {
      // Only what wireEvent sends on: the message's usage, and the stream event less its `partial`.
      const e = withKey(event, "message", (m) => withKey(m, "usage", v1Usage));
      return withKey(e, "assistantMessageEvent", (ame) => withKey(withKey(withKey(ame, "toolCall", v1Block), "message", v1Message), "error", v1Message));
    }
    default:
      return event;
  }
}

/** A server's tool on a streaming frame, from the names the chat's own list registered (never guessed). */
const mcpOn = (name: unknown) => {
  const mcp = typeof name === "string" ? mcpToolOf(name) : undefined;
  return mcp ? { mcp } : {};
};

function wireEvent(event: any): unknown {
  if (event?.type !== "message_update") return event;
  const ame = event.assistantMessageEvent ?? {};
  let wire = ame;
  if ("partial" in ame) {
    const { partial, ...rest } = ame;
    wire = rest;
    if (ame.type === "toolcall_start") {
      const tc = partial?.content?.[ame.contentIndex];
      if (tc?.type === "toolCall") wire = { ...rest, id: tc.id, toolName: tc.name, ...mcpOn(tc.name) };
    }
    if (ame.type === "toolcall_end") wire = { ...wire, ...mcpOn(ame.toolCall?.name) };
    // record_tour's arguments stream as raw JSON, credentials and all: its deltas carry nothing, and
    // its card shows the arguments once they end, hidden (toolcall_end, message_end).
    if (ame.type === "toolcall_delta" && partial?.content?.[ame.contentIndex]?.name === RECORD_TOUR_TOOL) wire = { ...wire, delta: "" };
  }
  return { type: "message_update", usage: event.message?.usage, assistantMessageEvent: wire };
}

/** pi's event as a wire-1 frame, untagged (a message_end's `entryId` is set once pi has written it). */
export const v1Frame = (event: unknown): V1EventFrame => ({ type: "event", event: toV1Event(event) });

/** Whether this event is the end of a message, the one event a frame is tagged on (writtenEntryId). */
export const endsMessage = (event: { type: string }): boolean => event.type === "message_end";

/** The id of the entry pi wrote `message` as, when its leaf is that message (read once pi has
    persisted it: listeners run before the write), else undefined. */
export function writtenEntryId(session: Pick<AgentSession, "sessionManager">, message: unknown): string | undefined {
  const sm = session.sessionManager;
  const leaf = sm.getLeafId();
  const entry = leaf ? sm.getEntry(leaf) : undefined;
  return entry?.type === "message" && entry.message === message ? entry.id : undefined;
}

/** A wire-1 frame on wire 2: one frame per event `fromV1` maps it to (none for an event the live view
    ignores). */
export const v2Frames = (frame: V1EventFrame): V2EventFrame[] => fromV1(frame).map((event) => ({ type: "event", v: 2, event }));

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A raw pi entry's facts (EntryMeta), as wire 1 carries them on its first row. */
export function metaOf(entry: Record<string, any>): EntryMeta {
  const meta: EntryMeta = { type: typeof entry.type === "string" ? entry.type : "unknown" };
  if (typeof entry.customType === "string") meta.customType = entry.customType;
  if (entry.type === "compaction") {
    if (typeof entry.tokensBefore === "number") meta.tokensBefore = entry.tokensBefore;
    if (typeof entry.summary === "string") meta.summary = entry.summary;
    if (entry.details !== undefined) meta.details = entry.details;
  }
  const m = entry.message;
  if (isObj(m)) {
    const s = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : undefined);
    const put = <K extends keyof EntryMeta>(k: K, v: EntryMeta[K] | undefined) => {
      if (v !== undefined) meta[k] = v;
    };
    put("role", s("role"));
    put("provider", s("provider"));
    put("model", s("model"));
    if (m.usage !== undefined) meta.usage = m.usage;
    put("stopReason", s("stopReason"));
    put("errorMessage", s("errorMessage"));
    put("toolName", s("toolName"));
    put("toolCallId", s("toolCallId"));
    if (typeof m.isError === "boolean") meta.isError = m.isError;
    if (meta.customType === undefined) put("customType", s("customType"));
  }
  return meta;
}
