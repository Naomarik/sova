// The wire between the server and a chat in its own process (al_3 stage 2): one unix socket per chat,
// the chat process listening, the server dialing. Every frame is a u32 big-endian byte length, then
// that many bytes of UTF-8 JSON, one object with a string `t`. The payloads reuse shared/chat-runtime.ts
// (the stage-1 seam): commands are `ChatCall`/`ChatReply`, the mirror is a `ChatStateMirror` plus the
// runtime's own facts, browser frames pass through unparsed. Types and the pure codec only: nothing
// here touches a socket, a file or a process.
//
// Versions: each side speaks CHAT_WIRE_PROTO and accepts a peer in [N-1, N]. Kernel frames never
// change, so any server can hello, ping and drain any runtime whatever its proto; every other frame
// is additive only, and a frame whose `t` a side doesn't know is ignored (and logged once).
import type {
  ChatCall,
  ChatClientInfo,
  ChatLifecycleEvent,
  ChatRefusal,
  ChatReply,
  ChatRunEvent,
  ChatStateMirror,
  RunStartAnswer,
  ServerToolCall,
  ServerToolDecl,
  ServerToolOutcome,
  SpecialSpec,
  WorkerCursor,
  WorkerFeedFrame,
  WorkerKind,
  WorkerSpec,
  WorkerState,
} from "./chat-runtime";
import type { LlmProcessSnapshot } from "../pi-config/extensions/llm-inflight/tracker";
import type { HEntry } from "./harness-history";
import type { ReplyTiming } from "./harness-wire";
import type { ToolResult } from "./harness-tools";
import type { ChatClientMessage, SessionInsight, SessionSummary, TranscriptItem } from "./protocol";

/** 2 (al_3 stage 3): special loadouts (`open.special`), wait-asks, server actions, call-backs inside
    a served call, run events with acks, `push special`, keyed sends. A proto-1 peer gets ordinary
    chats only.
    3 (al_3 stage 4): worker chats (`open.worker`, the `feed` and `feedSince`), a parent chat's worker
    host over its link (`wk*`), the mirror's `worker` and `llm`. A proto-2 peer refuses `open.worker`
    ("needs protocol 3") and runs its own workers as before. */
export const CHAT_WIRE_PROTO = 3;
export const CHAT_WIRE_MIN_PROTO = 1;
/** A frame above this is a protocol error: the link closes. */
export const FRAME_MAX_BYTES = 64 * 1024 * 1024;
/** A frame above this is logged. */
export const FRAME_WARN_BYTES = 8 * 1024 * 1024;
/** Bytes waiting to go out on one link above which the runtime drops the link (the server resyncs). */
export const LINK_BACKLOG_MAX_BYTES = 128 * 1024 * 1024;
export const PING_EVERY_MS = 10_000;
/** Pings missed in a row before a link counts as lost. */
export const PINGS_MISSED_MAX = 3;

/** Whether a peer speaking `proto` and accepting down to `minProto` can talk to this side: each
    speaks at least what the other accepts (N and N-1 meet; N and N-2 don't). */
export const protoCompatible = (proto: number, minProto: number, own = { proto: CHAT_WIRE_PROTO, minProto: CHAT_WIRE_MIN_PROTO }): boolean =>
  Number.isInteger(proto) && proto >= own.minProto && own.proto >= minProto;

/** Why a chat process exits on purpose (anything else is a crash). */
export type ExitCause = "idle" | "reload" | "archived" | "closed" | "refused" | "operator" | "incompatible";

/** What the server tells each chat process it controls. */
export interface ChatRuntimeSettings {
  /** Minutes of quiet with nobody attached before an idle stop; 0: never (SOVA_CHAT_IDLE_MIN). */
  idleStopMin: number;
  /** Automatic reload with a browser attached: this much continuous quiet first. */
  reloadDwellMs: number;
  /** After a broker drop, how long the next server has for a browser to come back before open
      dialogs resolve with their defaults. */
  orphanGraceMs: number;
  /** How long a server-hosted call made with no server linked waits for one. */
  serverToolWaitMs: number;
}

export const DEFAULT_RUNTIME_SETTINGS: ChatRuntimeSettings = {
  idleStopMin: 30,
  reloadDwellMs: 300_000,
  orphanGraceMs: 60_000,
  serverToolWaitMs: 60_000,
};

/** Kernel frames: frozen forever. A runtime sends `hello` again on its controller link whenever its
    `state` changes (booting → ready → open → closing). */
export type KernelFrame =
  /** Runtime → server, first on every connection. `seq`: the last lifecycle seq; `epoch`: the highest
      controller epoch it has seen. */
  | {
      t: "hello";
      proto: number;
      minProto: number;
      build: string;
      pid: number;
      startedAt: number;
      unit: string;
      sessionId: string;
      path: string;
      state: "booting" | "ready" | "open" | "closing";
      seq: number;
      epoch: number;
    }
  /** Server → runtime: take this link as the controller. `since`: the last seq this server saw, or
      null for a fresh server (no replay: it reads the mirror). */
  | {
      t: "control";
      proto: number;
      epoch: number;
      serverPid: number;
      serverStartedAt: number;
      build: string;
      since: number | null;
      settings: ChatRuntimeSettings;
    }
  /** Either side, then it closes the link. */
  | { t: "refuse"; reason: "stale-epoch" | "busy-controller" | "proto"; message: string }
  | { t: "ping"; n: number }
  | { t: "pong"; n: number }
  /** Server → runtime: close down. Without `force`, only at a quiet moment (and, for `idle`, with
      nobody attached), else refused. */
  | { t: "drain"; id: string; reason: "idle" | "reload" | "archived" | "operator" | "incompatible"; force: boolean; message?: string }
  | { t: "drained"; id: string; ok: true }
  | { t: "drained"; id: string; ok: false; why: string }
  /** Runtime → server, just before an exit on purpose. */
  | { t: "exit"; cause: ExitCause }
  /** Server → runtime: a planned drop (the server is stopping); the chat runs on. */
  | { t: "bye"; reason: "server-stopping" };

/** The one chat's opening. */
export type ChatOpenFrame =
  | {
      t: "open";
      id: string;
      path: string;
      force: boolean;
      opening?: { model?: string; thinking?: string; fresh?: { model?: boolean; thinking?: boolean } };
      link: { origin: string; token: string } | null;
      /** The ordinary server-hosted tools' declarations, in loadout order. */
      served: ServerToolDecl[];
      /** A special loadout (proto 2): the chat opens as that kind, never as an ordinary chat. */
      special?: SpecialSpec;
      /** A worker chat's loadout (proto 3): the chat opens as that worker, never as an ordinary chat. */
      worker?: WorkerSpec;
    }
  | { t: "opened"; id: string; ok: true; mirror: ChatRuntimeMirror }
  | { t: "opened"; id: string; ok: false; refusal?: ChatRefusal; error?: { message: string } };

/** Browser frames (ChatClientFrame without the chat id: one chat per process). */
export type ChatClientWire =
  | { t: "client.attach"; clientId: string; client: ChatClientInfo }
  | { t: "client.msg"; clientId: string; msg: ChatClientMessage }
  | { t: "client.detach"; clientId: string }
  /** Runtime → server: written to that browser's socket as it is. */
  | { t: "client.send"; clientId: string; json: string };

/** Commands, server → runtime, and their one reply each. */
export type ChatCallWire = { t: "call"; call: ChatCall } | { t: "reply"; reply: ChatReply };

/** How the chat stands against the code its server runs (§6 of the stage-2 design). */
export interface ChatCodeState {
  state: "current" | "older" | "reloading" | "failed";
  /** A reload was asked for and waits for the reply to finish. */
  pending?: true;
  detail?: string;
}

/** The mirror of a chat in its own process: the stage-1 mirror plus what only the runtime knows. */
export interface ChatRuntimeMirror extends ChatStateMirror {
  build: string;
  startedAt: number;
  code: ChatCodeState;
  /** `quiet`: no run, compaction, start, web or agent queue, dialog, working worker or
      server-hosted call in flight, nor (proto 2) an unacked run fact, wait-ask or action. `since`:
      when quiet last began (or ended). */
  quiet: {
    quiet: boolean;
    since: number;
    clients: number;
    workersWorking: number;
    serverCalls: number;
    /** Run facts the server hasn't acked (proto 2; absent from a proto-1 runtime). */
    outbox?: number;
    /** Wait-asks and actions waiting on the server (proto 2; absent from a proto-1 runtime). */
    hooks?: number;
  };
  /** The chat's Claude CLI child, for the cap across chat processes. */
  claude: "none" | "idle" | "busy";
  /** What the server's resource monitor shows for the chat. */
  monitor: { title?: string; workers: ChatMonitorWorker[]; toolsRunning: number; lastToolEnd: number };
  /** A worker chat (proto 3): whose and what, so a server that takes the process back knows it; its
      feed's process id (WorkerCursor.proc), the seq of its last feed frame, and how its last run
      settled. A server that sees a seq beyond the frames it got missed some (no server was linked):
      it reads them from the process's ring (feedSince). */
  worker?: { parentSessionId: string; workerId: string; kind: WorkerKind; proc: string; seq?: number; lastSettled: WorkerState["lastSettled"] };
  /** This process's model-call counts (proto 3), counted into the server's in-flight view. */
  llm?: LlmProcessSnapshot;
}

/** A worker as the chat's subagents runtime published it, for the resource monitor (its own
    WorkerInfo, server/resource-monitor-attrib.ts; `pid` only while alive). */
export interface ChatMonitorWorker {
  id: string;
  name?: string;
  status?: string;
  backend?: string;
  pid?: number;
  sessionFile?: string;
  sessionId?: string;
  teamId?: string;
  lastActivity?: number;
}

/** The whole mirror whenever its JSON changed (coalesced), and before any reply to a call that changed it. */
export type ChatStateWire = { t: "state"; mirror: ChatRuntimeMirror };

/** Lifecycle events, numbered by the runtime and replayed from `control.since`. */
export type ChatEventWire =
  | { t: "event"; event: ChatLifecycleEvent }
  /** `since` fell out of the ring: the events from..to are gone; consumers resync off the mirror. */
  | { t: "events.gap"; from: number; to: number }
  /** The chat wrote its file: the server's session list is built afresh (coalesced). */
  | { t: "touched" };

/** What a server-hosted tool reads of the chat, beyond the call (the server builds its ToolCtx from it). */
export interface ServerToolCtxWire {
  sessionId: string;
  cwd: string;
  leafId: string | null;
  title: string | null;
}

/** Server-hosted tools: the runtime calls, the server answers with updates then one result. */
export type ServerToolWire =
  | { t: "tool.call"; call: ServerToolCall; ctx: ServerToolCtxWire }
  | { t: "tool.update"; effectId: string; update: ToolResult }
  /** `outcome.result`: a tool's ToolResult, or a server action's own result (proto 2). */
  | { t: "tool.result"; effectId: string; outcome: ServerToolOutcome<unknown> }
  | { t: "tool.abort"; effectId: string };

/** Asks: the chat asking about server state. No side effects; safe to repeat. */
export interface ChatAsks {
  "project.note": { args: { cwd: string; sessionId: string; leafId: string | null }; result: string | null };
  "playbook.bundleFor": { args: { sessionId: string; hint: unknown }; result: unknown | null };
  "playbook.reprime": { args: { sessionId: string; leafId: string | null }; result: { block: string; playbook: string; sha: string } | null };
  links: { args: { sessionId: string; path: string }; result: unknown[] };
  singleton: { args: { key: string; path: string }; result: { id: string; path: string; title: string } | null };
  /** A session's measured replies by entry (server/reply-facts.ts), for its rows' `reply` fact. */
  "reply.timings": { args: { sessionId: string }; result: { v: string; timings: Record<string, ReplyTiming> } | null };
  /** The offer tool's note of a run button's outcome (§chat.offers/card), server/session-offers.ts. */
  "offers.note": { args: { sessionId: string }; result: string | null };
  // proto 2, policy "wait":
  "special.runStart": { args: { leafId: string | null; images: boolean }; result: RunStartAnswer };
  "special.compact": { args: { leafId: string | null }; result: RunStartAnswer["message"] | null };
  "special.agentEnd": { args: { text: string }; result: RunStartAnswer["message"] | null };
  "powers.sessions": { args: Record<string, never>; result: SessionSummary[] };
  "powers.session": { args: { id: string }; result: SessionSummary | null };
  "powers.transcript": { args: { path: string }; result: TranscriptItem[] };
  "powers.insight": { args: { path: string }; result: SessionInsight | null };
  "powers.held": { args: { path: string }; result: { streaming: boolean; queued: number } | null };
  "powers.projectRoot": { args: { cwd: string }; result: string | null };
}
export type ChatAskMethod = keyof ChatAsks;

/**
 * What an ask does without a server. "nothing": with no controller linked, or after 10 s, it reads
 * as nothing (the stage-2 asks: a missing note or link list is harmless). "wait": queued while no
 * controller is linked and sent again to the next one; after serverToolWaitMs it fails (the caller
 * falls back to its last answer, or fails its tool with NOT_RUN_NO_SERVER).
 */
export const ASK_POLICY: Record<ChatAskMethod, "nothing" | "wait"> = {
  "project.note": "nothing",
  "playbook.bundleFor": "nothing",
  "playbook.reprime": "nothing",
  links: "nothing",
  singleton: "nothing",
  "reply.timings": "nothing",
  "offers.note": "nothing",
  "special.runStart": "wait",
  "special.compact": "wait",
  "special.agentEnd": "wait",
  "powers.sessions": "wait",
  "powers.session": "wait",
  "powers.transcript": "wait",
  "powers.insight": "wait",
  "powers.held": "wait",
  "powers.projectRoot": "wait",
};

/** Server actions (proto 2): calls that change server state but are no model's tool. They ride the
    tool.call / tool.update / tool.result / tool.abort frames under these reserved names, with the
    same effect ids and the same "outcome unknown" and "didn't run" rules, and are never declared to
    a model. */
export const SERVER_ACTIONS = ["@clientSend", "@clientSendRefused", "@saveChoice", "@powers.send"] as const;
export type ServerActionName = (typeof SERVER_ACTIONS)[number];
export type ChatAskWire =
  | { t: "ask"; id: string; method: ChatAskMethod; args: unknown }
  | { t: "answer"; id: string; ok: true; result: unknown }
  | { t: "answer"; id: string; ok: false; error: { message: string } };

/** Pushes, server → runtime: idempotent snapshots. */
export type ChatPushWire =
  | { t: "push"; kind: "link-live"; ids: string[] }
  | { t: "push"; kind: "links-changed"; sessionIds: string[] }
  | { t: "push"; kind: "build"; build: string }
  | { t: "push"; kind: "settings"; settings: ChatRuntimeSettings }
  /** The rollout's word on this chat's code: a replacement is starting, or failed to (`detail`). */
  | { t: "push"; kind: "code"; state: ChatCodeState["state"]; detail?: string }
  /** A special loadout's composer closed (why) or open again (null) (proto 2; sent at control and
      whenever it may have changed). */
  | { t: "push"; kind: "special"; composerClosed: string | null };

/**
 * Call-backs inside a served call (proto 2), server → runtime, each answered once: the tool appends
 * a state record to the chat (`announce`: through the special extension, so entry_appended fires),
 * or runs a tool the chat registered (the subagents extension's) with the call's own ctx and abort.
 * A call-back whose parent call is no longer pending is refused.
 */
export type ToolBackWire =
  | { t: "tool.back"; effectId: string; id: string; op: "append"; kind: string; data: unknown; announce: boolean }
  | { t: "tool.back"; effectId: string; id: string; op: "tool"; name: string; toolCallId: string; params: unknown }
  | { t: "tool.backResult"; id: string; ok: true; result: { entryId: string; entry: HEntry } | ToolResult }
  | { t: "tool.backResult"; id: string; ok: false; error: { message: string } };

/**
 * A special loadout's run events (proto 2), runtime → server, in the order the chat has them; `n`
 * increases per process. Facts (run.start, user.entered, user.end, run.settled) are kept until acked
 * and sent again, in order, at the next control; ticks (reply.text, message.end, entry.appended) are
 * dropped while no server is linked. `run.ack` is cumulative, sent after handling (batched ≤ 200 ms).
 */
export type ChatRunWire = { t: "run"; n: number; event: ChatRunEvent } | { t: "run.ack"; n: number };

/** Runtime → server, additive: the step its start (until its hello says ready) or its open (until its
    `opened`) is in, on entering each step and every 10 s (§app.chat-processes/boot-log). Sova's own
    step names; a server that hears none (older code) knows no step. */
export type ChatBootWire = { t: "boot"; phase: "starting" | "opening"; step: string; stepMs: number; totalMs: number };

/** The runtime asks the server's rollout to reload it on current code. */
export type ChatRequestWire = { t: "reload.request"; auto: boolean };

/** A worker chat's feed (proto 3), runtime → server: each pi event of WORKER_FEED_EVENTS, as the
    wire-1 frame its panes get, numbered per process. */
export type WorkerFeedWire = { t: "feed"; cursor: WorkerCursor; event: unknown };

/**
 * A parent chat's worker host over its link (proto 3). Ops are idempotent (keys on start and send;
 * stop and abort repeat harmlessly), so the runtime sends an unanswered `wk` again at the next
 * control, and each watch again with its last cursor; after serverToolWaitMs with no server, the op
 * fails with NOT_RUN_NO_SERVER.
 */
export type WorkerHostWire =
  | { t: "wk"; id: string; op: "start" | "send" | "abort" | "stop" | "list"; args: unknown }
  | { t: "wk.watch"; chatId: string; cursor: WorkerCursor | null }
  | { t: "wk.unwatch"; chatId: string }
  | { t: "wk.result"; id: string; ok: true; result: unknown }
  | { t: "wk.result"; id: string; ok: false; error: { message: string; code?: string } }
  | { t: "wk.feed"; chatId: string; frame: WorkerFeedFrame };

export type ChatWireFrame =
  | KernelFrame
  | ChatOpenFrame
  | ChatClientWire
  | ChatCallWire
  | ChatStateWire
  | ChatEventWire
  | ServerToolWire
  | ToolBackWire
  | ChatRunWire
  | ChatAskWire
  | ChatPushWire
  | ChatRequestWire
  | ChatBootWire
  | WorkerFeedWire
  | WorkerHostWire;

export type ChatWireType = ChatWireFrame["t"];
export type FrameOf<T extends ChatWireType> = Extract<ChatWireFrame, { t: T }>;

/** The text a server-hosted call gets when the server restarted while it ran (al_3 q5). */
export const OUTCOME_UNKNOWN =
  "The Sova server restarted while this action ran, so its outcome is unknown. Check whether it took effect before you try it again.";
/** The text a server-hosted call gets when no server came in time to run it. */
export const NOT_RUN_NO_SERVER = "The Sova server isn't answering, so this action didn't run. Try it again in a minute.";

// ---- codec ----------------------------------------------------------------------------------------

/** A broken stream: the link that read it closes. */
export class FrameError extends Error {}

const encoder = new TextEncoder();

/** One frame as bytes: its length, then its JSON. Throws FrameError above FRAME_MAX_BYTES. */
export function encodeFrame(frame: ChatWireFrame | { t: string }, max = FRAME_MAX_BYTES): Uint8Array {
  const body = encoder.encode(JSON.stringify(frame));
  if (body.length > max) throw new FrameError(`frame ${frame.t} is ${body.length} bytes, above the ${max}-byte limit`);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

/**
 * Reads frames off a byte stream, whatever the chunk boundaries. `push` returns the frames each
 * chunk completes, in order; a frame above `max`, a zero-length frame, bytes that aren't UTF-8, JSON
 * that isn't an object with a string `t`: FrameError, and the decoder is spent (the link closes).
 */
export class FrameDecoder {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private need: number | null = null;
  private broken: FrameError | null = null;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });

  constructor(
    private readonly opts: { max?: number; warnAt?: number; onLarge?: (bytes: number) => void } = {},
  ) {}

  /** Bytes read but not yet a frame. */
  get pending(): number {
    return this.buffered;
  }

  push(chunk: Uint8Array): { t: string; [k: string]: unknown }[] {
    if (this.broken) throw this.broken;
    if (chunk.length) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const out: { t: string; [k: string]: unknown }[] = [];
    try {
      for (;;) {
        if (this.need === null) {
          if (this.buffered < 4) break;
          const head = this.take(4);
          const n = new DataView(head.buffer, head.byteOffset, 4).getUint32(0, false);
          const max = this.opts.max ?? FRAME_MAX_BYTES;
          if (n === 0) throw new FrameError("a zero-length frame");
          if (n > max) throw new FrameError(`a ${n}-byte frame, above the ${max}-byte limit`);
          if (n > (this.opts.warnAt ?? FRAME_WARN_BYTES)) this.opts.onLarge?.(n);
          this.need = n;
        }
        if (this.buffered < this.need) break;
        const body = this.take(this.need);
        this.need = null;
        let text: string;
        try {
          text = this.utf8.decode(body);
        } catch {
          throw new FrameError("a frame that isn't UTF-8");
        }
        let v: unknown;
        try {
          v = JSON.parse(text);
        } catch {
          throw new FrameError("a frame that isn't JSON");
        }
        if (!v || typeof v !== "object" || Array.isArray(v) || typeof (v as { t?: unknown }).t !== "string")
          throw new FrameError("a frame that isn't an object with a type");
        out.push(v as { t: string });
      }
    } catch (err) {
      this.broken = err instanceof FrameError ? err : new FrameError(String(err));
      this.chunks = [];
      this.buffered = 0;
      throw this.broken;
    }
    return out;
  }

  /** The first `n` buffered bytes (n ≤ buffered), removed from the buffer. */
  private take(n: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.length >= n) {
      const head = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return head;
    }
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0]!;
      const k = Math.min(c.length, n - at);
      out.set(c.subarray(0, k), at);
      at += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.buffered -= n;
    return out;
  }
}
