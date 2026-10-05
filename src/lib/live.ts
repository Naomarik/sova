// Assembles the in-progress agent run from live events, in the harness contract's words (SovaEvent,
// shared/harness-wire.ts): a wire-2 frame carries one, a wire-1 frame maps through `fromV1`
// (shared/wire-v1.ts, `liveEventsOf`). The store holds only what streamed since the last settle; on
// run.settled the chat view refetches the normalized transcript and resets this.

import { produce, type SetStoreFunction } from "solid-js/store";
import type { SovaEvent, SovaPart } from "../../shared/harness-wire";
import { isLinkMessage } from "../../shared/link-message";
import { parseTopicBatch } from "../../shared/topic-message";
import type { TmpAttachment, UploadResult, V1EventFrame, V2EventFrame } from "../../shared/protocol";
import { fromV1 } from "../../shared/wire-v1";
import {
  compactionEndEffects,
  compactionStartEffects,
  NO_VIEW,
  replyEndEffects,
  settleEffects,
  toolEndEffects,
  turnStartEffects,
  type LiveEffect,
  type LiveEffectsContext,
} from "./live-effects";
import { isObj } from "./message";

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
          nobody here authored. Absent only for a row rebuilt from a bare message.start. */
      id?: string;
      /** Which queue holds it while it is queued. */
      queueKind?: "steer" | "followUp";
      /** The message is out of the queue's reach: the server has handed it to the pi SDK, or a
          snapshot no longer lists it. Not a claim about WHY it left — only `message_start` says
          delivered, a removal says removed and `queue_cleared` says a Stop took it back. */
      handed?: boolean;
      /** The agent's own `message.start` for this message has been applied to this row, so no
          later start may claim it. Not the same fact as `state: "delivered"`: the server reports a
          delivery by id (`queue_item_gone`, a `consumed` refusal) BEFORE the start, so a delivered
          row can still be waiting for its start. */
      started?: boolean;
      /** The transcript entry the message was written as: its `message.end`'s `entryId`
          (§chat.transcript/rendering, "Switching back": the row this one becomes). */
      entryId?: string;
      /** Who put it in the queue: "server" is a prompt this session made for itself (a group
          message, a remote status check), which we render but never claim you typed. */
      origin?: "client" | "server";
      /** The Overseer queued it (`QueueItem.overseer`): the row reads "Overseer", not "Sent by Sova". */
      overseer?: boolean;
      /** Another session queued it (`QueueItem.fromSession`): the row reads "From {title}". */
      fromSession?: { sessionId: string; title: string };
      /** A baton session's sender (person id or "operator"), from its `sova-baton-sent` marker while
          the row is still live (§app.baton/attribution). */
      by?: string;
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
      /** "provider/model" producing this message, from message.start/message.end. */
      model?: string;
      error?: string;
      /** ISO time the message ended as aborted. */
      stoppedAt?: string;
      /** The transcript entry the message was written as (its `message.end`'s `entryId`). */
      entryId?: string;
    };

export interface LiveTool {
  name: string;
  args?: unknown;
  status: "running" | "done" | "error";
  output: string;
  images: string[];
  /** The result's `details` (a tool's structured payload: the Overseer's navigate target, its confirm). */
  details?: unknown;
}

export interface LiveState {
  entries: LiveEntry[];
  tools: Record<string, LiveTool>;
  /** True from run.start (or hello.isStreaming) until run.settled. */
  running: boolean;
  /** What the agent is doing besides generating, e.g. retrying or compacting. */
  activity: string | null;
  /** The user pressed Stop and the run hasn't settled yet. */
  stopping: boolean;
}

export const emptyLive = (): LiveState => ({ entries: [], tools: {}, running: false, activity: null, stopping: false });

/** Which of the run-status row's three icons the turn shows (§chat.transcript/streaming). */
export type RunStep = "thinking" | "writing" | "tool";

/** Run-status detail: the step, and its words ("running bash" / "thinking" / "writing") for the
    tooltip and the accessible name. Null between blocks. */
export interface RunDetail {
  step: RunStep;
  text: string;
}

export function runDetail(s: LiveState): RunDetail | null {
  const running = Object.values(s.tools).find((t) => t.status === "running");
  if (running) return { step: "tool", text: `running ${running.name}` };
  const last = streamingAssistant(s);
  if (!last) return null;
  const block = [...last.blocks].reverse().find(Boolean);
  if (block?.type === "thinking") return { step: "thinking", text: "thinking" };
  if (block?.type === "text") return { step: "writing", text: "writing" };
  if (block?.type === "toolCall") return { step: "tool", text: `running ${block.name}` };
  return null;
}

/** Whether block `i` of an assistant entry still streams (its live dot): while the entry does, and
    for thinking only until a later block starts, so its dot never pulses beside the reply's head
    (§chat.transcript/transcript-items). `blocks` can have holes, as in runDetail. */
export function blockStreams(entry: { blocks: LiveBlock[]; done: boolean }, i: number): boolean {
  if (entry.done) return false;
  return entry.blocks[i]?.type !== "thinking" || !entry.blocks.slice(i + 1).some(Boolean);
}

function blocksOf(parts: readonly SovaPart[]): LiveBlock[] {
  return parts.map((p): LiveBlock => (p.kind === "toolCall" ? { type: "toolCall", id: p.id, name: p.name, argsText: "", args: p.args } : { type: p.kind, text: p.text }));
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
  overseer?: boolean;
  fromSession?: { sessionId: string; title: string };
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
          if (item.overseer) entry.overseer = true;
          if (item.fromSession) entry.fromSession = item.fromSession;
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
          ...(item.overseer ? { overseer: true } : {}),
          ...(item.fromSession ? { fromSession: item.fromSession } : {}),
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

/** The live-only event a baton sender marker becomes (see applyEvent). */
export const BATON_SENT_EVENT = "sova_baton_sent";

/** What applyEvent takes: a live event off the wire, or the client-local baton sender marker. */
export type LiveEvent = SovaEvent | { type: typeof BATON_SENT_EVENT; by: string };

/** A live event frame's events: a wire-2 frame's own, a wire-1 frame's mapped (an older server, or
    one that wasn't asked; a message_end's `entryId` lands inside its `message.end`). */
export function liveEventsOf(frame: V1EventFrame | V2EventFrame): SovaEvent[] {
  return "v" in frame && frame.v === 2 ? (isObj(frame.event) ? [frame.event] : []) : fromV1(frame);
}

/** What an event with no effects returns: one shared array, never written. */
const NO_EFFECTS: LiveEffect[] = Object.freeze([]) as unknown as LiveEffect[];

/** A part event (the most frequent, a delta on every streamed token) on the store: it has no effects. */
function applyPart(s: LiveState, event: Extract<SovaEvent, { type: "part.start" | "part.delta" | "part.end" }>): void {
  const entry = lastAssistant(s);
  const i = event.index ?? entry.blocks.length;
  const cur = entry.blocks[i];
  if (event.type === "part.start") {
    if (event.kind === "toolCall") entry.blocks[i] = { type: "toolCall", id: event.id ?? "", name: event.name ?? "tool", argsText: "" };
    else entry.blocks[i] = { type: event.kind, text: "" };
  } else if (event.type === "part.delta") {
    if (event.kind === "toolCall") {
      if (cur?.type === "toolCall") cur.argsText += event.delta;
    } else if (cur?.type === event.kind) cur.text += event.delta;
    else entry.blocks[i] = { type: event.kind, text: event.delta };
  } else if (event.kind === "toolCall") {
    entry.blocks[i] = {
      type: "toolCall",
      id: event.id ?? (cur?.type === "toolCall" ? cur.id : ""),
      name: event.name ?? (cur?.type === "toolCall" ? cur.name : "tool"),
      argsText: cur?.type === "toolCall" ? cur.argsText : "",
      args: event.args,
    };
  } else if (event.text !== undefined) entry.blocks[i] = { type: event.kind, text: event.text };
}

/**
 * Applies one live event to the store, and returns what it does besides (live-effects.ts), for the
 * chat view to run: `view` says whose view it lands in.
 */
export function applyEvent(set: SetStoreFunction<LiveState>, event: LiveEvent, view: LiveEffectsContext = NO_VIEW): LiveEffect[] {
  if (event.type === "part.start" || event.type === "part.delta" || event.type === "part.end") {
    set(produce((s) => applyPart(s, event)));
    return NO_EFFECTS;
  }
  let effects = NO_EFFECTS;
  set(
    produce((s) => {
      switch (event.type) {
        case "run.start":
          effects = turnStartEffects();
          s.running = true;
          break;
        case "run.settled":
          effects = settleEffects();
          s.running = false;
          s.activity = null;
          s.stopping = false;
          break;
        case "message.start": {
          if (event.role === "assistant") {
            s.running = true;
            const model = event.model;
            s.entries.push({ kind: "assistant", blocks: blocksOf(event.parts), done: false, ...(model ? { model } : {}) });
          } else {
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
            // The text comes without pi 0.87's image resize notes, as the transcript shows it —
            // which also lets the row this tab sent match by its typed text.
            const text = event.text;
            // A link message (§mesh.links/transcript) is a partner's, handed to the agent by the
            // server: never a row of this tab's, so it claims none and draws none.
            if (isLinkMessage(text)) break;
            // A topic batch (§chat.topics/row) is the server's own start, like a wake: nothing this
            // tab is waiting to send ever has its text, so it claims no pending row — which would
            // mark that row delivered and duplicate it when its own start arrives — and draws its
            // own, which Thread renders as the Queue card.
            const batch = parseTopicBatch(text) !== null;
            const open = s.entries.filter((e): e is Extract<LiveEntry, { kind: "user" }> => e.kind === "user" && !e.started);
            const row = batch ? undefined : open.find((e) => e.text === text) ?? open.find((e) => e.state === "delivered") ?? open[0];
            if (row) {
              row.state = "delivered";
              row.started = true;
            } else s.entries.push({ kind: "user", text, state: "delivered", started: true, images: event.images });
          }
          break;
        }
        // Not a wire event: ChatView queues it when a baton sender marker arrives, so it applies in
        // order after the message.start it follows. The marker names an entry id a live row doesn't
        // have yet; it belongs to the newest started row no marker has named.
        case BATON_SENT_EVENT: {
          const by = typeof event.by === "string" ? event.by : undefined;
          const row = [...s.entries].reverse().find((e): e is Extract<LiveEntry, { kind: "user" }> => e.kind === "user" && !!e.started && !e.by);
          if (row && by) row.by = by;
          break;
        }
        case "message.end": {
          // The entry it was written as.
          const entryId = event.entryId;
          if (event.role === "user") {
            // The row its start claimed: the newest started one no end has named yet.
            const row = [...s.entries].reverse().find((e): e is Extract<LiveEntry, { kind: "user" }> => e.kind === "user" && !!e.started && !e.entryId);
            if (row && entryId) row.entryId = entryId;
            break;
          }
          effects = replyEndEffects(event);
          const entry = lastAssistant(s);
          if (entryId) entry.entryId = entryId;
          // message.end is authoritative.
          if (event.model) entry.model = event.model;
          const blocks = blocksOf(event.parts);
          if (blocks.length) entry.blocks = blocks;
          entry.done = true;
          if (event.stop === "error") entry.error = event.error ?? "The model returned an error";
          else if (event.stop === "aborted") entry.stoppedAt = new Date().toISOString();
          break;
        }
        case "tool.start":
          if (event.callId) s.tools[event.callId] = { name: event.name, args: event.args, status: "running", output: "", images: [] };
          break;
        case "tool.update": {
          const t = event.callId ? s.tools[event.callId] : undefined;
          if (t) {
            t.output = event.output;
            t.images = event.images;
          }
          break;
        }
        case "tool.end": {
          effects = toolEndEffects(event, view);
          const id = event.callId;
          if (!id) break;
          const prev = s.tools[id];
          s.tools[id] = {
            name: event.name ?? prev?.name ?? "tool",
            args: prev?.args ?? event.args,
            status: event.isError ? "error" : "done",
            output: event.output,
            images: event.images,
            ...(event.details !== undefined ? { details: event.details } : {}),
          };
          break;
        }
        case "activity":
          if (event.phase === "start") {
            if (event.what === "compaction") effects = compactionStartEffects();
            s.activity = event.what === "retry" ? "Retrying after a provider error" : "Compacting context";
          } else if (event.what === "retry") s.activity = null;
          else {
            effects = compactionEndEffects(event);
            s.activity = null;
            // A /compact runs with no turn, so no run.settled follows to clear a Stop pressed during
            // it; inside a turn (pi's automatic compaction) the turn's own settle still does.
            if (!s.running) s.stopping = false;
          }
          break;
      }
    }),
  );
  return effects;
}
