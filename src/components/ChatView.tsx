import { batch, createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Portal } from "solid-js/web";
import type { ChatServerMessage, SessionSummary, SlashCommand, TeamInfo, TranscriptItem, WorkerInfo } from "../../shared/protocol";
import { fetchTranscriptWithContext, mountTarget, setSessionArchived, wsUrl } from "../lib/api";
import { contextStateFor, usageTokens, windowOf } from "../lib/context";
import { addPendingPrompt, applyEvent, emptyLive, runDetail, takeBackQueued, type LiveState } from "../lib/live";
import { isObj, str } from "../lib/message";
import { openFailureView } from "../lib/open-failure";
import {
  closeRemoteStatus,
  isRemoteNotice,
  openRemoteStatus,
  REMOTE_CHECK_TEXT,
  REMOTE_COMMAND,
  REMOTE_RECONNECT_TEXT,
  REMOTE_STATUS_KEY,
  REMOTE_STATUS_TEXT,
  type RemoteControls,
  remoteStatusAsker,
  reportRemoteStatus,
  setRemoteControls,
} from "../lib/remote-status";
import { remotePlaceOf } from "../lib/remote-session";
import { createReconnectingSocket } from "../lib/socket";
import { usageTotal, type UsageTotalView, workingSplit } from "../lib/workers";
// The shared targets store the mounted chip reads (RemoteStatus owns it, the pane toggle patches it).
import { patchTarget } from "./RemoteStatus";
import type { UploadResult } from "../../shared/protocol";
import { drafts, hideThinking, hideTools, sessionContext, setDraftText, setLocalRunning, setSessionContext, toast } from "../lib/ui-state";
import { usePaneAnnounce, usePaneId, usePaneScope } from "../lib/pane-scope";
import { visibleCount } from "../lib/hidden-rows";
import { inputCount } from "../lib/input-count";
import type { RewindControl, RewindResult } from "../lib/inputs";
import { isTurnStart } from "../lib/turn";
import { Composer, type ComposerReason } from "./Composer";
import { FlyoutSession, type ThinkingControl, type UndoControl } from "./ComposerMenu";
import { ConnectionBanner } from "./ConnectionBanner";
import { SessionInfoDialog } from "./SessionInfoDialog";
import type { ModeControl, ModeState } from "./ModeMenu";
import type { ModelControl } from "./ModelMenu";
import { HistoryItems, InfoRow, LiveEntries, ThreadScroller, TranscriptSkeleton, TurnError } from "./Thread";
import { Banner, Icon } from "./ui";
import { UiDialog } from "./UiDialog";

export type ChatRefusal = "busy" | "recent";

/** ui_request kinds UiDialog can show (spec/06-extension-dialogs.md §6); anything else needs the terminal UI. */
const UI_DIALOG_METHODS = ["select", "confirm", "input", "editor"];

/**
 * Full-duplex chat with a webapp-owned session. When the server refuses to let us write
 * (`busy`: a TUI owns it; `recent`: an unknown process wrote it moments ago), `onRefused` hands
 * control back so the parent can switch to the read-only watch view.
 */
export function ChatView(props: {
  path: string;
  /** The session-list row for this chat, live from the sidebar's poll: feeds the info modal. */
  summary?: () => SessionSummary | undefined;
  cwdLabel: string;
  author: string;
  /** Reconnect past the server's recent-write guard (never past a live TUI). */
  force: boolean;
  autofocus?: boolean;
  onModel(model: string | null): void;
  onRefused(kind: ChatRefusal, message: string): void;
  /** A run just started here: the list's `busy` is stale until it's refetched. */
  onStarted(): void;
  onSettled(): void;
  /** This runtime's subagents (WS "workers"; [] after each hello), for the subagents pane. The
      Σ is the runtime's session-lifetime worker token total, null while no server reports one. */
  onWorkers?(workers: WorkerInfo[], usage: UsageTotalView | null): void;
  /** Toggles the subagents pane from the composer's subagents row. */
  onShowWorkers?(): void;
  /** The pane is open for this session ON THE AGENTS TAB (the subagents trigger's aria-expanded). */
  workersOpen?: boolean;
  /** The pane is open for this session on the Timeline with Inputs Only on (the inputs trigger's
      aria-expanded). */
  inputsOpen?: boolean;
  /** The pane's active tab while it is open for this session ("timeline", "agents", …), else null:
      each status-row trigger is aria-expanded only for its own tab. */
  paneTab?: string | null;
  /** The session pane re-reads this after its Archive/Unarchive action succeeds; the info modal
      needs the same, or the sidebar row stays stale until its next poll. */
  onArchiveChanged?(): void;
  /** The same, after a group change in the info modal (Move into group): the sidebar's Groups
      region and the row's own groupId come from the session list. */
  onGroupsChanged?(): void;
  /** A bare "/new" in the composer (§4d); resolves to the new session's folder label, or null. */
  onNewSession?(): Promise<string | null>;
  /** Opens the session pane's Timeline tab (§4d): a bare "/timeline" unfiltered; a bare "/tree" and
      the status row's inputs trigger with `inputsOnly`, on your own messages. */
  onShowTimeline?(inputsOnly?: boolean): void;
  /** Hands the Timeline this chat's rewind (sent over this socket); null when this view goes away. */
  onRewindControl?(control: RewindControl | null): void;
  /** A rewind landed on this chat, whoever asked (a Timeline row, or the flyout's "Undo last
      turn"): the Timeline must re-read the branch, or it keeps offering the abandoned rows.
      Success only — a refusal changed nothing. App mints the generation counter the pane watches.
      No text: this view prefills the composer itself, and the pane rebuilds its shadow from the id. */
  onRewound?(info: { path: string; entryId: string }): void;
  /** This session's teams (polled insight), so the status row can name team members as such. */
  teams?: TeamInfo[];
}) {
  // One status region for the whole page: inside a workspace every sentence from this chat says
  // which pane it came from, and every DOM id below carries the pane's id.
  const announce = usePaneAnnounce();
  const scope = usePaneScope();
  const paneId = usePaneId();

  const [items, setItems] = createSignal<TranscriptItem[] | null>(null);
  const [live, setLive] = createStore<LiveState>(emptyLive());
  const [syncing, setSyncing] = createSignal(false);
  const [errors, setErrors] = createSignal<string[]>([]);
  /** A permanent open failure (code "config"): shown once, never retried, never appended to. */
  const [configError, setConfigError] = createSignal<string | null>(null);
  /** The open-failure banner's action state (spec/01-app-shell.md "The open-failure banner"): a
      Mount in flight, its failure (the mount module's real reason, kept beside the actions,
      never a toast that vanishes), and an Archive in flight. */
  const [mounting, setMounting] = createSignal(false);
  const [mountFailure, setMountFailure] = createSignal<string | null>(null);
  const [archiving, setArchiving] = createSignal(false);
  const [dialogs, setDialogs] = createSignal<{ id: string; request: unknown }[]>([]);
  const [resume, setResume] = createSignal(0);
  /** Queued steers/follow-ups a Stop drained, handed back to the composer. */
  const [restored, setRestored] = createSignal<{ text: string } | null>(null);
  const [everOpened, setEverOpened] = createSignal(false);
  const [model, setModel] = createSignal<string | null>(null);
  const [pendingModel, setPendingModel] = createSignal<string | null>(null);
  const [modelError, setModelError] = createSignal<{ target: string; from: string | null; body: string | { noCredentials: string } } | null>(null);
  /** "Model changed to …" rows shown until a transcript reload brings the persisted entry. */
  const [modelRows, setModelRows] = createSignal<string[]>([]);
  /** The session's thinking level (WS "thinking"; seeded by hello). The server is the authority:
      it clamps to the model's ladder, and re-sends after every model switch. */
  const [thinking, setThinking] = createSignal<string | null>(null);
  /** Level asked for, until the echo. A refusal ends it and leaves the level as it was. */
  const [pendingThinking, setPendingThinking] = createSignal<string | null>(null);
  const [thinkingError, setThinkingError] = createSignal<{ target: string; from: string | null; body: string } | null>(null);
  /** The per-session info modal (§4h), opened from the composer flyout. */
  const [showInfo, setShowInfo] = createSignal(false);
  /** This session's slash commands (sent after hello, and again after a runtime reload). */
  const [commands, setCommands] = createSignal<SlashCommand[]>([]);
  /** The global mode and how it applies to this chat (WS "mode"). */
  const [modeState, setModeState] = createSignal<ModeState | null>(null);
  /** Local "Ran /name args" rows; `tui` marks one that asked for a UI pi-web can't show. */
  const [commandRows, setCommandRows] = createSignal<{ label: string; tui: boolean }[]>([]);
  /** Subagents working now (WS "workers"); 0 until the first one arrives. */
  const [workersWorking, setWorkersWorking] = createSignal(0);
  /** The same message's list, so the status row can split the count against this session's teams. */
  const [workerList, setWorkerList] = createSignal<WorkerInfo[]>([]);
  const workersSplit = () => workingSplit(workersWorking(), workerList(), props.teams);
  /** A compaction is in flight: a manual /compact runs with no turn, so `live.running` misses it. */
  const [compacting, setCompacting] = createSignal(false);
  let modelTimer: ReturnType<typeof setTimeout> | undefined;
  let thinkingTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(modelTimer);
    clearTimeout(thinkingTimer);
  });

  // A remote session's connection chips (src/lib/remote-status.ts): "checking…" until the
  // extension's first report, and gone when this chat closes, since nothing reports after that.
  const remote = remotePlaceOf(props.summary?.() ?? { cwd: "" });
  if (remote) {
    openRemoteStatus(props.path, remote.target);
    onCleanup(() => closeRemoteStatus(props.path));
  }
  /** Extension notices become toasts; the remote extension's (a lost host) is a connection event,
      said once per text a minute rather than stacked on every retry. */
  let lastNotice = { text: "", at: 0 };
  /** Armed by each hello; the commands message that follows it asks for the current status. */
  const statusAsker = remoteStatusAsker(!!remote);
  const notice = (message: string) => {
    if (!isRemoteNotice(message)) return toast(message);
    const text = message.split("\n", 1)[0]!.trim();
    if (text === lastNotice.text && Date.now() - lastNotice.at < 60_000) return;
    lastNotice = { text, at: Date.now() };
    toast(text);
  };

  const resync = async () => {
    setSyncing(true);
    try {
      const next = await fetchTranscriptWithContext(props.path);
      setSessionContext(props.path, contextStateFor(next.context, next.items)); // authoritative after each turn
      batch(() => {
        setItems(next.items);
        setLive(reconcile(emptyLive()));
        setModelRows([]);
        setCommandRows([]); // local only; the persisted entries now tell the story
      });
    } catch (err) {
      // Keep the streamed turn on screen; it's accurate, just not re-normalized.
      setErrors((e) => [...e, `Couldn't reload the transcript after this run: ${(err as Error).message}`]);
    } finally {
      setSyncing(false);
    }
  };

  // Deltas arrive far faster than frames; apply them in one batch per animation frame.
  let queue: unknown[] = [];
  let frame = 0;
  const flush = () => {
    frame = 0;
    const events = queue;
    queue = [];
    let settled = false;
    batch(() => {
      for (const ev of events) {
        if (isObj(ev) && ev.type === "agent_start") announce("Working.");
        // Context fill at turn end: the finished assistant message carries the final usage
        // (no extra server push). A compaction makes it stale until the next reply.
        if (isObj(ev) && ev.type === "message_end" && isObj(ev.message) && ev.message.role === "assistant") {
          const tokens = usageTokens(ev.message.usage);
          if (tokens !== null) setSessionContext(props.path, { tokens, window: windowOf(sessionContext()[props.path]) });
        }
        if (isObj(ev) && ev.type === "compaction_start") setCompacting(true);
        if (isObj(ev) && ev.type === "compaction_end") {
          setCompacting(false);
          setSessionContext(props.path, "compacted");
        }
        applyEvent(setLive, ev);
        if (isObj(ev) && ev.type === "agent_settled") settled = true;
      }
    });
    if (settled) {
      announce("Reply finished.");
      void resync();
      props.onSettled();
    }
  };
  onCleanup(() => cancelAnimationFrame(frame));

  /**
   * Puts prompts the server never accepted back into the draft, so nothing typed is lost.
   * Attached images come back as their paths, already part of the text.
   */
  const restoreUnsent = () => {
    const unsent = live.entries.flatMap((e) => (e.kind === "user" && !e.confirmed ? [e] : []));
    if (unsent.length === 0) return;
    const texts = unsent.map((e) => e.text).filter(Boolean);
    const current = drafts.get(props.path);
    if (texts.length) setDraftText(props.path, [...texts, ...(current ? [current] : [])].join("\n\n"));
  };

  const socket = createReconnectingSocket<ChatServerMessage>(wsUrl("/ws/chat", props.path, props.force), {
    onOpen(isReconnect) {
      setEverOpened(true);
      // hello follows and replaces everything; dialogs belonged to the old connection.
      if (isReconnect) setDialogs([]);
    },
    onMessage(msg) {
      switch (msg.type) {
        case "hello":
          cancelAnimationFrame(frame);
          frame = 0;
          queue = [];
          statusAsker.hello();
          batch(() => {
            setItems(msg.items);
            setLive(reconcile({ ...emptyLive(), running: msg.isStreaming }));
            setCompacting(false);
          });
          setModel(msg.model);
          batch(() => {
            setThinking(msg.thinking);
            setPendingThinking(null);
            setThinkingError(null);
          });
          setSessionContext(props.path, contextStateFor(msg.context ?? null, msg.items));
          setModelRows([]);
          setWorkersWorking(0); // a runtime without workers sends no "workers" after hello
          setWorkerList([]);
          props.onWorkers?.([], null);
          props.onModel(msg.model);
          break;
        case "workers":
          setWorkersWorking(msg.working);
          setWorkerList(msg.workers);
          props.onWorkers?.(msg.workers, usageTotal(msg));
          break;
        // Stop drained what was still queued; it goes back to the draft, not behind the next prompt.
        case "queue_cleared": {
          const text = takeBackQueued(setLive, [...msg.steering, ...msg.followUp]);
          if (text) {
            setRestored({ text });
            announce("Queued message returned to the composer.");
          }
          break;
        }
        // A rewind landed. The server has already broadcast the new branch's hello (and mode), so
        // the thread is reset; what's left is the rewound message, which goes ahead of the draft.
        case "rewound": {
          batch(() => {
            setErrors([]); // they belonged to the turns just abandoned
            setCommandRows([]);
            if (msg.editorText) setRestored({ text: msg.editorText });
          });
          announce(msg.editorText ? "Rewound. Your message is back in the composer." : "Rewound.");
          props.onRewound?.({ path: props.path, entryId: msg.entryId });
          settleRewind(msg.id, { ok: true, text: msg.editorText });
          break;
        }
        // settleRewind announces it: the pane shows the same message inline on its row.
        case "rewind_refused":
          settleRewind(msg.id, { ok: false, reason: msg.reason, message: msg.message });
          break;
        case "commands":
          setCommands(msg.commands);
          // A runtime that outlived its last socket won't report again until something happens,
          // and setStatus isn't replayed: ask it to re-publish (no ssh, no toast), once per hello.
          if (statusAsker.commands(msg.commands)) socket.send({ type: "prompt", text: REMOTE_STATUS_TEXT });
          break;
        case "model":
          modelSwitched(msg.model);
          break;
        // The effective level, after clamping: set_thinking echoes it, and so does a model switch.
        case "thinking":
          clearTimeout(thinkingTimer);
          batch(() => {
            setThinking(msg.level);
            setPendingThinking(null);
            setThinkingError(null);
          });
          break;
        // Rows written outside a turn (mode markers, …). Before hello there is nothing to append
        // to: hello's own items carry them.
        case "append":
          setItems((list) => (list ? [...list, ...msg.items] : list));
          break;
        case "mode":
          setModeState({ mode: msg.mode, minorModes: msg.minorModes, strict: msg.strict, applies: msg.applies });
          break;
        case "event":
          queue.push(msg.event);
          if (!frame) frame = requestAnimationFrame(flush);
          break;
        case "ui_request": {
          const req = isObj(msg.request) ? msg.request : {};
          if (!req.fireAndForget && !UI_DIALOG_METHODS.includes(str(req.method) ?? "")) {
            // A TUI-only interface: answer so the command isn't left waiting, and say so.
            socket.send({ type: "ui_response", id: msg.id, value: null });
            setCommandRows((rows) => (rows.length ? [...rows.slice(0, -1), { ...rows[rows.length - 1]!, tui: true }] : rows));
          } else if (!req.fireAndForget) setDialogs((d) => [...d, { id: msg.id, request: msg.request }]);
          else if (req.method === "notify" && str(req.message)) notice(str(req.message)!);
          // The remote extension's JSON status feeds the connection chips; any other setStatus
          // (its own "remote" key included) is TUI chrome, often ANSI-coded: nothing to show.
          else if (req.method === "setStatus" && req.statusKey === REMOTE_STATUS_KEY) reportRemoteStatus(props.path, req.statusText);
          break;
        }
        case "error":
          if (pendingModel()) modelFailed(msg.message, msg.code);
          if (pendingThinking()) thinkingFailed(msg.message);
          switch (msg.code) {
            case "busy":
            case "recent":
              restoreUnsent();
              socket.close();
              props.onRefused(msg.code, msg.message);
              return;
            case "reloaded":
              socket.reconnect();
              return;
            // Permanent (the session's cwd is gone): one banner, no retry loop. The socket layer
            // already refuses to reconnect on close 4422; closing here covers a server that sends
            // the message without the close code.
            case "config":
              restoreUnsent();
              socket.close();
              setConfigError(msg.message);
              setLive("running", false);
              return;
            default:
              if (modelError() || thinkingError()) break; // shown as the switch's banner
              // The same failure re-reported (a reconnect loop) says nothing new: keep one row.
              setErrors((e) => (e[e.length - 1] === msg.message ? e : [...e, msg.message]));
              // A prompt that failed before the agent started leaves nothing running.
              if (!live.entries.some((e) => e.kind === "assistant")) setLive("running", false);
          }
          break;
      }
    },
  });

  // ---- Rewind (the Timeline's input rows and the flyout's "Undo last turn") -----------------
  /** Requests in flight, by id: the server answers only the socket that asked. Every refusal is
      announced from here, whoever asked (the pane shows its rows an inline note instead), so the
      live region says each one exactly once and never leaves the last "Rewound." standing. */
  const rewinds = new Map<string, (result: RewindResult) => void>();
  let rewindSeq = 0;
  /** How many are waiting, reactively: the flyout's Undo row greys out while one is in flight. */
  const [rewindsPending, setRewindsPending] = createSignal(0);
  const settleRewind = (id: string, result: RewindResult) => {
    const waiting = rewinds.get(id);
    if (waiting && !result.ok) announce(result.message);
    waiting?.(result);
    rewinds.delete(id);
    setRewindsPending(rewinds.size);
  };
  /** A dropped connection takes its answers with it; the reconnect's hello shows what happened. */
  const dropRewinds = () => {
    for (const id of [...rewinds.keys()])
      settleRewind(id, { ok: false, reason: "disconnected", message: "The connection dropped. Check the thread, then try again." });
  };
  createEffect(on(socket.status, (status) => status !== "open" && dropRewinds(), { defer: true }));
  onCleanup(dropRewinds);
  const rewindBlocked = (): "streaming" | "compacting" | null => (compacting() ? "compacting" : live.running ? "streaming" : null);
  const rewind = (entryId: string): Promise<RewindResult> => {
    // The server refuses these too; answering here saves the round trip. Never auto-abort.
    const block = rewindBlocked();
    const refuse = (reason: "streaming" | "compacting" | "disconnected", message: string): RewindResult => {
      announce(message);
      return { ok: false, reason, message };
    };
    if (block === "streaming") return Promise.resolve(refuse(block, "Stop the turn first, then rewind."));
    if (block === "compacting") return Promise.resolve(refuse(block, "Wait for compaction to finish, then rewind."));
    const id = `rewind-${++rewindSeq}`;
    return new Promise((resolve) => {
      if (!socket.send({ type: "rewind", id, entryId }))
        return resolve(refuse("disconnected", "Not connected. Try again once it reconnects."));
      rewinds.set(id, resolve);
      setRewindsPending(rewinds.size);
    });
  };
  props.onRewindControl?.({ path: props.path, blocked: rewindBlocked, rewind });
  onCleanup(() => props.onRewindControl?.(null));
  /** The flyout's "Undo last turn": a rewind to just before the newest user message on the branch. */
  const lastInput = () => {
    const list = items() ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (isTurnStart(list[i]!)) return list[i]!.id;
    return null;
  };
  const undoControl: UndoControl = {
    blocked: () => {
      const reason = blocked();
      if (reason) return reason.text;
      const block = rewindBlocked();
      if (block === "streaming") return "Stop the turn first, then undo.";
      if (block === "compacting") return "Wait for compaction to finish, then undo.";
      if (rewindsPending() > 0) return "A rewind is already in progress.";
      return lastInput() ? null : "Nothing to undo yet.";
    },
    run: () => {
      const id = lastInput();
      // One rewind at a time: a second confirm before the reply would abandon two turns.
      if (id && rewindsPending() === 0) void rewind(id).then((r) => !r.ok && toast(r.message));
    },
  };

  const answer = (id: string, value: unknown) => {
    socket.send({ type: "ui_response", id, value });
    setDialogs((d) => d.filter((x) => x.id !== id));
  };

  /**
   * Archiving IS the close gesture: the server disposes the held runtime, so this socket closes
   * from the server side moments after Eliminate. Inside a workspace that close is EXPECTED, and
   * the pane says the one true thing about it — the session is archived — instead of the
   * disconnected banner and "Not connected." the single-session view would show for the same
   * event (spec/14-workspaces.md "Member states"). An eliminated member stays readable, which is
   * what makes elimination reversible.
   */
  const archivedPane = () => !!scope.id && !!props.summary?.()?.archived;

  const blocked = (): ComposerReason | null => {
    if (archivedPane()) return { icon: "archive", text: "This session is archived. Unarchive it to send." };
    switch (socket.status()) {
      case "connecting":
        return everOpened() ? { icon: "clock", text: "Reconnecting. Your draft is kept." } : { icon: "clock", text: "Connecting…" };
      case "reconnecting":
        return { icon: "clock", text: "Reconnecting. Your draft is kept." };
      case "failed":
      case "closed":
        return { icon: "clock", text: "Not connected." };
    }
    if (!items()) return { icon: "clock", text: "Connecting…" };
    if (syncing()) return { icon: "clock", text: "Saving this turn…" };
    if (pendingModel()) return { icon: "clock", text: "Switching model…" };
    return null;
  };

  // ---- Model switching (spec/04c-model-menu.md §4c) ------------------------------------------------
  const idOf = (ref: string) => ref.slice(ref.indexOf("/") + 1);
  /** Server messages are free text; map the known ones to the spec's copy. */
  const switchErrorBody = (message: string, code?: string) => {
    // Refusal codes reuse the composer's reason copy for the same state.
    if (code === "busy") return "Read only while this session is open in the TUI.";
    if (code === "recent") return "Read only while another process may be writing this file.";
    if (code === "reloaded") return "Reconnecting. Your draft is kept.";
    // Data, not JSX: this runs in a socket handler, outside any reactive owner.
    const credentials = /^No credentials configured for (\S+)/.exec(message);
    if (credentials) return { noCredentials: credentials[1]! };
    if (message.startsWith("Unknown model")) return "pi doesn't know this model. It may have been removed from your config.";
    if (message.startsWith("Cannot switch models while the agent is running")) return "Model changes wait until this turn finishes.";
    return `${message.replace(/\.$/, "")}.`;
  };
  const modelSwitched = (next: string) => {
    const was = pendingModel();
    clearTimeout(modelTimer);
    batch(() => {
      setPendingModel(null);
      setModelError(null);
      if (next !== model()) setModelRows((r) => [...r, next]);
      setModel(next);
    });
    props.onModel(next);
    if (was || next) announce(`Model changed to ${idOf(next)}.`);
  };
  const modelFailed = (message: string, code?: string) => {
    const target = pendingModel();
    if (!target) return;
    clearTimeout(modelTimer);
    batch(() => {
      setPendingModel(null);
      setModelError({ target, from: model(), body: switchErrorBody(message, code) });
    });
  };
  const chooseModel = (ref: string) => {
    if (pendingModel() || ref === model() || live.running || blocked()) return;
    if (!socket.send({ type: "set_model", ref })) return;
    setModelError(null);
    setPendingModel(ref);
    clearTimeout(modelTimer);
    modelTimer = setTimeout(() => modelFailed("The server didn't confirm the switch."), 15_000);
  };
  // ---- Thinking level (spec/04b-images.md §4b "Thinking") --------------------------------------
  /** The server sends free text here too; map the two refusals it can answer with. */
  const thinkingErrorBody = (message: string) => {
    if (message.startsWith("Cannot change thinking while the agent is running"))
      return "Thinking changes wait until this turn finishes.";
    if (message.startsWith("Unknown thinking level")) return "pi doesn't know this thinking level.";
    return `${message.replace(/\.$/, "")}.`;
  };
  const thinkingFailed = (message: string) => {
    const target = pendingThinking();
    if (!target) return;
    clearTimeout(thinkingTimer);
    batch(() => {
      setPendingThinking(null);
      setThinkingError({ target, from: thinking(), body: thinkingErrorBody(message) });
    });
  };
  const thinkingBlocked = (): string | null => {
    if (live.running) return "Thinking changes wait until this turn finishes.";
    return blocked()?.text ?? null;
  };
  const thinkingControl: ThinkingControl = {
    level: thinking,
    pending: pendingThinking,
    blocked: thinkingBlocked,
    choose: (level: string) => {
      if (pendingThinking() || level === thinking() || thinkingBlocked()) return;
      if (!socket.send({ type: "set_thinking", level })) return;
      setThinkingError(null);
      setPendingThinking(level);
      clearTimeout(thinkingTimer);
      thinkingTimer = setTimeout(() => thinkingFailed("The server didn't confirm the change."), 15_000);
    },
  };

  /** The composer flyout's model panel (§4b); the header no longer carries a model trigger. */
  const modelControl: ModelControl = {
    model,
    pending: pendingModel,
    blocked: () => {
      if (live.running) return { title: "Model changes wait until this turn finishes.", body: "Stop or wait, then pick one." };
      const reason = blocked();
      return reason && !pendingModel() ? { title: reason.text } : null;
    },
    choose: chooseModel,
  };
  /** The composer foot's mode switch (§4g): this chat's WS "mode" state and its session file. */
  const modeControl: ModeControl = { state: modeState, path: props.path };

  // Mirror this session's run state for the sidebar's Busy chip (the list refetches on settle).
  const setMine = (running: boolean | undefined) =>
    setLocalRunning((m) => {
      const next = { ...m };
      if (running === undefined) delete next[props.path];
      else next[props.path] = running;
      return next;
    });
  // The sidebar's Busy chip falls back to the server's `busy`, which is only as fresh as the last
  // list fetch — refresh it when a run STARTS, so the row keeps its dot after you navigate away.
  // (The settle refresh already exists.)
  let wasRunning = false;
  createEffect(() => {
    const running = live.running;
    setMine(running);
    if (running && !wasRunning) props.onStarted();
    wasRunning = running;
  });
  onCleanup(() => setMine(undefined));

  const send = (text: string, steer: boolean, attachments: UploadResult[]) => {
    if (!socket.send({ type: steer ? "steer" : "prompt", text })) return false;
    // A known slash command isn't a message to the model (templates and skills expand into other
    // text, extensions may never start the agent): no optimistic bubble or running state, just a
    // local "Ran" row, whether sent idle or as a steer mid-turn (pi runs it either way).
    // Unknown "/words" go through as ordinary messages.
    const command = /^\/(\S+)/.exec(text)?.[1];
    if (command && commands().some((c) => c.name === command)) {
      const label = text.length > 61 ? `${text.slice(0, 60)}…` : text;
      batch(() => {
        setCommandRows((rows) => [...rows, { label, tui: false }]);
        setResume((n) => n + 1);
      });
      return true;
    }
    batch(() => {
      addPendingPrompt(setLive, text, [], attachments);
      setLive("running", true);
      setResume((n) => n + 1);
    });
    return true;
  };

  const abort = () => {
    if (socket.send({ type: "abort" })) setLive("stopping", true);
  };

  // Check-now and reconnect, offered only while this runtime has the remote extension's command.
  // Sent straight over the socket: no "Ran" row, the chips show the answer. (The mount toggle is not
  // here: it is a REST call, so it works for a session with no runtime open in this tab.)
  if (remote) {
    const controls: RemoteControls = {
      check: () => socket.send({ type: "prompt", text: REMOTE_CHECK_TEXT }),
      reconnect: () => socket.send({ type: "prompt", text: REMOTE_RECONNECT_TEXT }),
    };
    createEffect(() => setRemoteControls(props.path, commands().some((c) => c.name === REMOTE_COMMAND) ? controls : undefined));
  }

  // ---- The open-failure banner's actions (src/lib/open-failure.ts) -----------------------
  /** What the banner says: derived, so the diagnosis matches the error. No targets list is
      passed: the one-shot /api/targets cache lives in RemoteStatus.tsx (module-private) and this
      banner adds no fetch of its own — the target name is the label fallback the remote chip
      uses too, and the error text itself proves the target declares a mount. */
  const openFailure = createMemo(() => {
    const text = configError();
    return text ? openFailureView(props.summary?.(), text, undefined, mountFailure()) : null;
  });
  /** Reconnect once the folder is back on its own (or after a successful Mount below). The
      server clears its memoized open failure as soon as the mount answers, so the retry opens. */
  const reconnect = () => {
    setConfigError(null);
    setMountFailure(null);
    socket.retry();
  };
  /** Mount and reconnect, offered only when the diagnosis is mount-down: turn the target's
      sshfs mount on, then retry the chat socket. A failure keeps the banner and shows the
      mount module's real reason beside the actions — never a toast that vanishes. */
  const mountAndReconnect = async (target: string | undefined) => {
    if (!target || mounting()) return;
    setMounting(true);
    setMountFailure(null);
    try {
      // Keep the response: it carries the target's fresh mount state, and the chip reads that
      // shared store. Discarding it left the header saying "not mounted" right after a mount.
      patchTarget(await mountTarget(target, true));
      reconnect();
    } catch (err) {
      // Raw message: openFailureView owns the "Mount failed: " prefix (its test asserts it).
      setMountFailure((err as Error).message);
    } finally {
      setMounting(false);
    }
  };
  /** The pane's Archive gesture, on the same endpoint with the same toast and list refresh:
      moves this session to the Archive region and deletes nothing (the title says so). Then
      out of the dead session, on the app's own route to the landing page (the back link's). */
  const archive = async () => {
    if (archiving()) return;
    setArchiving(true);
    try {
      await setSessionArchived(props.path, true);
      toast("Archived. Find it under Archive.");
      props.onArchiveChanged?.();
      location.hash = "#/";
    } catch (err) {
      toast(`Couldn't archive this session. ${(err as Error).message}`);
    } finally {
      setArchiving(false);
    }
  };

  return (
    <>
      <ThreadScroller
        path={props.path}
        count={visibleCount(items() ?? [], { tools: hideTools(props.path), thinking: hideThinking(props.path) }) + live.entries.length}
        resume={resume()}
        busy={!items()}
        banner={
          <div class="stack-2">
            <Show when={!archivedPane()}>
              <ConnectionBanner socket={socket} />
            </Show>
            {/* Permanent until the world it names changes: the diagnosis and the gestures that
                fix it, derived in src/lib/open-failure.ts (spec/01-app-shell.md "The open-failure
                banner"). The first action is the primary one; a failed Mount keeps its real
                reason on screen beside the actions. */}
            <Show when={openFailure()} keyed>
              {(info) => (
                <Banner
                  tone="error"
                  title={info.title}
                  body={
                    <>
                      {info.detail}
                      <Show when={info.mountError}>
                        {(m) => (
                          <span class="text-caption text-error" style={{ display: "block", margin: "var(--space-1) 0 0" }}>
                            {m()}
                          </span>
                        )}
                      </Show>
                    </>
                  }
                  action={
                    <span class="cluster">
                      <For each={info.actions}>
                        {(a, i) => (
                          <Switch>
                            <Match when={a.id === "mount"}>
                              <button
                                type="button"
                                class={`button button-sm${i() === 0 ? "" : " button-ghost"}`}
                                disabled={mounting()}
                                title={a.title}
                                onClick={() => void mountAndReconnect(info.target)}
                              >
                                {mounting() ? "Mounting…" : a.label}
                              </button>
                            </Match>
                            <Match when={a.id === "reconnect"}>
                              <button type="button" class={`button button-sm${i() === 0 ? "" : " button-ghost"}`} onClick={reconnect}>
                                {a.label}
                              </button>
                            </Match>
                            <Match when={a.id === "archive"}>
                              <button
                                type="button"
                                class={`button button-sm${i() === 0 ? "" : " button-ghost"}`}
                                disabled={archiving()}
                                title={a.title}
                                onClick={() => void archive()}
                              >
                                {archiving() ? "Archiving…" : a.label}
                              </button>
                            </Match>
                          </Switch>
                        )}
                      </For>
                    </span>
                  }
                />
              )}
            </Show>
            <Show when={modelError()}>
              {(err) => (
                <Banner
                  tone="error"
                  title={
                    <>
                      Couldn't switch to <code>{idOf(err().target)}</code>.
                    </>
                  }
                  body={
                    <>
                      {(() => {
                        const body = err().body;
                        return typeof body === "string" ? (
                          body
                        ) : (
                          <>
                            {body.noCredentials} has no credentials set up. Log in with <code>pi</code> in a terminal, then try
                            again.
                          </>
                        );
                      })()}
                      <Show when={err().from}> You're still on <code>{idOf(err().from!)}</code>.</Show>
                    </>
                  }
                  action={
                    <button type="button" class="button button-sm button-ghost" onClick={() => setModelError(null)}>
                      Dismiss
                    </button>
                  }
                />
              )}
            </Show>
            {/* A refused thinking change reads like a refused model switch (§4b "Thinking"). */}
            <Show when={thinkingError()}>
              {(err) => (
                <Banner
                  tone="error"
                  title={
                    <>
                      Couldn't set thinking to <code>{err().target}</code>.
                    </>
                  }
                  body={
                    <>
                      {err().body}
                      <Show when={err().from}> You're still on <code>{err().from!}</code>.</Show>
                    </>
                  }
                  action={
                    <button type="button" class="button button-sm button-ghost" onClick={() => setThinkingError(null)}>
                      Dismiss
                    </button>
                  }
                />
              )}
            </Show>
          </div>
        }
      >
        <Show when={items()} fallback={<TranscriptSkeleton />}>
          {(list) => (
            <>
              <HistoryItems items={list()} author={props.author} streaming={live.running} hideTools={hideTools(props.path)} hideThinking={hideThinking(props.path)} />
              <LiveEntries live={live} author={props.author} hideTools={hideTools(props.path)} hideThinking={hideThinking(props.path)} />
              <For each={modelRows()}>
                {(ref) => (
                  <InfoRow>
                    Model changed to <code>{ref}</code>
                  </InfoRow>
                )}
              </For>
              <For each={commandRows()}>
                {(row) => (
                  <div class="info-row" role="note">
                    <span class="info-row-text">
                      <Icon name={row.tui ? "attention" : "terminal"} small />
                      <Show
                        when={row.tui}
                        fallback={
                          <span>
                            Ran <code>{row.label}</code>
                          </span>
                        }
                      >
                        <span>
                          <code>{row.label.split(/\s/)[0]}</code> needs the terminal UI. Run it in pi in a terminal.
                        </span>
                      </Show>
                    </span>
                  </div>
                )}
              </For>
              {/* Only while the thread has zero rows, local rows included (§3 States). */}
              <Show when={list().length === 0 && live.entries.length === 0 && commandRows().length === 0 && modelRows().length === 0}>
                <div class="empty">
                  <p class="empty-title">
                    New session in <code>{props.cwdLabel}</code>.
                  </p>
                  <p class="empty-body">Nothing sent yet. Your first message becomes its title.</p>
                </div>
              </Show>
            </>
          )}
        </Show>
        <For each={errors()}>{(m) => <TurnError message={m} />}</For>
      </ThreadScroller>
      <FlyoutSession.Provider value={() => props.path}>
      <Composer
        path={props.path}
        cwd={props.summary?.()?.cwd ?? null}
        blocked={blocked()}
        commands={commands()}
        running={live.running}
        stopping={live.stopping}
        detail={live.activity ?? runDetail(live)}
        workersWorking={workersWorking()}
        workersTotal={workerList().length}
        workersSplit={workersSplit()}
        onShowWorkers={props.onShowWorkers}
        workersOpen={props.workersOpen}
        inputsOpen={props.inputsOpen}
        paneTab={props.paneTab}
        onNewSession={props.onNewSession}
        onShowTimeline={props.onShowTimeline}
        inputCount={inputCount(items() ?? [])}
        autofocus={props.autofocus}
        model={modelControl}
        thinking={thinkingControl}
        mode={modeControl}
        onShowInfo={() => setShowInfo(true)}
        undo={undoControl}
        onSend={send}
        onAbort={abort}
        restored={restored()}
      />
      </FlyoutSession.Provider>
      <Show when={showInfo()}>
        <SessionInfoDialog
          path={props.path}
          summary={props.summary}
          onArchiveChanged={props.onArchiveChanged}
          onGroupsChanged={props.onGroupsChanged}
          items={() => items() ?? []}
          context={() => {
            const state = sessionContext()[props.path];
            return state && state !== "compacted" ? state : null;
          }}
          onClose={() => {
            setShowInfo(false);
            queueMicrotask(() => document.getElementById(paneId("composer-menu-trigger"))?.focus());
          }}
        />
      </Show>
      <Show when={dialogs()[0]} keyed>
        {(d) => (
          <Portal>
            <UiDialog request={d.request} onAnswer={(v) => answer(d.id, v)} />
          </Portal>
        )}
      </Show>
    </>
  );
}
