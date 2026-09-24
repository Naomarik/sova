// Assembles the in-progress agent run from raw pi SDK events (docs/rpc.md "Events").
// The store holds only what streamed since the last settle; on agent_settled the chat view
// refetches the normalized transcript and resets this.

import { produce, type SetStoreFunction } from "solid-js/store";
import type { TmpAttachment, UploadResult } from "../../shared/protocol";
import { imagesFromContent } from "./images";
import { contentText, isObj, str } from "./message";

export type LiveBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; id: string; name: string; argsText: string; args?: unknown };

/**
 * Where an outgoing message of ours stands:
 * "sending" = this tab put it on the socket and the server hasn't acknowledged it (its input
 * handlers may still be running, and it may never be queued at all); "queued" = the server says
 * it holds it, so it can still be taken back; "delivered" = the agent has taken it (the server's
 * departure by id, or its message_start), and nothing about it can be recalled. The head label and
 * the Remove affordance both read this, so neither can claim a state the server never confirmed.
 */
export type LiveUserState = "sending" | "queued" | "delivered";

export type LiveEntry =
  | {
      kind: "user";
      /** This tab's id for the message (sent as `clientId`), or the server's for a queued message
          nobody here authored. Absent only for a row rebuilt from a bare message_start. */
      id?: string;
      /** Which queue holds it while it is queued. */
      queueKind?: "steer" | "followUp";
      /** The message is out of the queue's reach: the server has handed it to the pi SDK, or a
          snapshot no longer lists it. Not a claim about WHY it left — only `message_start` says
          delivered, a removal says removed and `queue_cleared` says a Stop took it back. */
      handed?: boolean;
      /** The agent's own `message_start` for this message has been applied to this row, so no
          later start may claim it. Not the same fact as `state: "delivered"`: the server reports a
          delivery by id (`queue_item_gone`, a `consumed` refusal) BEFORE the start, so a delivered
          row can still be waiting for its start. */
      started?: boolean;
      /** Who put it in the queue: "server" is a prompt this session made for itself (a group
          message, a remote status check), which we render but never claim you typed. */
      origin?: "client" | "server";
      /** As sent, uploaded image paths included (restored verbatim into the draft if refused). */
      text: string;
      state: LiveUserState;
      images: string[];
      /** Images uploaded for this prompt, shown like a history row's path attachments. */
      attachments?: TmpAttachment[];
    }
  | {
      kind: "assistant";
      blocks: LiveBlock[];
      done: boolean;
      /** "provider/model" producing this message, from message_start/message_end. */
      model?: string;
      error?: string;
      /** ISO time the message ended as aborted. */
      stoppedAt?: string;
    };

export interface LiveTool {
  name: string;
  args?: unknown;
  status: "running" | "done" | "error";
  output: string;
  images: string[];
}

export interface LiveState {
  entries: LiveEntry[];
  tools: Record<string, LiveTool>;
  /** True from agent_start (or hello.isStreaming) until agent_settled. */
  running: boolean;
  /** What the agent is doing besides generating, e.g. retrying or compacting. */
  activity: string | null;
  /** The user pressed Stop and the run hasn't settled yet. */
  stopping: boolean;
}

export const emptyLive = (): LiveState => ({ entries: [], tools: {}, running: false, activity: null, stopping: false });

/** Run-status detail: "running bash" / "thinking" / "writing", or null between blocks. */
export function runDetail(s: LiveState): string | null {
  const running = Object.values(s.tools).find((t) => t.status === "running");
  if (running) return `running ${running.name}`;
  const last = streamingAssistant(s);
  if (!last) return null;
  const block = [...last.blocks].reverse().find(Boolean);
  if (block?.type === "thinking") return "thinking";
  if (block?.type === "text") return "writing";
  if (block?.type === "toolCall") return `running ${block.name}`;
  return null;
}

/** "provider/model" of a streaming assistant message, when the event carries one. */
function liveModelOf(msg: Record<string, unknown>): string | undefined {
  const provider = str(msg.provider);
  const model = str(msg.model);
  return provider && model ? `${provider}/${model}` : undefined;
}

function blocksFromContent(content: unknown): LiveBlock[] {
  if (!Array.isArray(content)) return [];
  const out: LiveBlock[] = [];
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c.type === "text") out.push({ type: "text", text: str(c.text) ?? "" });
    else if (c.type === "thinking") out.push({ type: "thinking", text: str(c.thinking) ?? "" });
    else if (c.type === "toolCall")
      out.push({ type: "toolCall", id: str(c.id) ?? "", name: str(c.name) ?? "tool", argsText: "", args: c.arguments });
  }
  return out;
}

/** The reply still streaming, if any. Not only the last entry: a message sent while the reply
    streams is appended after it, and the reply's later deltas and its end are still the reply's. */
function streamingAssistant(s: LiveState): Extract<LiveEntry, { kind: "assistant" }> | undefined {
  for (let i = s.entries.length - 1; i >= 0; i--) {
    const e = s.entries[i]!;
    if (e.kind === "assistant") return e.done ? undefined : e;
  }
  return undefined;
}

function lastAssistant(s: LiveState): Extract<LiveEntry, { kind: "assistant" }> {
  const current = streamingAssistant(s);
  if (current) return current;
  // Joined mid-message (e.g. after reconnect): start a fresh one.
  const entry: LiveEntry = { kind: "assistant", blocks: [], done: false };
  s.entries.push(entry);
  return s.entries[s.entries.length - 1] as Extract<LiveEntry, { kind: "assistant" }>;
}

function toolOutput(result: unknown): string {
  return isObj(result) ? contentText(result.content) : typeof result === "string" ? result : "";
}

const toolImages = (result: unknown) => (isObj(result) ? imagesFromContent(result.content) : []);

/**
 * The id a message of ours is known by everywhere after this: in `send_ack`, in the queue
 * snapshot, and in the removal that takes it back. Not `crypto.randomUUID()` alone — Sova is
 * routinely opened over plain http on the LAN (a phone against the laptop), and that call exists
 * only in a secure context, where its absence would throw inside `send` and lose the message.
 */
export function newClientId(): string {
  const uuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (uuid) return uuid();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Adds the user's prompt before the server echoes it, so the thread never lags the composer. */
export function addPendingPrompt(
  set: SetStoreFunction<LiveState>,
  text: string,
  images: string[] = [],
  uploads: UploadResult[] = [],
  id?: string,
) {
  const attachments = uploads.map((u): TmpAttachment => ({ path: u.path, name: u.name, mimeType: u.mimeType, size: u.size, available: true }));
  set(
    produce(
      (s) =>
        void s.entries.push({
          kind: "user",
          text,
          state: "sending",
          images,
          ...(id ? { id } : {}),
          ...(attachments.length ? { attachments } : {}),
        }),
    ),
  );
}

/**
 * One item of the server's queue snapshot (`queue`). `state` is the SERVER's word for how far the
 * item has got — "queued" = it holds it and a removal always succeeds; "sending" = handed to the
 * pi SDK, so a removal may come back refused. Neither is delivery: that is `message_start`.
 */
export interface QueuedItem {
  id: string;
  kind: "steer" | "followUp";
  state?: "queued" | "sending";
  text: string;
  images?: number;
  origin?: "client" | "server";
}

/**
 * The server's queue snapshot, applied to the rows on screen — the authority on what it still
 * holds, and on nothing else.
 *
 * A row the snapshot names is queued, and learns which queue holds it and whether it has already
 * been handed on. An id in the snapshot with no row is somebody else's queued message (a group
 * prompt, a remote status check) or one of ours from before a reconnect — it gets a row, which is
 * what makes a reconnect, and a second tab, rebuild the queue instead of losing it.
 *
 * ABSENCE IS NOT DELIVERY. A message leaves the queue by being delivered (`message_start`), or by
 * one of the four other ways `queue_item_gone` names — removed, cleared by Stop, a failed hand-off,
 * or dropped by an extension that handled it instead. That broadcast, and `message_start`, are the
 * only things that may say which happened. A snapshot that stops listing a row only proves the
 * server no longer holds it, so the row is marked `handed` and waits. Calling it delivered here
 * would put "sent" under a message a Stop had just taken back.
 *
 * A "sending" row the snapshot doesn't name is left alone entirely: the server may not have
 * reached it yet.
 */
export function applyQueue(set: SetStoreFunction<LiveState>, items: readonly QueuedItem[]) {
  set(
    produce((s) => {
      const byId = new Map(items.map((i) => [i.id, i]));
      const known = new Set<string>();
      for (const entry of s.entries) {
        if (entry.kind !== "user") continue;
        const item = entry.id ? byId.get(entry.id) : undefined;
        if (item) {
          known.add(item.id);
          entry.state = "queued";
          entry.queueKind = item.kind;
          entry.handed = item.state === "sending";
          if (item.origin) entry.origin = item.origin;
        } else if (entry.state === "queued") {
          entry.handed = true;
        }
      }
      for (const item of items) {
        if (known.has(item.id)) continue;
        s.entries.push({
          kind: "user",
          id: item.id,
          queueKind: item.kind,
          text: item.text,
          state: "queued",
          images: [],
          handed: item.state === "sending",
          ...(item.origin ? { origin: item.origin } : {}),
        });
      }
    }),
  );
}

/** A queued message left the queue for a reason that means it will never be sent — another tab's
    removal, a Stop, a refused hand-off, or an extension that handled it instead (`queue_item_gone`,
    broadcast to every client). Its row goes. */
export function markRemoved(set: SetStoreFunction<LiveState>, id: string) {
  set(
    produce((s) => {
      const i = s.entries.findIndex((e) => e.kind === "user" && e.id === id);
      if (i !== -1) s.entries.splice(i, 1);
    }),
  );
}

/**
 * The text of a queued row of ours, by id — what this tab actually sent, kept in the row since
 * `addPendingPrompt`. Used when a departure has to hand a message back but carries no text of its
 * own: the row is local knowledge, so the restore does not depend on the server choosing to put a
 * body on a broadcast. "" when no such row is here (another tab's message, or one already gone).
 */
/**
 * The messages of ours the server never delivered, for the paths that hand text back to the
 * composer: a chat-wide refusal (`busy`, `recent`, `config`) and, row by row, a failed or dropped
 * departure.
 *
 * `handedBack` is the ids whose text has ALREADY been returned, and every caller both consults it
 * and adds to it. That is what makes the two paths safe IN EITHER ORDER: a failed hand-off
 * broadcasts `queue_item_gone{failed, text}` AND an `error` whose code reaches the refusal path,
 * and the server does not close the socket, so both run. Keyed by id, never by text — two sends of
 * the same words are two messages, and suppressing by prose would swallow a legitimate restore of
 * something the user typed again.
 */
export function unsentRows(s: LiveState, handedBack?: ReadonlySet<string>): { id?: string; text: string }[] {
  return s.entries.flatMap((e) =>
    e.kind === "user" && e.state !== "delivered" && e.text && !(e.id && handedBack?.has(e.id)) ? [{ id: e.id, text: e.text }] : [],
  );
}

export function queuedText(s: LiveState, id: string): string {
  const entry = s.entries.find((e) => e.kind === "user" && e.id === id);
  return entry && entry.kind === "user" ? entry.text : "";
}

/** The server acknowledged one of our sends: `queued` says it went into the queue rather than
    straight to the agent. Until this lands the row is only "sending" — nothing holds it yet. */
export function markQueued(set: SetStoreFunction<LiveState>, clientId: string) {
  set(
    produce((s) => {
      const entry = s.entries.find((e) => e.kind === "user" && e.id === clientId);
      if (entry && entry.kind === "user" && entry.state === "sending") entry.state = "queued";
    }),
  );
}

/** A removal the server refused because the agent had already taken the message: the row says so
    by becoming what it now is. */
export function markDelivered(set: SetStoreFunction<LiveState>, id: string) {
  set(
    produce((s) => {
      const entry = s.entries.find((e) => e.kind === "user" && e.id === id);
      if (entry && entry.kind === "user") entry.state = "delivered";
    }),
  );
}

/**
 * Stop drained these queued prompts (`queue_cleared`, steers then follow-ups): drops the pending
 * row each one left and returns the text for the draft, joined like the TUI's Esc restore.
 */
export function takeBackQueued(set: SetStoreFunction<LiveState>, drained: string[]): string {
  set(
    produce((s) => {
      for (const text of drained) {
        const i = s.entries.findIndex((e) => e.kind === "user" && e.state !== "delivered" && e.text === text);
        if (i !== -1) s.entries.splice(i, 1);
      }
    }),
  );
  return drained.filter((t) => t.trim()).join("\n\n");
}

export function applyEvent(set: SetStoreFunction<LiveState>, event: unknown) {
  if (!isObj(event)) return;
  const type = str(event.type);
  set(
    produce((s) => {
      switch (type) {
        case "agent_start":
          s.running = true;
          break;
        case "agent_settled":
          s.running = false;
          s.activity = null;
          s.stopping = false;
          break;
        case "message_start": {
          const msg = isObj(event.message) ? event.message : {};
          if (msg.role === "assistant") {
            s.running = true;
            const model = liveModelOf(msg);
            s.entries.push({ kind: "assistant", blocks: blocksFromContent(msg.content), done: false, ...(model ? { model } : {}) });
          } else if (msg.role === "user") {
            // Which row this is, among the rows no start has claimed yet — NOT the undelivered
            // ones. A message sent mid-turn is reported delivered by id before its start arrives
            // (the SDK takes it off its queue before emitting the start, and SDK events wait for
            // the next frame here), so its row is usually "delivered" already. Leaving those out
            // gave the start no row, and a second copy of the message was appended.
            // Then: the SDK's own rule for taking a message off its queue — the first row with
            // that text; then the first row the server has reported delivered; only then the
            // first one still waiting. The last two are for the expansions (skills, templates,
            // vision delegates) whose text no longer matches what was typed. Matching text first
            // is what keeps two queued messages from swapping labels when the steer ahead of the
            // follow-up is delivered first. Each start claims one row, so the same words sent
            // twice are still two messages, and a start no row waits for is a new one.
            const text = contentText(msg.content);
            const open = s.entries.filter((e): e is Extract<LiveEntry, { kind: "user" }> => e.kind === "user" && !e.started);
            const row = open.find((e) => e.text === text) ?? open.find((e) => e.state === "delivered") ?? open[0];
            if (row) {
              row.state = "delivered";
              row.started = true;
            } else s.entries.push({ kind: "user", text, state: "delivered", started: true, images: imagesFromContent(msg.content) });
          }
          break;
        }
        case "message_update": {
          const ev = isObj(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
          if (!ev) break;
          const entry = lastAssistant(s);
          const i = typeof ev.contentIndex === "number" ? ev.contentIndex : entry.blocks.length;
          const delta = str(ev.delta) ?? "";
          const cur = entry.blocks[i];
          switch (ev.type) {
            case "text_start":
              entry.blocks[i] = { type: "text", text: "" };
              break;
            case "text_delta":
              if (cur?.type === "text") cur.text += delta;
              else entry.blocks[i] = { type: "text", text: delta };
              break;
            case "text_end":
              if (typeof ev.content === "string") entry.blocks[i] = { type: "text", text: ev.content };
              break;
            case "thinking_start":
              entry.blocks[i] = { type: "thinking", text: "" };
              break;
            case "thinking_delta":
              if (cur?.type === "thinking") cur.text += delta;
              else entry.blocks[i] = { type: "thinking", text: delta };
              break;
            case "thinking_end":
              if (typeof ev.content === "string") entry.blocks[i] = { type: "thinking", text: ev.content };
              break;
            case "toolcall_start":
              entry.blocks[i] = { type: "toolCall", id: str(ev.id) ?? "", name: str(ev.toolName) ?? "tool", argsText: "" };
              break;
            case "toolcall_delta":
              if (cur?.type === "toolCall") cur.argsText += delta;
              break;
            case "toolcall_end": {
              const tc = isObj(ev.toolCall) ? ev.toolCall : {};
              entry.blocks[i] = {
                type: "toolCall",
                id: str(tc.id) ?? (cur?.type === "toolCall" ? cur.id : ""),
                name: str(tc.name) ?? (cur?.type === "toolCall" ? cur.name : "tool"),
                argsText: cur?.type === "toolCall" ? cur.argsText : "",
                args: tc.arguments,
              };
              break;
            }
          }
          break;
        }
        case "message_end": {
          const msg = isObj(event.message) ? event.message : {};
          if (msg.role !== "assistant") break;
          const entry = lastAssistant(s);
          // message_end is authoritative.
          const model = liveModelOf(msg);
          if (model) entry.model = model;
          const blocks = blocksFromContent(msg.content);
          if (blocks.length) entry.blocks = blocks;
          entry.done = true;
          if (msg.stopReason === "error") entry.error = str(msg.errorMessage) ?? "The model returned an error";
          else if (msg.stopReason === "aborted") entry.stoppedAt = new Date().toISOString();
          break;
        }
        case "tool_execution_start": {
          const id = str(event.toolCallId);
          if (id) s.tools[id] = { name: str(event.toolName) ?? "tool", args: event.args, status: "running", output: "", images: [] };
          break;
        }
        case "tool_execution_update": {
          const id = str(event.toolCallId);
          const t = id ? s.tools[id] : undefined;
          if (t) {
            t.output = toolOutput(event.partialResult);
            t.images = toolImages(event.partialResult);
          }
          break;
        }
        case "tool_execution_end": {
          const id = str(event.toolCallId);
          if (!id) break;
          const prev = s.tools[id];
          s.tools[id] = {
            name: str(event.toolName) ?? prev?.name ?? "tool",
            args: prev?.args ?? event.args,
            status: event.isError === true ? "error" : "done",
            output: toolOutput(event.result),
            images: toolImages(event.result),
          };
          break;
        }
        case "auto_retry_start":
          s.activity = "Retrying after a provider error";
          break;
        case "compaction_start":
          s.activity = "Compacting context";
          break;
        case "auto_retry_end":
        case "compaction_end":
          s.activity = null;
          break;
      }
    }),
  );
}
