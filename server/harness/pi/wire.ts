// The pi side of the wire (shared/protocol.ts WireVersion): what a pi event and a pi entry become on it.
// Wire 1 is pi's own shapes, as Sova has always sent them: the event passed through (toV1Event), a message_end
// tagged with the entry pi wrote it as, and an entry's facts in pi's fields (metaOf). Wire 2 is wire 1 mapped
// by shared/wire-v1.ts, the one mapping the browser also uses for an older server's frames, so a consumer on
// either wire sees the same events and the same facts by construction.

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { EntryMeta, V1EventFrame, V2EventFrame } from "../../../shared/protocol";
import { fromV1 } from "../../../shared/wire-v1";

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
    browser; message_end, turn_end and agent_end carry whole messages). */
export function toV1Event(event: any): unknown {
  return withoutSignatures(wireEvent(event));
}

function wireEvent(event: any): unknown {
  if (event?.type !== "message_update") return event;
  const ame = event.assistantMessageEvent ?? {};
  let wire = ame;
  if ("partial" in ame) {
    const { partial, ...rest } = ame;
    wire = rest;
    if (ame.type === "toolcall_start") {
      const tc = partial?.content?.[ame.contentIndex];
      if (tc?.type === "toolCall") wire = { ...rest, id: tc.id, toolName: tc.name };
    }
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
