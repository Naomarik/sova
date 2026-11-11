import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { cappedWebSocketServer, streamWebSocketServer } from "./runtime-quirks";
import type { ChatClientMessage, ChatServerMessage, LlmFeedMessage, SessionFeedMessage, V2EventFrame, WatchServerMessage } from "../shared/protocol";
import { refuseUpgrade } from "./auth";
import { type NotPage, notPageSocket, yourClickBody } from "./page-only";
import { onCardNews } from "./transcript-cards";
import { chatClosedToKeys, EXTENSION_CHAT_DOOR, extensionFrameRefusal } from "./extension-doors";
import { sandboxAfterRewind, sandboxCommand, sandboxLowers } from "./sandbox-state";
import { isDirectLocal } from "./compression";
import { acquireChatHandle, ArchivedError, BusyError, ConfigError, type ChatClient } from "./chat-handle";
import { normalizeClaudeText, resolveClaudeSession } from "./claude-transcript";
import { resolveSessionPath } from "./paths";
import { onDesignNews } from "./design/live";
import { trackViewer } from "./seen";
import { nudgeMarks, sessionFeed } from "./session-feed";
import { llmInflight } from "./llm-inflight";
import { idOf } from "./sessions-index";
import { sessionsChanged } from "./list-generation";
import { extensionSocketRoute, upgradeExtensionSocket } from "./extensions";
import { meshUpgrade } from "./mesh";
import { EVENTS_PATH } from "../shared/events";
import { upgradeEventsSocket } from "./events-ws";
import { type Normalize, SessionTail } from "./watch";
import { sharedWorkerWindowResolver } from "./models";
import { contextTally, type Format, type WindowResolver } from "./worker-context";
import { wireOf } from "./wire-rows";
import { replyTimingsOf, sessionIdOfPath } from "./reply-facts";
import { CHAT_CLOSED_CLOSE_CODE, HAVE_MAX_CHARS, HAVE_PARAM, type WireVersion } from "../shared/protocol";
import { unsentRefusal } from "../shared/chat-runtime";
import { draftTexts, HeldSends, type Unsent } from "../shared/held-sends";
import { putBackDraft } from "./drafts";
import { SHELL_NOT_PAGE_TEXT } from "./chat-shell";
import { COMPOSER_PARAM } from "../shared/wire-areas";
import { writingRefused } from "./wire-gate";
import { opNote, stallGauge } from "./stall-recorder";
import { feedFrameJson } from "./feed-frame-json";

/** How long a chat socket that closed stays in its chat to hear what became of the messages it
    sent (§chat.transcript/send-while-starting): taken, or refused and put back as the draft. */
export const GONE_LISTEN_MS = 120_000;

function sendJson(ws: WebSocket, msg: ChatServerMessage | V2EventFrame | WatchServerMessage | SessionFeedMessage | LlmFeedMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    const json = JSON.stringify(msg);
    opNote("ws frame", json.length);
    ws.send(json);
  } catch (err) {
    console.error("[ws] send failed", err);
  }
}

/** A message already serialized: made once for every client that gets it. */
function sendRaw(ws: WebSocket, json: string): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    opNote("ws frame", json.length);
    ws.send(json);
  } catch (err) {
    console.error("[ws] send failed", err);
  }
}

/** The user's message as it goes to the chat: with a decision's held note when one waits for their answer there. */
export async function withHeldNote(sessionId: string, path: string, text: string, decision?: string): Promise<string> {
  const [{ topicStore }, { chatPaused, takeHeldNote }, { formatHeldNote }] = await Promise.all([import("./topics"), import("./merge-queue/channel"), import("../shared/topic-message")]);
  if (topicStore().mergeQueueTopic(sessionId)) chatPaused(sessionId, false);
  const note = await takeHeldNote({ sessionId, path }, text, decision);
  return note ? formatHeldNote(text, note) : text;
}

/** What a client asked of the transcript: all of it (legacy), newest rows first with the rest
    pushed (`?tail=1`), or newest rows alone, the rest fetched over REST (`?tail=rest`, with
    `prefetch` for a browser on this machine connecting directly: it may as well fetch it all). */
type TailAsk = { tail: false } | { tail: true; pull: false } | { tail: true; pull: true; prefetch: boolean };

/** `?have=` on a `?tail=rest` chat socket: the last row the browser holds (§chat.transcript/instant-open);
    anything empty or longer than HAVE_MAX_CHARS is ignored. */
export function haveOf(params: URLSearchParams, ask: TailAsk): string | undefined {
  const have = params.get(HAVE_PARAM);
  return ask.tail && ask.pull && have && have.length <= HAVE_MAX_CHARS ? have : undefined;
}

/** `viewer: false`: a script's action (server/chat-actions.ts), not a pane on screen: the session
    is not stamped seen and its marks are not nudged. Every other caller leaves it out. */
interface ChatSocketOpts {
  viewer?: boolean;
  /** This socket stated another writing number: each frame gets this sentence and does nothing,
      while the socket stays open and live (§mesh.compatibility/refusal). */
  refused?: string;
  /** Who this socket is when it isn't the operator's page; only a socket the main listener judged leaves it null. */
  notPage?: NotPage | null;
  /** The Stop Command entry's recording socket: its one `shell_stop` goes through, whoever asked. */
  stopsCommand?: boolean;
}

async function handleChat(ws: WebSocket, path: string, force: boolean, ask: TailAsk, wire: WireVersion, have?: string, opts: ChatSocketOpts = {}): Promise<void> {
  const id = idOf(path);
  const viewer = opts.viewer !== false;
  const who: NotPage | null = opts.notPage === undefined ? "local" : opts.notPage;
  /** Rewinds this socket sent that are still being checked (toChat). */
  let checking = 0;
  /** One frame into the chat. `/sandbox` typed in the page's composer runs; from anything else a lowering is refused
      (§app.access/your-click), the send's refusal reaching this socket like any other. */
  const toChat = (open: NonNullable<typeof chat>, msg: ChatClientMessage) => {
    // A command from shell mode is typed at a message box: the page's here, or a page on another computer through a
    // peer (§chat.shell-mode/who). A script's, a chat's, an extension's or the Overseer's socket runs none and stops
    // none: `shell` hears why, so nothing waits on it; `shell_stop` has no answer of its own and does nothing.
    // Stop Command's entry (chat.shell.stop, server/chat-actions.ts) is the one exception: it only stops.
    if (who !== null && who !== "local" && (msg.type === "shell" || (msg.type === "shell_stop" && !opts.stopsCommand))) {
      if (msg.type === "shell") client.send({ type: "shell_refused", clientId: String(msg.clientId ?? ""), reason: "unavailable", message: SHELL_NOT_PAGE_TEXT });
      return;
    }
    // Who stopped a command is the socket's to say, never the frame's: the entry's stop reads "Stopped", a page's "Stopped by you".
    if (msg.type === "shell_stop") {
      const { by: _by, ...stop } = msg as typeof msg & { by?: unknown };
      return passOn(open, (opts.stopsCommand && who !== null ? { ...stop, by: "other" } : stop) as ChatClientMessage);
    }
    // A key sends no frame at all into an overseer's, a baton's or the merge queue's chat (§app.extensions/not-you).
    if (who === "extension") {
      checking++;
      chatClosedToKeys(path)
        .then(
          (closed) => {
            if (!closed) return passOn(open, msg);
            const clientId = (msg as { clientId?: unknown }).clientId;
            client.send({ type: "error", code: "refused", message: EXTENSION_CHAT_DOOR, ...(typeof clientId === "string" && clientId ? { clientId } : {}) });
          },
          (err) => client.send({ type: "error", code: "internal", message: err instanceof Error ? err.message : String(err) }),
        )
        .finally(() => {
          checking--;
          if (gone && held.size === 0 && checking === 0) leave();
        });
      return;
    }
    passOn(open, msg);
  };
  /** While a page message waits for its held note, later frames wait behind it, so they go on in the order sent. */
  let lane: Promise<void> = Promise.resolve();
  let inLane = 0;
  const later = (fn: () => void) => {
    inLane++;
    lane = lane.then(fn).finally(() => void inLane--);
  };
  const passOn = (open: NonNullable<typeof chat>, msg: ChatClientMessage) => {
    // A card's click opens a turn that may act on what the card names, so it is the person's, never a script's or a
    // chat's (§app.access/your-click). A click relayed by a peer stays as it was: a page on another computer sends one.
    if (who !== null && who !== "local" && msg.type === "prompt" && msg.confirm) {
      client.send({ type: "error", code: "refused", message: yourClickBody("cardClick", who).error, ...(msg.clientId ? { clientId: msg.clientId } : {}) });
      return;
    }
    // The user's own message from this machine's page (§chat.merge-queue/decision): it lets the merge queue's requests
    // through after a Stop, and a decision's held note waiting for their answer here goes with it, in one turn. Never a
    // card's click, a script's, a chat's or a key's frame.
    if (who === null && (msg.type === "prompt" || msg.type === "steer") && !(msg.type === "prompt" && msg.confirm) && typeof msg.text === "string" && msg.text.trim()) {
      checking++;
      const sent = msg;
      inLane++;
      lane = lane
        .then(() => withHeldNote(id, path, sent.text, typeof sent.decision === "string" && sent.decision ? sent.decision : undefined))
        .then(
          (text) => route(open, text === sent.text ? sent : { ...sent, text }),
          () => route(open, sent),
        )
        .finally(() => {
          inLane--;
          checking--;
          if (gone && held.size === 0 && checking === 0) leave();
        });
      return;
    }
    if (inLane > 0) return later(() => route(open, msg));
    route(open, msg);
  };
  const route = (open: NonNullable<typeof chat>, msg: ChatClientMessage) => {
    // Going back past a raise lowers the sandbox: the extension restores the state of the branch it lands on.
    if (who !== null && (msg.type === "rewind" || msg.type === "regenerate")) {
      // The socket may close meanwhile (`wait=0`): it stays in the chat until the frame went over.
      checking++;
      Promise.all([open.sandboxInfo(), open.branch()]).then(
        ([info, branch]) => {
          const after = sandboxAfterRewind(branch, String(msg.entryId ?? ""));
          if (!after || !sandboxLowers(info?.state, after)) return open.clientMessage(client, msg);
          const type = msg.type === "rewind" ? ("rewind_refused" as const) : ("regenerate_refused" as const);
          client.send({ type, id: msg.id, entryId: msg.entryId, reason: "cancelled", message: yourClickBody("rewind", who).error });
        },
        (err) => client.send({ type: "error", code: "internal", message: err instanceof Error ? err.message : String(err) }),
      ).finally(() => {
        checking--;
        if (gone && held.size === 0 && checking === 0) leave();
      });
      return;
    }
    const asked = who !== null && (msg.type === "prompt" || msg.type === "steer") ? sandboxCommand(String(msg.text ?? "")) : null;
    if (!asked) return open.clientMessage(client, msg);
    open.sandboxInfo().then(
      (info) => {
        if (!sandboxLowers(info?.state, asked)) return open.clientMessage(client, msg);
        client.send({ type: "error", code: "refused", message: yourClickBody("sandbox", who!).error, ...("clientId" in msg && msg.clientId ? { clientId: msg.clientId } : {}) });
      },
      (err) => client.send({ type: "error", code: "internal", message: err instanceof Error ? err.message : String(err) }),
    );
  };
  // What this socket sent and the chat hasn't answered yet (§chat.transcript/send-while-starting).
  // Once the socket is gone, a refusal can't reach any tab: its text goes back as the draft.
  const held = new HeldSends();
  let gone = false;
  const heard = (back: Unsent[]) => {
    if (gone && back.length) putBackDraft(id, draftTexts(back));
    if (gone && held.size === 0 && checking === 0) leave();
  };
  const client: ChatClient = {
    send: (msg) => {
      if (held.listening) heard(held.heard(msg));
      sendJson(ws, msg);
    },
    sendRaw: (json) => {
      if (held.listening) heard(held.heardJson(json));
      sendRaw(ws, json);
    },
    close: (code, reason) => ws.close(code, reason),
    // A peer's socket stays as it was: a page on another computer comes that way (§app.access/your-click).
    ...(who !== null && who !== "local" ? { notUser: true as const } : {}),
    ...(wire === 2 ? { wire: 2 as const } : {}),
    ...(ask.tail ? { tail: true } : {}),
    ...(ask.tail && ask.pull ? { pull: { prefetch: ask.prefetch } } : {}),
    ...(have ? { have } : {}),
  };
  // Buffer messages that arrive while the runtime is still opening. They run, in order, once it
  // is open, even when the socket has closed by then (a tab that left or reloaded).
  const early: ChatClientMessage[] = [];
  let chat: Awaited<ReturnType<typeof acquireChatHandle>> | null = null;
  /** Out of the chat for good: at the socket's close, or once what it sent is answered. */
  let left = false;
  let listen: NodeJS.Timeout | undefined;
  const leave = () => {
    if (left) return;
    left = true;
    clearTimeout(listen);
    chat?.detach(client);
  };
  /** The socket closed with sends unanswered: stay to hear them, for a while. */
  const stayToHear = () => {
    if (checking > 0) return;
    if (held.size === 0) return leave();
    listen = setTimeout(leave, GONE_LISTEN_MS);
    listen.unref?.();
  };
  ws.on("message", (data) => {
    let msg: ChatClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      client.send({ type: "error", code: "internal", message: "Invalid JSON" });
      return;
    }
    if (opts.refused) {
      const clientId = (msg as { clientId?: unknown }).clientId;
      // A command from shell mode hears its own refusal, so its box stops waiting and keeps it (§chat.shell-mode/running).
      if (msg.type === "shell") client.send({ type: "shell_refused", clientId: String(clientId ?? ""), reason: "unavailable", message: opts.refused });
      else client.send({ type: "error", code: "refused", message: opts.refused, ...(typeof clientId === "string" && clientId ? { clientId } : {}) });
      return;
    }
    // An extension speaks only through session.send, which names it (§app.extensions/not-you). Before it is held: a
    // refusal the socket can't hear must not come back as the chat's draft.
    const keyRefused = who === "extension" ? extensionFrameRefusal(msg) : null;
    if (keyRefused) {
      const clientId = (msg as { clientId?: unknown }).clientId;
      client.send({ type: "error", code: "refused", message: keyRefused, ...(typeof clientId === "string" && clientId ? { clientId } : {}) });
      return;
    }
    sessionsChanged(); // a prompt, abort or rename: the next listing is built afresh
    held.sent(msg);
    if (chat) toChat(chat, msg);
    else if (!retractEarly(msg)) early.push(msg);
  });
  /** A removal of a send still waiting here for the chat to open (a Stop before the chat's hello):
      the send never reaches the chat, and the removal is answered as the chat's queue would. */
  const retractEarly = (msg: ChatClientMessage): boolean => {
    if (msg.type !== "queue_remove") return false;
    const i = early.findIndex((m) => (m.type === "prompt" || m.type === "steer") && m.clientId === msg.itemId);
    if (i === -1) return false;
    const [sent] = early.splice(i, 1);
    held.forget(msg.itemId);
    client.send({ type: "queue_removed", id: msg.id, itemId: msg.itemId, text: sent && (sent.type === "prompt" || sent.type === "steer") ? sent.text : "" });
    return true;
  };
  // Seen: a pane is on screen while its socket is open (server/seen.ts). Stamped at attach and at
  // detach, whether or not the runtime opens — a refused chat is still a session the user looked at.
  if (viewer) {
    trackViewer(id, 1);
    nudgeMarks(); // a mark clears once its session is on screen (server/session-feed.ts)
  }
  // A pane on screen hears its chat's cards change at once (§chat.transcript-cards/answering); a script's socket doesn't ask.
  const offCards = viewer ? onCardNews((e) => e.id === id && client.send({ type: "cards_changed" })) : null;
  // The same pane hears its chat's designs as they are written.
  const offDesigns = viewer ? onDesignNews((n) => n.sessionId === id && client.send({ type: "event", v: 2, event: n.event })) : null;
  ws.on("close", () => {
    gone = true;
    offCards?.();
    offDesigns?.();
    if (viewer) trackViewer(id, -1);
    if (chat) stayToHear();
  });

  try {
    chat = await acquireWithRetry(
      () => acquireChatHandle(path, force),
      // Nobody left to hear and nothing to deliver: no reason to start it again.
      () => gone && early.length === 0 && held.size === 0,
      (err) => console.warn(`[ws/chat] ${id}: the chat didn't start (${err instanceof Error ? err.message : String(err)}); trying once more`),
    );
  } catch (err) {
    // An archived chat (§chat.transcript/instant-open, "An archived chat"): read only, nothing started.
    // The tab keeps its rows from the file and is told `closed`, with the code no tab retries; what
    // it sent meanwhile goes back to its composer, or to the saved draft with no tab left.
    if (err instanceof ArchivedError) {
      const refusals = heldRefusals(early.splice(0));
      if (gone) putBackDraft(id, draftTexts(held.takeAll()));
      else for (const refusal of refusals) client.send(refusal);
      client.send({ type: "closed", reason: "archived" });
      ws.close(CHAT_CLOSED_CLOSE_CODE, "chat closed");
      return;
    }
    // Three outcomes, three close codes, because the client's retry policy keys off them:
    // 4409 busy (another process owns it), 4422 config (permanent — do NOT reconnect), 4500
    // internal (transient — backoff and retry).
    const busy = err instanceof BusyError;
    const config = err instanceof ConfigError;
    const code = busy ? err.code : config ? "config" : "internal";
    // What the pane sent meanwhile never reached a chat: each prompt goes back to its composer,
    // or, with no tab left to hear it, to the session's saved draft.
    const refusals = heldRefusals(early.splice(0));
    if (gone) putBackDraft(id, draftTexts(held.takeAll()));
    else for (const refusal of refusals) client.send(refusal);
    client.send({ type: "error", code, message: err instanceof Error ? err.message : String(err) });
    ws.close(busy ? 4409 : config ? 4422 : 4500, busy ? "busy" : config ? "config" : "open failed");
    return;
  }
  if (gone && early.length === 0) {
    chat.detach(client);
    return;
  }
  // Gone or not, the chat takes what the socket sent while it opened, in order, and this socket
  // stays in it until each send is answered (stayToHear).
  chat.attach(client);
  for (const msg of early.splice(0)) toChat(chat, msg);
  if (gone) stayToHear();
}

/** The pause before a chat socket's one retry of a failed start (tests set it to 0). */
export const openRetry = { ms: 1000 };

/**
 * Opens a chat, trying a failed start once more (§chat.transcript/instant-open): a start that fails
 * for now (a process that hung at boot, a crash) usually works a second later, and the socket keeps
 * holding what the pane sent meanwhile, so the messages then go through with nothing shown. This is
 * the one quiet retry: when it fails too, the pane is told at once and shows "This chat didn't
 * start." (src/lib/error-feed.ts), and its own reconnects add no second quiet round. A refusal no
 * retry can change (busy, config) is not retried; nor is one `giveUp` says nobody needs.
 */
export async function acquireWithRetry<T>(acquire: () => Promise<T>, giveUp: () => boolean, onRetry?: (err: unknown) => void): Promise<T> {
  try {
    return await acquire();
  } catch (err) {
    if (err instanceof BusyError || err instanceof ConfigError || err instanceof ArchivedError || giveUp()) throw err;
    onRetry?.(err);
    if (openRetry.ms > 0) await new Promise((r) => setTimeout(r, openRetry.ms));
    return acquire();
  }
}

/** At most this many frames in one POST /api/chat/frames. */
export const POSTED_FRAMES_MAX = 100;

/**
 * Frames a page handed over as it went (POST /api/chat/frames, §chat.transcript/send-while-starting):
 * a tab closed or reloaded before its chat socket opened. They take the very path a chat socket's
 * early frames take (handleChat), on a stand-in socket that is already gone: the chat opens, runs
 * them in order, takes each client id once, and a refusal goes back as the session's draft.
 */
export function deliverFrames(path: string, frames: readonly ChatClientMessage[], notPage: NotPage | null = "script"): void {
  const gone = Object.assign(new EventEmitter(), { readyState: 3, OPEN: 1, close() {}, send() {} });
  const ws = gone as unknown as WebSocket;
  handleChat(ws, path, false, { tail: true, pull: true, prefetch: false }, 2, undefined, { notPage }).catch((err) => console.error("[chat/frames]", err));
  // A command from shell mode is never run from here (§chat.shell-mode/who): only a live chat socket starts one.
  for (const f of frames) if (!isShellFrame(f)) gone.emit("message", JSON.stringify(f));
  gone.emit("close");
}

/** What recordFrame hands back: `close()` leaves the chat (idempotent); `emit()` hands the one
    frame over, once (a second call does nothing), and says whether it did. */
export interface RecordedChat {
  /** Hand the frame over, once: false (and `before` never called) when the socket is closed or it
      went already. `before` runs just before it goes, since a chat may answer from inside. */
  emit(before?: () => void): boolean;
  close(): void;
}

/**
 * One action from a script (POST /api/chat/action, server/chat-actions.ts): a chat socket's own path
 * (handleChat) on a recording socket that is open, so every frame the chat sends it reaches
 * `onFrame`, parsed. Nothing is sent until `emit()`; the caller emits once it has the hello.
 * Never a viewer (no seen stamp); never forced.
 */
export function recordFrame(path: string, frame: ChatClientMessage, onFrame: (msg: Record<string, unknown>) => void, onClose: () => void, notPage: NotPage | null = "script", opts: { stopsCommand?: boolean } = {}): RecordedChat {
  let open = true;
  let sent = false;
  const rec = Object.assign(new EventEmitter(), {
    readyState: 1,
    OPEN: 1,
    send(json: string) {
      if (!open) return;
      let msg: unknown;
      try {
        msg = JSON.parse(json);
      } catch {
        return;
      }
      if (msg && typeof msg === "object") onFrame(msg as Record<string, unknown>);
    },
    close() {
      // The chat closed its client (4409 busy, 4422, 4500, closed): it is gone from this socket.
      if (!open) return;
      open = false;
      rec.readyState = 3;
      rec.emit("close");
      onClose();
    },
  });
  const ws = rec as unknown as WebSocket;
  handleChat(ws, path, false, { tail: true, pull: true, prefetch: false }, 2, undefined, { viewer: false, notPage, ...(opts.stopsCommand && frame.type === "shell_stop" ? { stopsCommand: true } : {}) }).catch((err) => {
    console.error("[chat/action]", err);
    rec.close();
  });
  return {
    emit: (before?: () => void) => {
      if (sent || !open) return false;
      sent = true;
      before?.();
      rec.emit("message", JSON.stringify(frame));
      return true;
    },
    close: () => {
      if (!open) return;
      open = false;
      rec.readyState = 3;
      rec.emit("close");
    },
  };
}

/** A shell-mode frame (`shell`, `shell_stop`): the frames path drops it. */
const isShellFrame = (f: { type?: unknown }) => f.type === "shell" || f.type === "shell_stop";

/** The frames of a POST /api/chat/frames body (`{ frames: [...] }`), or null when malformed. Shell-mode
    frames are dropped (§chat.shell-mode/who, §chat.transcript/send-while-starting): a command runs only
    from a live chat socket. */
export function postedFrames(body: unknown): ChatClientMessage[] | null {
  const frames = (body as { frames?: unknown } | null)?.frames;
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > POSTED_FRAMES_MAX) return null;
  for (const f of frames) if (!f || typeof f !== "object" || Array.isArray(f) || typeof (f as { type?: unknown }).type !== "string") return null;
  return (frames as ChatClientMessage[]).filter((f) => !isShellFrame(f));
}

/** The texts in posted frames that go back as a draft when the frames are refused unrun. */
export function framesDraft(frames: readonly ChatClientMessage[]): string[] {
  const held = new HeldSends();
  for (const frame of frames) held.sent(frame);
  return draftTexts(held.takeAll());
}

/** The refusals for messages a pane sent while its chat was opening, when it didn't open. */
export function heldRefusals(held: readonly ChatClientMessage[]): ChatServerMessage[] {
  return held.map(unsentRefusal).filter((r): r is NonNullable<typeof r> => r !== null);
}

function handleWatch(ws: WebSocket, path: string, ask: TailAsk, wire: WireVersion, normalize?: Normalize, format: Format = "pi"): void {
  // pi replies name their model, so the fill carries its window; the runtime is resolved first.
  let resolve: WindowResolver = () => null;
  const tail = new SessionTail(
    path,
    (msg) => sendJson(ws, msg),
    normalize,
    contextTally(format, (ref) => resolve(ref)),
    ask.tail && !ask.pull ? (json) => sendRaw(ws, json) : undefined,
    ask.tail && ask.pull ? { prefetch: ask.prefetch } : undefined,
    wire,
    // Wire 2 on a pi session file: replies carry their measured timing, as on REST and /ws/chat.
    wire === 2 && format === "pi" && !normalize ? () => replyTimingsOf(sessionIdOfPath(path)) : undefined,
  );
  // A claude-code worker's own file has no Sova session id: nothing to stamp.
  const id = normalize ? "" : idOf(path);
  if (id) {
    trackViewer(id, 1);
    nudgeMarks();
  }
  ws.on("close", () => {
    if (id) trackViewer(id, -1);
    tail.close();
  });
  ws.on("message", () => {}); // read-only: ignore anything the client sends
  const windows = format === "pi" ? sharedWorkerWindowResolver().then((r) => void (resolve = r)) : Promise.resolve();
  windows.then(() => tail.start()).catch((err) => {
    sendJson(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
    ws.close(4500, "watch failed");
  });
}

/** /ws/watch?feed=sessions: the session list's decision overlays, pushed (server/session-feed.ts).
    `rows`: the socket asked for the changed rows themselves (`&rows=1`) instead of `list_changed`. */
function handleFeed(ws: WebSocket, rows: boolean): void {
  const feed = sessionFeed();
  if (!feed) {
    sendJson(ws, { type: "error", message: "The session feed is not running" });
    ws.close(4500, "no feed");
    return;
  }
  const remove = feed.add((msg) => {
    if (ws.readyState !== ws.OPEN) return;
    let json: string;
    try {
      json = feedFrameJson(msg);
    } catch (err) {
      console.error("[ws] send failed", err);
      return;
    }
    sendRaw(ws, json);
  }, { rows });
  // The LLM calls in flight ride the same socket.
  const removeLlm = llmInflight()?.addBrowser((msg) => sendJson(ws, msg));
  ws.on("close", () => {
    remove();
    removeLlm?.();
  });
  ws.on("message", () => {}); // read-only: ignore anything the client sends
}

/** /ws/watch?feed=llm: this host's OWN LLM calls in flight, for a peer's fan-in (server/llm-inflight.ts). */
function handleLlmFeed(ws: WebSocket): void {
  const hub = llmInflight();
  if (!hub) {
    sendJson(ws, { type: "error", message: "The LLM count is not running" });
    ws.close(4500, "no feed");
    return;
  }
  ws.on("close", hub.addLocal((msg) => sendJson(ws, msg)));
  ws.on("message", () => {}); // read-only
}

// permessage-deflate, for a browser that offers it: a session's hello is one JSON frame of the
// whole transcript (MBs for a large one), sent to phones over the tailnet. Frames under 1 KB (the
// streaming deltas) go uncompressed. No context takeover either way, so a connection holds no
// window between messages; ws creates its zlib streams lazily, so a socket that only ever sends
// small frames holds none at all. Level 1: the ratio on a hello is within a few percent of level 6
// at a fraction of the CPU (numbers in the commit message).
const DEFLATE = {
  threshold: 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  zlibDeflateOptions: { level: 1 },
};
const wss = cappedWebSocketServer({ noServer: true, perMessageDeflate: DEFLATE });
stallGauge("ws clients", () => wss.clients.size);
stallGauge("ws buffered KB", () => {
  let bytes = 0;
  for (const ws of wss.clients) bytes += ws.bufferedAmount;
  return bytes / 1024;
});
// A dial-out pairing's sockets arrive on HTTP/2 streams, which only the pure-JS server can upgrade
// (runtime-quirks.ts, "WebSockets over a stream").
const streamWss = streamWebSocketServer({ perMessageDeflate: DEFLATE });

/** Sova's own sockets, /ws/chat and /ws/watch; anything else is dropped. Also the peer
    listener's upgrade handler (server/mesh/listener.ts). */
export function upgradeSovaSocket(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  upgradeWith(wss, req, socket, head);
}

/** The same, for a request that arrived on a stream rather than a socket (server/mesh/lan.ts). */
export function upgradeSovaStreamSocket(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  upgradeWith(streamWss, req, socket, head);
}

/** What the main listener's upgrade judged of a socket (attachWebSockets). The peer listener's have no entry: not the page. */
const pageSockets = new WeakMap<IncomingMessage, NotPage | null>();

function upgradeWith(server: typeof wss, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = url.pathname;
  if (route !== "/ws/chat" && route !== "/ws/watch") {
    socket.destroy();
    return;
  }
  // A browser on this machine, not through a proxy: decline permessage-deflate (server/compression.ts).
  const direct = isDirectLocal(req);
  if (direct) delete req.headers["sec-websocket-extensions"];
  server.handleUpgrade(req, socket, head, (ws) => {
    // /ws/watch?feed=sessions: no session at all, the list's pushed overlays.
    if (route === "/ws/watch" && url.searchParams.get("feed") === "sessions") {
      handleFeed(ws, url.searchParams.get("rows") === "1");
      return;
    }
    if (route === "/ws/watch" && url.searchParams.get("feed") === "llm") {
      handleLlmFeed(ws);
      return;
    }
    // ?tail=1: the transcript newest rows first (server/tail-hello.ts); ?tail=rest: newest rows
    // alone (server/transcript-rows.ts); anything else, as it always was.
    const t = url.searchParams.get("tail");
    const tail: TailAsk = t === "1" ? { tail: true, pull: false } : t === "rest" ? { tail: true, pull: true, prefetch: direct } : { tail: false };
    // ?wire=2: events and rows in the harness contract's words (server/wire-rows.ts); else wire 1.
    const wire = wireOf(url.searchParams);
    // /ws/watch?claude=<uuid>: a claude-code worker's own session file, in CC's own format.
    const claudeId = route === "/ws/watch" ? url.searchParams.get("claude") : null;
    if (claudeId) {
      const file = resolveClaudeSession(claudeId);
      if (!file || !existsSync(file)) {
        sendJson(ws, { type: "error", message: file ? "Session file not found" : "Unknown Claude Code session" });
        ws.close(4404, "bad path");
        return;
      }
      // REST serves pi session files only: a Claude Code file's older rows are pushed, as with ?tail=1.
      handleWatch(ws, file, tail.tail ? { tail: true, pull: false } : tail, wire, normalizeClaudeText, "claude");
      return;
    }
    const path = resolveSessionPath(url.searchParams.get("path"));
    if (!path || !existsSync(path)) {
      const message = path ? "Session file not found" : "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)";
      sendJson(ws, route === "/ws/chat" ? { type: "error", code: "internal", message } : { type: "error", message });
      ws.close(4404, "bad path");
      return;
    }
    if (route === "/ws/chat") {
      const refused = writingRefused(url.searchParams.get(COMPOSER_PARAM)) ?? undefined;
      handleChat(ws, path, url.searchParams.get("force") === "1", tail, wire, haveOf(url.searchParams, tail), { notPage: pageSockets.get(req), ...(refused ? { refused } : {}) }).catch((err) => {
        console.error("[ws/chat]", err);
        ws.close(4500, "internal");
      });
    } else {
      handleWatch(ws, path, tail, wire);
    }
  });
}

export function attachWebSockets(server: Server): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // The main listener's gate (server/auth.ts upgradeAllowed): the token, and the Host and Origin
    // rules, before any socket is dispatched. Not in upgradeSovaSocket: the peer listener calls
    // that directly, and a peer is answered by its Tailscale identity.
    if (refuseUpgrade(req, socket)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    // Sova's event stream (server/events-ws.ts): this listener only, never the peer's.
    if (url.pathname === EVENTS_PATH) return upgradeEventsSocket(req, socket, head);
    // An extension's own socket, forwarded to its backend (server/extensions.ts).
    const ext = extensionSocketRoute(url.pathname);
    if (ext) {
      upgradeExtensionSocket(req, socket, head, ext[0], ext[1], url.search);
      return;
    }
    // A session on another host, forwarded to it (server/mesh/proxy.ts); never while the mesh is off.
    if (meshUpgrade(req, socket, head, url)) return;
    pageSockets.set(req, notPageSocket((n) => {
      const v = req.headers[n];
      return Array.isArray(v) ? v.join(n === "cookie" ? "; " : ", ") : v;
    }));
    upgradeSovaSocket(req, socket, head);
  });
}
