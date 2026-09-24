import { batch, createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Portal } from "solid-js/web";
import type { ChatServerMessage, ContextInfo, SandboxInfo, SessionSummary, SlashCommand, TeamInfo, TranscriptItem, WorkerInfo } from "../../shared/protocol";
import { createFork, fetchTranscriptWithContext, setSandbox, setSessionArchived, wsUrl } from "../lib/api";
import { contextStateFor, usageTokens, windowOf } from "../lib/context";
import {
  addPendingPrompt,
  applyEvent,
  applyQueue,
  emptyLive,
  markDelivered,
  markQueued,
  markRemoved,
  newClientId,
  queuedText,
  runDetail,
  takeBackQueued,
  unsentRows,
  type LiveState,
  type LiveUserState,
} from "../lib/live";
import { appendItems } from "../lib/explain";
import { isObj, str } from "../lib/message";
import { ensureModelPolicy, modelEnabled, modelPolicy } from "../lib/model-policy";
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
import type { UploadResult } from "../../shared/protocol";
import {
  copyText,
  drafts,
  hideThinking,
  hideTools,
  rememberSend,
  sentHere,
  sessionContext,
  setDraftText,
  setLocalRunning,
  setSessionContext,
  toast,
} from "../lib/ui-state";
import { stageFork } from "../lib/fork-stage";
import { usePaneAnnounce, usePaneId, usePaneScope } from "../lib/pane-scope";
import { visibleCount } from "../lib/hidden-rows";
import { inputCount } from "../lib/input-count";
import { messageCount } from "../lib/message-count";
import type { RewindControl, RewindResult } from "../lib/inputs";
import type { RewindRefusal } from "../../shared/protocol";
import {
  ACTION_LABEL,
  actionReason,
  actionsFor,
  COPIED,
  copyable,
  forkRefusalText,
  forkSentence,
  queueGoneEffect,
  queueRemoveReason,
  queueRemoveRefusalText,
  type ActionState,
  type MessageStrip,
} from "../lib/message-actions";
import type { MessageActionItem } from "./MessageActions";
import { isTurnStart } from "../lib/turn";
import { entryIdOf } from "../lib/jump";
import { Composer, type ComposerReason } from "./Composer";
import { openCreated } from "../lib/fork-stage";
import { FlyoutSession, type SandboxControl, type ThinkingControl, type UndoControl } from "./ComposerMenu";
import { ConnectionBanner } from "./ConnectionBanner";
import { SessionInfoDialog } from "./SessionInfoDialog";
import { SessionSetupCard } from "./SessionSetup";
import { PlaybooksDialog } from "./PlaybooksDialog";
import type { ModeControl, ModeState } from "./ModeMenu";
import type { ModelControl } from "./ModelMenu";
import { type ForkMarker, HistoryItems, InfoRow, LiveEntries, type MessageActionsProvider, ThreadScroller, TranscriptSkeleton, TurnError } from "./Thread";
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
      needs the same, or the sidebar row stays stale until its next poll. An archived session is
      off the list for good, so the path and the new state go with it. */
  onArchiveChanged?(path: string, archived: boolean): void;
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
  /** A session this view just created (a Fork): the app adopts it — registers it so the route
      resolves before the list refetch lands, refreshes the sidebar, and opens it with the composer
      focused. Writing `location.hash` instead lands on "Couldn't find this session." until the
      list catches up, which is what the end-to-end pass caught. */
  onCreated?(session: SessionSummary): void;
  /** A rewind landed on this chat, whoever asked (a Timeline row, or the flyout's "Undo last
      turn"): the Timeline must re-read the branch, or it keeps offering the abandoned rows.
      Success only — a refusal changed nothing. App mints the generation counter the pane watches.
      No text: this view prefills the composer itself, and the pane rebuilds its shadow from the id. */
  onRewound?(info: { path: string; entryId: string }): void;
  /** This session's teams (polled insight), so the status row can name team members as such. */
  teams?: TeamInfo[];
  /** Where this member was forked from, when it is one (spec/14b): one drawn row in the thread. */
  fork?: ForkMarker;
  /** Open the fanout dialog on this session. Absent (with the flyout row) when there is nothing
      to fork or nobody who may read the file. */
  onFanOut?(source: { leafId: string; messages: number; context: ContextInfo | "compacted" | null }): void;
  /** This pane's turn-error state, for the workspace's roll-up (§14 "Member states"): the latest
      turn-error message while it is current, or null. Current means the last turn ended in an
      error and no newer turn has started — a fresh turn (or a rewind) clears it, so the workspace
      never says "errored" about a pane that is visibly working. Without it a failed member looks
      exactly like a quiet one. */
  onTurnError?(message: string | null): void;
}) {
  // One status region for the whole page: inside a workspace every sentence from this chat says
  // which pane it came from, and every DOM id below carries the pane's id.
  const announce = usePaneAnnounce();
  const scope = usePaneScope();
  const paneId = usePaneId();
  /**
   * A turn's start and end, said the way spec/09-copy-deck.md says them. In a pane the sentence
   * follows the member's name ("control · glm-5.3 — working."), so it reads as a clause about that
   * member; alone on the page it is the whole sentence and stands on its own.
   */
  const turnWord = (member: string, alone: string) => (scope.id ? member : alone);

  const [items, setItems] = createSignal<TranscriptItem[] | null>(null);
  const [live, setLive] = createStore<LiveState>(emptyLive());
  const [syncing, setSyncing] = createSignal(false);
  const [errors, setErrors] = createSignal<string[]>([]);
  /** The pane's turn-error STATE (≠ `errors`, the thread's permanent record): the last turn ended
      in an error and no newer turn has started. Cleared by `agent_start` — a fresh turn supersedes
      the old failure — and by a rewind. Announced when it lands, reported to the workspace's
      roll-up (`onTurnError`), and consulted before "replied.": an errored turn still settles (the
      SDK's `finally` emits `agent_settled` whatever happened), and two endings for one turn would
      read as two turns. A transcript-reload failure (`resync`) never sets it — that turn did not
      fail, the read after it did. */
  const [turnError, setTurnError] = createSignal<string | null>(null);
  /** A permanent open failure (code "config"): shown once, never retried, never appended to. */
  const [configError, setConfigError] = createSignal<string | null>(null);
  /** The open-failure banner's action state (spec/01-app-shell.md "The open-failure banner"): an Archive in flight. */
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
  const [showPlaybooks, setShowPlaybooks] = createSignal(false);

  /**
   * "Fan Out…" in the flyout, and the source it hands over (spec/14b "Entry points").
   *
   * The leaf is the last entry THIS TRANSCRIPT RENDERS, which is the entry the user is looking at
   * — and it is an ENTRY id, not a row id: an assistant message renders one row per content block
   * (`${entryId}:${i}`), so the last row's own id is usually not something the server can match
   * against the file. The server computes its side the same way (readActiveBranch + normalizeEntry,
   * server/fanout.ts) and refuses a leaf that isn't current, so the two have to mean the same thing.
   *
   * The row is ABSENT rather than disabled with nothing to fork: no reply yet, or no items at all.
   * §9 is explicit that an absence needs no explanation.
   *
   * `messages` is a MESSAGE count (src/lib/message-count.ts), because the dialog's fork note says
   * "up to message {n}" — the rendered-row count it used to send counts one row per content block
   * plus every info row, so it named a number that was never a count of messages.
   */
  const fanOut = () => {
    const list = items();
    if (!props.onFanOut || !list || list.length === 0) return undefined;
    if (!list.some((it) => it.kind === "assistant-text" || it.kind === "tool-call")) return undefined;
    const leafId = entryIdOf(list[list.length - 1]!.id);
    if (!leafId) return undefined;
    return () => {
      const state = sessionContext()[props.path];
      props.onFanOut!({
        leafId,
        messages: messageCount(list),
        // The gauge's own state, verbatim: "compacted" stays "compacted" — the dialog turns it
        // into words, never into 0, which is a claim §4f refuses for exactly this state. Null is
        // the fill never having been reported, which the dialog also says as words.
        context: state ?? null,
      });
    };
  };
  /** This session's slash commands (sent after hello, and again after a runtime reload). */
  const [commands, setCommands] = createSignal<SlashCommand[]>([]);
  /** The global mode and how it applies to this chat (WS "mode"). */
  const [modeState, setModeState] = createSignal<ModeState | null>(null);
  /** This chat's sandbox (WS "sandbox"), null while its runtime has no sandbox extension. */
  const [sandbox, setSandboxState] = createSignal<SandboxInfo | null>(null);
  const [sandboxPending, setSandboxPending] = createSignal(false);
  /** Local "Ran /name args" rows; `tui` marks one that asked for a UI Sova can't show. */
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
        if (isObj(ev) && ev.type === "agent_start") {
          setTurnError(null); // a fresh turn supersedes the last one's failure
          announce(turnWord("working.", "Working."));
        }
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
      // "replied." only for a turn that didn't already say how it ended: the error announcement
      // is the ending (see `turnError` above — an errored turn still settles).
      if (!turnError()) announce(turnWord("replied.", "Reply finished."));
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
    // Skips anything a `queue_item_gone` already spoke for: a failed hand-off broadcasts the
    // departure AND an `error` whose code ("busy"/"recent") lands here, without closing the
    // socket, so a row restored by both would be prepended into the draft twice.
    const rows = unsentRows(live, handedBack);
    if (rows.length === 0) return;
    for (const r of rows) if (r.id) handedBack.add(r.id);
    const current = drafts.get(props.path);
    setDraftText(props.path, [...rows.map((r) => r.text), ...(current ? [current] : [])].join("\n\n"));
  };

  /** Ids a `queue_item_gone` has spoken for, so a later snapshot can't be read as evidence about
      them. Which messages THIS TAB sent lives in `sentHere`/`rememberSend` (sessionStorage), so a
      reload between the send and its failure doesn't leave the text with nobody willing to
      restore it. */
  const claimed = new Set<string>();
  /** Ids whose text has already gone back to the composer, so the two paths that can both speak
      for one message — a failed departure and the refusal `error` that accompanies it — hand it
      back exactly once, in whichever order they arrive. */
  const handedBack = new Set<string>();
  /** Items pi has queued work beside: their Remove never comes back (see SHARED_QUEUE_REASON). */
  const [sharedQueue, setSharedQueue] = createSignal<string[]>([]);

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
          setSandboxState(null); // a "sandbox" message follows when the runtime has the extension
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
        // A regenerate landed. Like a rewind, the new branch's hello has already reset the thread;
        // unlike a rewind, the message goes back to the model, not to the composer — so the draft
        // is not touched at all.
        case "regenerated":
          batch(() => {
            setErrors([]); // they belonged to the turns just abandoned
            setTurnError(null);
            setCommandRows([]);
          });
          setActionNote(null);
          announce("Regenerating from your message.");
          props.onRewound?.({ path: props.path, entryId: msg.userEntryId || msg.entryId });
          settleRequest(msg.id, { ok: true });
          break;
        case "regenerate_refused":
          noteOn(msg.entryId, msg.message);
          settleRequest(msg.id, { ok: false, reason: msg.reason, message: msg.message });
          break;
        // The server has our message: it is queued, not merely sent. Until this lands, the row says
        // "Sending…" and offers no Remove — nothing is known to hold it.
        case "send_ack":
          if (msg.queued) markQueued(setLive, msg.clientId);
          break;
        case "queue":
          // A snapshot minted before a departure reached us must not resurrect that row: the
          // broadcast is the authority, the snapshot only lists what is still held.
          applyQueue(setLive, msg.items.filter((it) => !claimed.has(it.id)));
          break;
        /**
         * A message left the queue, broadcast to EVERY client of the chat with the reason it left.
         * This — not the absence of an id from the next snapshot — is what moves a row, because
         * absence is equally true of a delivery, a Stop, a refusal and another tab's removal.
         *
         * "dropped" is the one that would otherwise hang: an extension `input` handler swallowed
         * the message (the model-policy extension does this when the session's model is off), so
         * no message_start will ever come for it. The row goes and the text comes back, in the tab
         * that sent it — the only tab with anywhere to put it.
         */
        case "queue_item_gone": {
          const effect = queueGoneEffect(msg.reason);
          // The text to hand back, from the message when it carries one and otherwise from the row
          // we are about to remove. A "dropped" message has no other carrier — no message_start,
          // no queue_cleared, no ack — so if the broadcast ever stops carrying a body, reading our
          // own row keeps the user's words instead of losing them silently.
          const text = msg.text || queuedText(live, msg.itemId);
          // One departure, one restore: a duplicate of this message (a reconnect, a re-send) must
          // not paste the same text into the draft twice.
          const first = !claimed.has(msg.itemId);
          claimed.add(msg.itemId);
          if (effect.row === "delivered") markDelivered(setLive, msg.itemId);
          else markRemoved(setLive, msg.itemId);
          if (first && effect.restore && text && sentHere(props.path, msg.itemId) && !handedBack.has(msg.itemId)) {
            handedBack.add(msg.itemId);
            setRestored({ text });
            announce(
              msg.reason === "dropped"
                ? "That message was handled without being sent. It's back in the composer."
                : "That message couldn't be sent. It's back in the composer.",
            );
          } else if (msg.reason === "removed" && !removing().includes(msg.itemId)) {
            // Somebody else's tab (or another window of ours) took it back: say so here too, but
            // stay quiet when our own removal is in flight — its ack is about to say it better.
            announce("Removed from the queue.");
          }
          break;
        }
        /**
         * The requester's own ack for ITS removal. It settles the request and nothing else: a
         * Delete is a DISCARD, so the message does NOT come back to the composer. That is the
         * whole difference between Delete and Stop — Stop takes the queue back to be edited and
         * re-sent (`queue_cleared` owns that restore), Delete says this message should never be
         * sent, and silently re-pasting it into the draft would undo the user's gesture.
         *
         * The `text` on this message names what the server removed; it is not an instruction to
         * put it anywhere. The row itself already left with the broadcast above.
         */
        case "queue_removed":
          markRemoved(setLive, msg.itemId);
          announce("Removed from the queue.");
          settleRequest(msg.id, { ok: true });
          break;
        case "queue_remove_refused": {
          const words = queueRemoveRefusalText(msg.reason, msg.message);
          // Not a retry state: this message can never be taken back on its own from here.
          if (msg.reason === "shared_queue") setSharedQueue((l) => (l.includes(msg.itemId) ? l : [...l, msg.itemId]));
          // "consumed" is the one refusal that also changes what the row IS: the agent took it.
          if (msg.reason === "consumed") markDelivered(setLive, msg.itemId);
          settleRequest(msg.id, { ok: false, reason: msg.reason, message: words });
          break;
        }
        // A rewind landed. The server has already broadcast the new branch's hello (and mode), so
        // the thread is reset; what's left is the rewound message, which goes ahead of the draft.
        case "rewound": {
          batch(() => {
            setErrors([]); // they belonged to the turns just abandoned
            setTurnError(null);
            setCommandRows([]);
            if (msg.editorText) setRestored({ text: msg.editorText });
          });
          announce(msg.editorText ? "Rewound. Your message is back in the composer." : "Rewound.");
          props.onRewound?.({ path: props.path, entryId: msg.entryId });
          settleRequest(msg.id, { ok: true, text: msg.editorText });
          break;
        }
        // settleRequest announces it: the pane shows the same message inline on its row.
        case "rewind_refused":
          settleRequest(msg.id, { ok: false, reason: msg.reason, message: msg.message });
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
          setItems((list) => (list ? appendItems(list, msg.items) : list));
          break;
        case "mode":
          setModeState({ mode: msg.mode, minorModes: msg.minorModes, strict: msg.strict, applies: msg.applies });
          break;
        case "sandbox":
          setSandboxState({ on: msg.on, enforcement: msg.enforcement, status: msg.status });
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
            default: {
              if (modelError() || thinkingError()) break; // shown as the switch's banner
              const seen = errors();
              // The same failure re-reported (a reconnect loop) says nothing new: keep one row —
              // and say nothing, because an announcement per retry would read as N new errors.
              // The first landing is announced like every other turn boundary (§3 "Streaming",
              // §9 "SR announcements"): a member whose turn died reads the same as one that
              // replied, in its own pane's voice, without panning to find the banner.
              if (seen[seen.length - 1] !== msg.message) {
                setErrors([...seen, msg.message]);
                setTurnError(msg.message);
                announce(turnWord("stopped with an error.", "The turn stopped with an error."));
              }
              // A prompt that failed before the agent started leaves nothing running.
              if (!live.entries.some((e) => e.kind === "assistant")) setLive("running", false);
            }
          }
          break;
      }
    },
  });

  // ---- Session requests: rewind, regenerate, remove a queued message ------------------------
  /**
   * Every request this socket makes that the server answers by id, in ONE map. The server answers
   * only the socket that asked, so a reply that names an id nobody here is waiting for is somebody
   * else's or an echo, and is ignored. Every refusal is announced from here, whoever asked (the
   * Timeline row and the message strip show the same sentence inline), so the live region says
   * each one exactly once.
   */
  type RequestKind = "rewind" | "regenerate" | "queue_remove";
  /** What a request settles as. `text` is a rewind's message, on its way to the composer. */
  type ActionResult = { ok: true; text?: string } | { ok: false; reason: string; message: string };
  const requests = new Map<string, { kind: RequestKind; resolve: (result: ActionResult) => void }>();
  let requestSeq = 0;
  /** How many of each kind are waiting, reactively: a strip greys its own action while one is out,
      and the flyout's Undo row greys out while a rewind is. */
  const [pending, setPending] = createSignal<Record<RequestKind, number>>({ rewind: 0, regenerate: 0, queue_remove: 0 });
  const countPending = () => {
    const n: Record<RequestKind, number> = { rewind: 0, regenerate: 0, queue_remove: 0 };
    for (const r of requests.values()) n[r.kind]++;
    setPending(n);
  };
  const settleRequest = (id: string, result: ActionResult) => {
    const waiting = requests.get(id);
    if (!waiting) return;
    if (!result.ok) announce(result.message);
    requests.delete(id);
    countPending();
    waiting.resolve(result);
  };
  /** A dropped connection takes its answers with it; the reconnect's hello shows what happened. */
  const dropRequests = () => {
    for (const id of [...requests.keys()])
      settleRequest(id, { ok: false, reason: "disconnected", message: "The connection dropped. Check the thread, then try again." });
  };
  createEffect(on(socket.status, (status) => status !== "open" && dropRequests(), { defer: true }));
  onCleanup(dropRequests);
  const refuseHere = (reason: string, message: string): ActionResult => {
    announce(message);
    return { ok: false, reason, message };
  };
  /** Sends a request and waits for its answer. The id is minted here, so no caller can collide. */
  const ask = (kind: RequestKind, message: Record<string, unknown>): Promise<ActionResult> => {
    const id = `${kind}-${++requestSeq}`;
    return new Promise((resolve) => {
      if (!socket.send({ ...message, id })) return resolve(refuseHere("disconnected", "Not connected. Try again once it reconnects."));
      requests.set(id, { kind, resolve });
      countPending();
    });
  };
  /** How many rewinds are out — the flyout's Undo row reads this. */
  const rewindsPending = () => pending().rewind;
  /**
   * A refusal code from a server that may be newer than this build: anything it doesn't know is
   * "internal", which is what the copy for an unrecognized failure already says.
   *
   * This list MIRRORS `RewindRefusal` and has to grow with it. "queued" is the one that shows why:
   * `steer()` awaits the extension input handlers before the message is queued, so a message can
   * still be on its way out after the turn it meant to interrupt has ended — `isStreaming` false,
   * something genuinely pending — and a rewind allowed in that window delivers it into the NEW
   * branch. The client cannot detect that state, which is exactly why it must not be folded into
   * `rewindBlocked()`: the server refuses and the WORDS SHOWN ARE THE SERVER'S `message`, not
   * anything derived from this code, so a stale entry here mislabels the reason without ever
   * changing the sentence the user reads.
   */
  const asRewindRefusal = (reason: string): RewindRefusal | "disconnected" => {
    const known: (RewindRefusal | "disconnected")[] = [
      "streaming",
      "compacting",
      "busy",
      "recent",
      "not_on_branch",
      "cancelled",
      "queued",
      "internal",
      "disconnected",
    ];
    return known.find((k) => k === reason) ?? "internal";
  };
  const rewindBlocked = (): "streaming" | "compacting" | null => (compacting() ? "compacting" : live.running ? "streaming" : null);
  const rewind = async (entryId: string): Promise<RewindResult> => {
    // The server refuses these too; answering here saves the round trip. Never auto-abort.
    const block = rewindBlocked();
    const refuse = (reason: "streaming" | "compacting", message: string): RewindResult => {
      announce(message);
      return { ok: false, reason, message };
    };
    if (block === "streaming") return refuse(block, "Stop the turn first, then rewind.");
    if (block === "compacting") return refuse(block, "Wait for compaction to finish, then rewind.");
    const result = await ask("rewind", { type: "rewind", entryId });
    return result.ok ? { ok: true, text: result.text ?? "" } : { ok: false, reason: asRewindRefusal(result.reason), message: result.message };
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

  // ---- Per-message actions (spec/03-transcript.md "Message actions") ------------------------
  /**
   * The last refusal, kept on the message it was about. The announcement already said it once
   * (settleRequest); this is the record on the row, so a user who looked away still finds out why
   * nothing happened. One at a time: a second attempt anywhere replaces it.
   */
  const [actionNote, setActionNote] = createSignal<{ entryId: string; text: string } | null>(null);
  const noteOn = (entryId: string | undefined, text: string) => setActionNote(entryId && text ? { entryId, text } : null);
  /** A fork is a REST request, not a socket one: its own in-flight flag. */
  const [forking, setForking] = createSignal(false);
  /** Queued messages with a removal out, by id, so only that row greys. */
  const [removing, setRemoving] = createSignal<string[]>([]);

  /** What every strip in this chat is judged by. Reactive by construction: a turn starting, a
      compaction, a model switch or a reconnect re-enables the actions in place. */
  const actionState = (kind: "rewind" | "regenerate" | "fork", wake = false): ActionState => ({
    chat: true,
    live: false, // a ChatView only exists for a session Sova may write to
    streaming: live.running,
    compacting: compacting(),
    // Rewind and Regenerate both move the branch on the same runtime, and the server has no
    // mutex between them: one in flight blocks the other, not just another of its own kind.
    pending: kind === "fork" ? forking() : pending().rewind + pending().regenerate > 0,
    paused: blocked()?.text ?? null,
    wake,
  });

  /** Regenerate: the server walks back to the user message that started this reply, rewinds to
      just before it and re-prompts its stored text and images with the session's CURRENT model.
      The composer is never touched — what you are half-way through typing is not part of this. */
  const regenerate = async (entryId: string) => {
    setActionNote(null);
    const result = await ask("regenerate", { type: "regenerate", entryId });
    if (result.ok) focusComposer();
    else noteOn(entryId, result.message);
  };

  /**
   * Where focus goes once a branch move lands: the composer. The strip that was pressed is gone —
   * a rewind takes its message off the branch and a regenerate resets the thread to a fresh hello
   * — and the composer is where the next thing happens (a rewind has just put the message there).
   * Without this, a keyboard user is dropped on <body> and has to Tab from the top of the pane.
   */
  const focusComposer = () => queueMicrotask(() => document.getElementById(paneId("composer-input"))?.focus());

  /** Rewind from a message's own strip: the same request the Timeline makes, with the refusal
      kept on this row as well as announced. */
  const rewindFrom = async (entryId: string) => {
    setActionNote(null);
    const result = await rewind(entryId);
    if (result.ok) focusComposer();
    else noteOn(entryId, result.message);
  };

  /**
   * Fork: a new session holding this branch up to here — "before" a message of yours (pi's /fork:
   * its text and attachments land in the new composer, unsent), "at" a reply (pi's /clone). The
   * new session opens; nothing here changes, and nothing there is sent.
   */
  const forkFrom = async (strip: MessageStrip) => {
    if (forking()) return;
    setActionNote(null);
    setForking(true);
    try {
      const out = await createFork({ path: props.path, entryId: strip.entryId, position: strip.role === "user" ? "before" : "at" });
      if (!out.ok) {
        const text = forkRefusalText(out.code, out.message);
        noteOn(strip.entryId, text);
        announce(text);
        return;
      }
      const target = out.session.path;
      // What actually landed in the new composer decides what we say landed there.
      const sentence = forkSentence(await stageFork(target, out.editor));
      noteOn(strip.entryId, "");
      toast(sentence);
      announce(sentence);
      openCreated(out.session, props.onCreated);
    } finally {
      setForking(false);
    }
  };

  /** What each delivered message offers here. Copy is ours alone; the rest are requests with a
      reason when they can't act, never a button that quietly does nothing. */
  const chatActions: MessageActionsProvider = {
    items(strip) {
      return actionsFor(strip.role, { copyable: copyable(strip) }).map((kind): MessageActionItem => {
        switch (kind) {
          case "copy":
            return { kind, reason: null, run: async () => void (await copyText(strip.text, COPIED)) };
          case "fork":
            return { kind, reason: actionReason("fork", actionState("fork")), run: () => forkFrom(strip) };
          case "rewind":
            return { kind, reason: actionReason("rewind", actionState("rewind")), run: () => rewindFrom(strip.entryId) };
          case "regenerate":
            return {
              kind,
              reason: actionReason("regenerate", actionState("regenerate", !!strip.fromWake)),
              run: () => regenerate(strip.entryId),
            };
        }
      });
    },
    note: (entryId) => (actionNote()?.entryId === entryId ? actionNote()!.text : null),
  };

  /** A message of ours that hasn't been delivered: one Remove, by the id the server knows it by.
      A row with no id (sent before this build, or by a client that minted none) offers nothing —
      there is no truthful way to name it to the server. */
  const queueActions = (row: { id?: string; state: LiveUserState; text: string }): MessageActionItem[] => {
    const id = row.id;
    if (!id) return [];
    return [
      {
        kind: "remove",
        label: ACTION_LABEL.remove,
        reason: queueRemoveReason({ state: row.state, pending: removing().includes(id), chat: true, sharedQueue: sharedQueue().includes(id) }),
        run: () => removeQueued(id),
      },
    ];
  };

  const removeQueued = async (id: string) => {
    if (removing().includes(id)) return;
    setRemoving((l) => [...l, id]);
    try {
      // The answer does the work, and it comes in two halves: `queue_item_gone` is broadcast, so
      // the row leaves every tab including this one, while `queue_removed` is ours alone and only
      // settles this request and hands the text to this composer. A refusal says why, and for
      // "consumed" leaves the row as the delivered message it turned out to be.
      await ask("queue_remove", { type: "queue_remove", itemId: id });
    } finally {
      setRemoving((l) => l.filter((x) => x !== id));
    }
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
  /** The flyout's Sandbox row: the extension answers with a toast and a "sandbox" message. */
  const sandboxControl: SandboxControl = {
    state: sandbox,
    pending: sandboxPending,
    set: (on) => {
      setSandboxPending(true);
      setSandbox(props.path, on)
        .then((r) => {
          if (r.outcome === "skip") toast("Sandbox unchanged: another writer has this session. Nothing was written.");
          if (r.sandbox) setSandboxState(r.sandbox);
          if (r.sandbox) announce(r.sandbox.status);
        })
        .catch((err) => toast(`Sandbox unchanged: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => setSandboxPending(false));
    },
  };

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

  // The policy this chat is judged by. Cached app-wide, so the Settings dialog's last save is
  // already here; a policy we couldn't read blocks nothing (the server still refuses).
  void ensureModelPolicy().catch(() => {});
  /** Why this chat can't send right now — its model is off — or null. */
  const offNow = (): string | null => {
    const ref = model();
    const policy = modelPolicy();
    if (!ref || !policy || modelEnabled(policy, ref)) return null;
    return `${ref} is turned off in Settings → Models. Pick another model, then send this again.`;
  };

  // The same pane's turn-error state as data (the prop's doc, above): the workspace meta line
  // pairs a word with colour from this (§14 "every state pairs a word with colour"), and a pane
  // outside a workspace has nobody to tell — the prop is simply absent there.
  createEffect(() => props.onTurnError?.(turnError()));

  const send = (text: string, steer: boolean, attachments: UploadResult[]) => {
    // A model turned off in Settings → Models is refused by the server on its way to the provider
    // (server/model-policy.ts). Saying so here keeps the message in the composer instead of
    // spending it on a refusal, and never picks another model for you (§12).
    const offModel = offNow();
    if (offModel) {
      setErrors((e) => (e[e.length - 1] === offModel ? e : [...e, offModel]));
      announce(offModel);
      return false;
    }
    // The id this message is known by from here on: the server echoes it in `send_ack`, lists it
    // in the queue snapshot, and takes it back by it. Minted per send, so two identical messages
    // are still two messages — which is what makes removing the middle one of three possible.
    const clientId = newClientId();
    if (!socket.send({ type: steer ? "steer" : "prompt", text, clientId })) return false;
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
    rememberSend(props.path, clientId);
    batch(() => {
      addPendingPrompt(setLive, text, [], attachments, clientId);
      setLive("running", true);
      setResume((n) => n + 1);
    });
    return true;
  };

  const abort = () => {
    if (socket.send({ type: "abort" })) setLive("stopping", true);
  };

  // Check-now and reconnect, offered only while this runtime has the remote extension's command.
  // Sent straight over the socket: no "Ran" row, the chips show the answer.
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
      uses too. */
  const openFailure = createMemo(() => {
    const text = configError();
    return text ? openFailureView(props.summary?.(), text) : null;
  });
  /** Reconnect once the folder is back on its own. */
  const reconnect = () => {
    setConfigError(null);
    socket.retry();
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
      props.onArchiveChanged?.(props.path, true);
      if (!scope.id) location.hash = "#/";
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
                banner"). The first action is the primary one. */}
            <Show when={openFailure()} keyed>
              {(info) => (
                <Banner
                  tone="error"
                  title={info.title}
                  body={info.detail}
                  action={
                    <span class="cluster">
                      <For each={info.actions}>
                        {(a, i) => (
                          <Switch>
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
              <HistoryItems
                items={list()}
                author={props.author}
                streaming={live.running}
                hideTools={hideTools(props.path)}
                hideThinking={hideThinking(props.path)}
                fork={props.fork}
                actions={chatActions}
              />
              <LiveEntries
                live={live}
                author={props.author}
                hideTools={hideTools(props.path)}
                hideThinking={hideThinking(props.path)}
                queueActions={queueActions}
              />
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
                  <SessionSetupCard path={props.path} />
                  <p class="empty-body">Your first message becomes its title.</p>
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
        sandbox={sandboxControl}
        onShowInfo={() => setShowInfo(true)}
        onPlaybooks={() => setShowPlaybooks(true)}
        onFanOut={fanOut()}
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
      <Show when={showPlaybooks()}>
        <PlaybooksDialog
          path={props.path}
          cwd={props.summary?.()?.cwd ?? null}
          // What stops the composer's Send stops Send Playbook, with the same reason line; a model
          // turned off in Settings → Models is said there too, rather than only as a refusal row.
          blocked={blocked() ?? (offNow() ? { icon: "attention", text: offNow()! } : null)}
          // Never a steer: a whole playbook mid-turn goes in as a follow-up the server queues
          // behind the running turn (a removable queue row), not into the turn it would derail.
          onSend={(text) => send(text, false, [])}
          onClose={(sent) => {
            setShowPlaybooks(false);
            // After a send the next thing is the conversation (spec §4 "Focus"); otherwise back
            // to the trigger the dialog was opened from.
            if (sent) focusComposer();
            else queueMicrotask(() => document.getElementById(paneId("composer-menu-trigger"))?.focus());
          }}
          // The view is going away under the open dialog (the session turned read-only): what was
          // typed goes to the top of this session's draft, where restoreUnsent puts unsent turns.
          onOrphan={(text) => {
            const current = drafts.get(props.path);
            setDraftText(props.path, current ? `${text}\n\n${current}` : text);
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
