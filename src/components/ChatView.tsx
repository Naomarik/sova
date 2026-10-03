import { archivedDropToast, orgProjectOf } from "../lib/drag-archive";
import { batch, createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Portal } from "solid-js/web";
import type {
  ChatClaudeLogin,
  ClaudeAccountsInfo,
  ChatServerMessage,
  OverseerQuickAction,
  SandboxInfo,
  ChatProfileInfo,
  SessionSummary,
  SlashCommand,
  TeamInfo,
  TranscriptItem,
  WorkerInfo,
} from "../../shared/protocol";
import { createTurnOwner, goTo, navigateDetails } from "../lib/overseer";
import { batonComposerGate } from "../lib/baton-strip";
import { tuiOnlyCommand } from "../lib/slash";
import { OverseerThreadContext, QuickActions, scrollToCard } from "./OverseerCards";
import { CARD_TOOL, type OverseerCard } from "../../shared/overseer-card";
import { cardFold, openCards } from "../lib/overseer";
import { CardJumpContext } from "../lib/card-refs";
import { AlignAnswerContext, type AlignAnswer } from "./AlignDocCard";
import { acceptAllMessage, choosePick, clearPicks, composeWithPicks, optionPick, pickCount, picksLabel, picksOf, prunePicks, samePicks } from "../lib/align-picks";
import { BatonStrip } from "./BatonStrip";
import { approveSchedule, forkSession, getChatClaudeAccounts, getOverseerAutonomy, revokeOverseerPermit, revokeSchedule, setSandbox, setSessionArchived, wsUrl } from "../lib/api";
import type { OverseerAutonomy, ScheduleInfo } from "../../shared/protocol";
import { LOGIN_UNCHANGED } from "../../shared/protocol";
import { contextStateFor, messageContextTokens, windowOf } from "../lib/context";
import {
  addPendingPrompt,
  applyEvent,
  BATON_SENT_EVENT,
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
import { HOST_MOVE_GRACE_MS, hostOf, mayBeHostMove, meshOn, recheckHost, sessionHrefOn, sessionViewKey } from "../lib/mesh";
import { cachedTranscript, cacheItems, cacheSpot, keptOlder, transcripts } from "../lib/transcript-cache";
import { inputsPending, knownInputs, knownWorkers, workersShown } from "../lib/known-before-mount";
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
import { providerWait, watchProviderWaits } from "../lib/provider-waiting";
import { waitingSentence } from "../../shared/provider-limits";
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
import { usePaneAnnounce, usePaneId, usePaneScope } from "../lib/pane-scope";
import { visibleCount } from "../lib/hidden-rows";
import { isChangeRow, isProfileRow } from "../lib/change-rows";
import { ProfilePicker } from "./ProfilePicker";
import { playbookTurnText } from "../../shared/playbooks";
import type { RewindControl, RewindResult } from "../lib/inputs";
import type { RewindRefusal } from "../../shared/protocol";
import { COMPACT_IMAGES_REFUSAL, compactCommand } from "../../shared/compact";
import { COMPACT_STREAMING_REASON, COMPACTING_REASON, compactedAnnouncement } from "../lib/compact";
import {
  ACTION_LABEL,
  actionReason,
  actionsFor,
  COPIED,
  copyable,
  queueGoneEffect,
  queueRemoveReason,
  queueRemoveRefusalText,
  type ActionState,
  SHARE_WAIT_REASON,
} from "../lib/message-actions";
import { shareHref } from "../lib/share-slice";
import type { MessageActionItem } from "./MessageActions";
import { isInput } from "../lib/turn";
import { noteLinks } from "../lib/links-live";
import { jumpToEntry, jumpWhenArrived, landExplainJump, transcriptRoot } from "../lib/jump";
import { inputTotal, lastInput as lastInputOf, newestOnly, newRows } from "../lib/older-rows";
import { createOlderRows } from "../lib/older-rows-view";
import { alignRowFromDetails, foldAlignRows, recommendedOption, type AlignEntry } from "../lib/align";
import { Composer, type ComposerReason } from "./Composer";
import { FlyoutSession, type LoginControl, type SandboxControl, type ThinkingControl, type UndoControl } from "./ComposerMenu";
import { ConnectionBanner } from "./ConnectionBanner";
import { SessionSetupCard } from "./SessionSetup";
import { PlaybooksDialog } from "./PlaybooksDialog";
import type { ModeControl, ModeState } from "./ModeMenu";
import type { ModelControl } from "./ModelMenu";
import { ChangesSession } from "./ChangesViewer";
import { HistoryItems, LiveEntries, type MessageActionsProvider, ThreadScroller, ToolSourceContext, TranscriptSkeleton, TurnError } from "./Thread";
import { SubagentLimitRow } from "./SubagentLimitRow";
import { failureHasRow } from "../lib/subagent-limit";
import { Banner, Icon } from "./ui";
import { UiDialog } from "./UiDialog";

export type ChatRefusal = "busy" | "recent";

/** What a typed "/mode" in the Overseer's composer is answered with: it has no mode switch. */
const OVERSEER_MODE_FIXED = "The Overseer is always in normal mode.";

/** What makes a chat the Overseer's: its extras, all absent from every other chat. */
export interface OverseerChat {
  /** The quick actions its button offers, in the composer foot's mode slot (Settings → Overseer). */
  quickActions(): OverseerQuickAction[];
  /** "/clear": a new conversation; resolves false when nothing was cleared. */
  onClear(): Promise<boolean>;
  /** The runtime under this socket was replaced (a clear from another tab): re-resolve the route. */
  onReloaded(): void;
  /** The empty thread's words: a live fact, then the absence. */
  empty(): JSX.Element;
  /** Hands the page this chat's own send while it is mounted, so a control outside the thread (the
      Ideas panel) sends an ordinary user message, as a quick action does. Returns the unbind the
      chat calls when it unmounts. */
  bindSender?(sender: OverseerSender): () => void;
}

/** A user message into the Overseer's chat, through the composer's own send. */
export interface OverseerSender {
  /** False when nothing was sent (the model is off, the socket is down). */
  send(text: string): boolean;
  /** Why sending is not possible right now, in the composer's words; null when it is. */
  blocked(): string | null;
}

/** ui_request kinds UiDialog can show; anything else needs the terminal UI. */
const UI_DIALOG_METHODS = ["select", "confirm", "input", "editor"];

/**
 * Full-duplex chat with a webapp-owned session. When the server refuses to let us write
 * (`busy`: a TUI owns it; `recent`: an unknown process wrote it moments ago), `onRefused` hands
 * control back so the parent can switch to the read-only watch view.
 */
export function ChatView(props: {
  path: string;
  /** The session-list row for this chat, live from the sidebar's poll. */
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
  /** This chat's Claude login (WS "claude_login"; null after each hello), for the sidebar foot's
      usage glance. */
  onClaudeLogin?(login: ChatClaudeLogin | null): void;
  /** The session's profile as the socket said it (the head chip, §chat.profiles/after-first-message). */
  onProfile?(info: ChatProfileInfo): void;
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
  /** The session list re-reads this after the open-failure banner's Archive succeeds, or the
      sidebar row stays stale until its next poll. An archived session is off the
      list for good, so the path and the new state go with it. */
  onArchiveChanged?(path: string, archived: boolean): void;
  /** A bare "/new" in the composer; resolves to the new session's folder label, or null. */
  onNewSession?(): Promise<string | null>;
  /** Opens the session pane's Timeline tab: a bare "/timeline" unfiltered; a bare "/tree" and
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
  /** This pane's turn-error state, for the workspace's roll-up: the latest
      turn-error message while it is current, or null. Current means the last turn ended in an
      error and no newer turn has started — a fresh turn (or a rewind) clears it, so the workspace
      never says "errored" about a pane that is visibly working. Without it a failed member looks
      exactly like a quiet one. */
  onTurnError?(message: string | null): void;
  /** Set only for the Overseer's own chat. */
  overseer?: OverseerChat;
  /** Set only for a project overseer's current conversation: its "/clear", and a clear from another tab. */
  projectOverseer?: { onClear(): Promise<boolean>; onReloaded(): void };
}) {
  // One status region for the whole page: inside a workspace every sentence from this chat says
  // which pane it came from, and every DOM id below carries the pane's id.
  const announce = usePaneAnnounce();
  const scope = usePaneScope();
  const paneId = usePaneId();
  /**
   * A turn's start and end, said the way the copy deck says them. In a pane the sentence
   * follows the member's name ("control · glm-5.3 — working."), so it reads as a clause about that
   * member; alone on the page it is the whole sentence and stands on its own.
   */
  const turnWord = (member: string, alone: string) => (scope.id ? member : alone);

  // Switching back paints the rows kept from the last visit at once, where they were scrolled to;
  // the hello then reconciles them (lib/transcript-cache).
  const cacheKey = sessionViewKey(hostOf(props.path), props.path);
  const cached = cachedTranscript(cacheKey);
  onCleanup(transcripts.show(cacheKey));
  const [items, setItems] = createSignal<TranscriptItem[] | null>(cached?.items ?? null);
  /** The rows above the list that it doesn't hold (lib/older-rows): the hello says how many and
      what the complete-list readers need of them, and they're fetched when wanted. Until this
      connection's hello, a list kept from the last visit says nothing about what's above it:
      nothing says a row isn't there, and nothing counts the whole list. */
  // The Overseer's history is the longest there is: it holds only what is shown or jumped to.
  const olderRows = createOlderRows({ path: props.path, items, setItems, prefetch: !props.overseer });
  const { older, whole } = olderRows;
  createEffect(on([items, older], ([list, o]) => list && cacheItems(cacheKey, list, o)));
  /** The branch's inputs: this connection's hello says; before it, the rows kept from the last
      visit (or a preload) count with what was above them, and the hello corrects it. null: not
      known yet. */
  const inputCount = () => {
    const list = items();
    const o = older() ?? keptOlder(cached, list);
    return o ? inputTotal(list ?? [], o) : null;
  };
  /** The last hello's first row: rows that arrive above it are history, never "N new". */
  const [newFrom, setNewFrom] = createSignal<string | null>(null);
  // "Open in Session" from an Explanations card: once the transcript is here (hello), land on that
  // explanation's row. Only a jump waiting for this session is claimed, and only once; one whose
  // row isn't here is fetched, down to it.
  createEffect(
    on([items, older], ([list, o]) => list && landExplainJump({ path: props.path, sessionId: props.summary?.()?.id }, list, toast, whole(), o ? olderRows.api.load : undefined)),
  );
  /** Whether the running turn is this tab's: only then does a navigate result move this tab. */
  const owner = createTurnOwner((id) => sentHere(props.path, id));
  const [live, setLive] = createStore<LiveState>(emptyLive());
  /** This run's align results, in call order (§chat.alignment/chip counts them before the run settles). */
  const liveAligns = createMemo(() =>
    Object.values(live.tools)
      .filter((t) => t.name === "align" && t.status === "done")
      .map((t) => alignRowFromDetails(t.details))
      .filter((r) => r !== undefined),
  );
  /** The branch's alignments: those open above the rows held (the hello's summary), the settled
      rows, then this run's. */
  const aligns = createMemo(() => foldAlignRows(items() ?? [], liveAligns(), older()?.summary.aligns ?? []));
  /** Documents this run changed: their settled cards collapse to revision rows until the refetch. */
  const liveAlignIds = createMemo(() => new Set(liveAligns().flatMap((r) => (r.doc ? [r.doc.id] : []))));
  /** This run's sova_card results, in call order, and the thread's cards with them (§app.overseer/confirm). */
  const liveCards = createMemo(() => Object.values(live.tools).filter((t) => t.name === CARD_TOOL && t.status === "done").map((t) => t.details));
  // The cards open above the rows held (the hello's summary) come first, so the chip counts them.
  const cards = createMemo(() => cardFold(items() ?? [], liveCards(), older()?.summary.cards ?? []));
  /** Cards this run changed: their settled rows read as one line until the refetch. */
  const liveCardIds = createMemo(() => new Set([...cards().cards.keys()].filter((id) => !cards().newest.has(id))));
  /** What a click on each card sent, until the turn it started settles (the card shows "Sent: b"). */
  const [cardSent, setCardSent] = createSignal<Record<string, string>>({});
  const jumpToCard = (card: OverseerCard) => {
    if (scrollToCard(card.id)) return;
    const row = cards().newest.get(card.id);
    // A card above the rows held: fetch down to its row, then land.
    if (row && !items()?.some((it) => it.id === row)) {
      jumpWhenArrived(row, props.path, () => toast("That card isn't in the transcript on screen."));
      return;
    }
    if (row && jumpToEntry(row, props.path)) return;
    toast("That card isn't in the transcript on screen.");
  };
  // The Overseer's running count and approvals (§app.overseer/approvals, §app.overseer/caps): read
  // on open, at every turn's end and every 15 s, so an expiry or a use elsewhere shows.
  const [autonomy, setAutonomy] = createSignal<OverseerAutonomy | undefined>(undefined);
  const refreshAutonomy = () => {
    if (!props.overseer) return;
    void getOverseerAutonomy().then(setAutonomy, () => {});
  };
  if (props.overseer) {
    refreshAutonomy();
    const timer = setInterval(refreshAutonomy, 15_000);
    onCleanup(() => clearInterval(timer));
  }
  const revokePermit = async (id: string): Promise<string | null> => {
    try {
      await revokeOverseerPermit(id);
      refreshAutonomy();
      return null;
    } catch (err) {
      refreshAutonomy();
      return err instanceof Error ? err.message : String(err);
    }
  };
  // A playbook schedule, approved or revoked from the same panel (§chat.schedules/where-shown).
  const scheduleAct = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try {
      await fn();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      refreshAutonomy();
    }
  };
  const approveScheduleFromPanel = (s: ScheduleInfo) => scheduleAct(() => approveSchedule({ cwd: s.root, playbook: s.playbook, pin: s.pin ?? "" }));
  const revokeScheduleFromPanel = (id: string) => scheduleAct(() => revokeSchedule(id));
  const jumpToCardId = (id: string) => {
    const card = cards().cards.get(id);
    if (card) jumpToCard(card);
    else toast("That card isn't in the transcript on screen.");
  };
  const jumpToToolCall = (toolCallId: string) => {
    // The call's row draws the act (its result folds into it and renders nothing of its own).
    const rows = items()?.filter((it) => it.toolCallId === toolCallId) ?? [];
    rows.sort((a, b) => Number(b.kind === "tool-call") - Number(a.kind === "tool-call"));
    if (rows.some((row) => jumpToEntry(row.id, props.path))) return;
    toast("That act isn't in the transcript on screen.");
  };
  const jumpToAlign = (entry: AlignEntry) => {
    if (entry.rowId && jumpToEntry(entry.rowId, props.path)) return;
    // A revision above the rows held: fetch down to it, then land.
    if (entry.rowId && !items()?.some((it) => it.id === entry.rowId)) {
      jumpWhenArrived(entry.rowId, props.path, () => toast("That alignment isn't in the transcript on screen."));
      return;
    }
    // A revision this run made has no transcript row yet: its live card carries the document's id.
    const card = transcriptRoot(props.path)?.querySelector<HTMLElement>(`[data-align-live="${CSS.escape(entry.doc.id)}"]`);
    if (card) card.scrollIntoView({ block: "center", behavior: "smooth" });
    else toast("That alignment isn't in the transcript on screen.");
  };
  const [syncing, setSyncing] = createSignal(false);
  /** The thread's turn-error rows: the message, and the FAILED TURN'S own model provider when the
      server said it (live error event only — a worker's failure in the thread never carries one,
      so the limit row never guesses it from this chat's model). */
  const [errors, setErrors] = createSignal<{ message: string; provider?: string }[]>([]);
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
  /** The open-failure banner's action state: an Archive in flight. */
  const [archiving, setArchiving] = createSignal(false);
  const [dialogs, setDialogs] = createSignal<{ id: string; request: unknown }[]>([]);
  const [resume, setResume] = createSignal(0);
  /** Queued steers/follow-ups a Stop drained, handed back to the composer. */
  const [restored, setRestored] = createSignal<{ text: string } | null>(null);
  /** Run Playbook sent the message box's text: the composer empties (§chat.profiles/playbook). */
  const [taken, setTaken] = createSignal<{ at: number } | null>(null);
  const [everOpened, setEverOpened] = createSignal(false);
  const [model, setModel] = createSignal<string | null>(null);
  const [pendingModel, setPendingModel] = createSignal<string | null>(null);
  const [modelError, setModelError] = createSignal<{ target: string; from: string | null; body: string | { noCredentials: string } } | null>(null);
  /** The session's thinking level (WS "thinking"; seeded by hello). The server is the authority:
      it clamps to the model's ladder, and re-sends after every model switch. */
  const [thinking, setThinking] = createSignal<string | null>(null);
  /** Level asked for, until the echo. A refusal ends it and leaves the level as it was. */
  const [pendingThinking, setPendingThinking] = createSignal<string | null>(null);
  const [thinkingError, setThinkingError] = createSignal<{ target: string; from: string | null; body: string } | null>(null);
  /** A refused or failed switch of Claude login (§app.claude-logins/switch-login): the server's reason. */
  const [loginError, setLoginError] = createSignal<string | null>(null);
  /** The login panel's reading of this host's logins, at each opening. */
  const [loginInfo, setLoginInfo] = createSignal<ClaudeAccountsInfo | null>(null);
  const [loginInfoError, setLoginInfoError] = createSignal<string | null>(null);
  const [showPlaybooks, setShowPlaybooks] = createSignal(false);

  /** This session's slash commands (sent after hello, and again after a runtime reload). */
  const [commands, setCommands] = createSignal<SlashCommand[]>([]);
  /** The global mode and how it applies to this chat (WS "mode"). */
  const [modeState, setModeState] = createSignal<ModeState | null>(null);
  /** This chat's sandbox (WS "sandbox"), null while its runtime has no sandbox extension. */
  const [sandbox, setSandboxState] = createSignal<SandboxInfo | null>(null);
  /** The socket's `profile` message (§chat.profiles/applying); null until one arrives. */
  const [profileInfo, setProfileInfo] = createSignal<ChatProfileInfo | null>(null);
  /** A One at a time race at Send (§chat.profiles/singleton): the session that has it. */
  const [profileRace, setProfileRace] = createSignal<{ label: string; running: { id: string; path: string; title: string } } | null>(null);
  const [sandboxPending, setSandboxPending] = createSignal(false);
  /** This chat's Claude login (WS "claude_login"), null until told or when the host can't name one. */
  const [claudeLogin, setClaudeLogin] = createSignal<ChatClaudeLogin | null>(null);
  /** Local "Ran /name args" rows; `tui` marks one that asked for a UI Sova can't show, `note` one
      that was refused (a /compact), whose row then says why instead of "Ran". */
  const [commandRows, setCommandRows] = createSignal<{ label: string; tui: boolean; note?: string }[]>([]);
  /** Subagents working now (WS "workers"); 0 until the first one arrives. */
  const [workersWorking, setWorkersWorking] = createSignal(0);
  /** The same message's list, so the status row can split the count against this session's teams. */
  const [workerList, setWorkerList] = createSignal<WorkerInfo[]>([]);
  const workersSplit = () => workingSplit(workersWorking(), workerList(), props.teams);
  /** While a turn runs and its model request waits on its provider's limit, the status says so
      in place of Working (§app.provider-limits/waiting-shown). */
  watchProviderWaits(() => live.running);
  const waitWords = () => {
    const w = live.running ? providerWait(props.summary?.()?.id) : undefined;
    return w ? waitingSentence(w) : null;
  };
  /** A "workers" message has arrived since the last hello: from then on the workers are the
      socket's to say. The hello clears the list, but its runtime's first "workers" can come a
      while after it (none at all while the runtime has no live record yet). */
  const [workersSaid, setWorkersSaid] = createSignal(false);
  /** How many subagents the settled-workers trigger offers: until the socket says, what the
      session list counts (lib/known-before-mount), so the status row is there from the first
      frame and doesn't blink at the hello; never the working count, which only the socket gives. */
  const workersTotal = () => workersShown(workersSaid(), workerList().length, knownWorkers(props.summary?.() ?? { live: null }));
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
      // The rows the list holds, from disk (lib/older-rows): rows whose entry didn't change keep
      // their DOM (open cards, focus), so the turn's own rows are the only new ones. Rows above the
      // list stay unfetched.
      const next = await olderRows.refresh();
      if (next !== "stale") setSessionContext(props.path, contextStateFor(next.context ?? null, next.items)); // authoritative after each turn
      batch(() => {
        setLive(reconcile(emptyLive()));
        setCommandRows([]); // local only; the persisted entries now tell the story
      });
    } catch (err) {
      // Keep the streamed turn on screen; it's accurate, just not re-normalized.
      setErrors((e) => [...e, { message: `Couldn't reload the transcript after this run: ${(err as Error).message}` }]);
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
    let navigate: string | null = null;
    batch(() => {
      for (const ev of events) {
        if (isObj(ev) && ev.type === "agent_start") {
          setTurnError(null); // a fresh turn supersedes the last one's failure
          announce(turnWord("working.", "Working."));
        }
        // Context fill at turn end: the finished assistant message carries the final usage
        // (no extra server push). A compaction makes it stale until the next reply.
        if (isObj(ev) && ev.type === "message_end" && isObj(ev.message) && ev.message.role === "assistant") {
          const tokens = messageContextTokens(ev.message);
          if (tokens !== null) setSessionContext(props.path, { tokens, window: windowOf(sessionContext()[props.path]) });
        }
        if (isObj(ev) && ev.type === "compaction_start") setCompacting(true);
        if (isObj(ev) && ev.type === "compaction_end") {
          setCompacting(false);
          // Only a compaction that WROTE one makes the fill stale; a failed or cancelled one
          // (no `result`) left the context exactly as it was.
          if (isObj(ev.result)) setSessionContext(props.path, "compacted");
        }
        // The Overseer's navigate: applied only in the tab whose message started this turn — never
        // another tab's, never a proactive brief's (no tab sent it), never a replay.
        if (props.overseer && isObj(ev) && ev.type === "tool_execution_end" && ev.toolName === "sova_navigate" && ev.isError !== true && owner.mine()) {
          const nav = navigateDetails(isObj(ev.result) ? ev.result.details : undefined);
          if (nav) navigate = nav.href;
        }
        applyEvent(setLive, ev);
        if (isObj(ev) && ev.type === "agent_settled") {
          settled = true;
          owner.settled();
          setCardSent({});
          refreshAutonomy();
        }
      }
    });
    if (navigate) {
      const href = navigate;
      queueMicrotask(() => goTo(href));
    }
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

  const turnFailed = (message: string, provider?: string) => {
    const seen = errors();
    // The same failure re-reported (a reconnect loop) says nothing new: keep one row —
    // and say nothing, because an announcement per retry would read as N new errors.
    // The first landing is announced like every other turn boundary: a member whose turn
    // died reads the same as one that
    // replied, in its own pane's voice, without panning to find the banner.
    if (seen[seen.length - 1]?.message !== message) {
      setErrors([...seen, { message, ...(provider ? { provider } : {}) }]);
      setTurnError(message);
      announce(turnWord("stopped with an error.", "The turn stopped with an error."));
    }
    // A prompt that failed before the agent started leaves nothing running.
    if (!live.entries.some((e) => e.kind === "assistant")) setLive("running", false);
  };
  /** A "not found" held back as a possible host change: shown as before if no change replaced the
      view in time (the file really is gone), dropped if the socket reconnects. */
  let notFoundTimer: ReturnType<typeof setTimeout> | undefined;
  const holdNotFound = (message: string) => {
    if (notFoundTimer !== undefined) return;
    recheckHost();
    notFoundTimer = setTimeout(() => {
      notFoundTimer = undefined;
      turnFailed(message);
    }, HOST_MOVE_GRACE_MS);
  };
  const dropNotFound = () => {
    clearTimeout(notFoundTimer);
    notFoundTimer = undefined;
  };
  onCleanup(dropNotFound);

  const socket = createReconnectingSocket<ChatServerMessage>(newestOnly(wsUrl("/ws/chat", props.path, props.force)), {
    onOpen(isReconnect) {
      setEverOpened(true);
      // hello follows and replaces everything; dialogs belonged to the old connection.
      if (isReconnect) setDialogs([]);
    },
    onMessage(msg) {
      switch (msg.type) {
        case "hello":
          dropNotFound();
          cancelAnimationFrame(frame);
          frame = 0;
          queue = [];
          statusAsker.hello();
          owner.reset();
          batch(() => {
            // The newest rows; the rest are fetched when wanted (lib/older-rows). Rows kept above
            // the hello's first row are that row's ancestors, entries that never change: they stay,
            // so a rewind or a reconnect doesn't make a whole list partial or its counts blink.
            olderRows.hello(msg);
            setNewFrom(msg.items[0]?.id ?? null);
            // A client that connects mid-compaction shows it, as the compaction_start it missed would.
            setLive(reconcile({ ...emptyLive(), running: msg.isStreaming, activity: msg.isCompacting ? "Compacting context" : null }));
            setCompacting(!!msg.isCompacting);
          });
          setModel(msg.model);
          setSandboxState(null); // a "sandbox" message follows when the runtime has the extension
          setProfileInfo(null); // a "profile" message follows for a profile or a session before its first message
          setClaudeLogin(null); // a "claude_login" message follows when this host has several logins
          props.onClaudeLogin?.(null);
          batch(() => {
            setThinking(msg.thinking);
            setPendingThinking(null);
            setThinkingError(null);
          });
          setSessionContext(props.path, contextStateFor(msg.context ?? null, msg.items));
          setWorkersWorking(0); // a runtime without workers sends no "workers" after hello
          batch(() => {
            setWorkerList([]);
            setWorkersSaid(false);
          });
          props.onWorkers?.([], null);
          // "links" comes after hello only when there are any: until one does, the pane reads the
          // polled insight, never a list from before the reconnect.
          noteLinks(props.path, null);
          props.onModel(msg.model);
          break;
        case "workers":
          batch(() => {
            setWorkersWorking(msg.working);
            setWorkerList(msg.workers);
            setWorkersSaid(true);
          });
          props.onWorkers?.(msg.workers, usageTotal(msg));
          break;
        case "links":
          noteLinks(props.path, msg.links);
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
          owner.ack(msg.clientId, msg.queued);
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
          owner.gone(msg.itemId, msg.reason);
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
        // The hello that carries the compaction row has already arrived; this only settles the ask.
        case "compacted":
          settleRequest(msg.id, { ok: true, tokensBefore: msg.tokensBefore });
          break;
        case "compact_refused":
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
          // A baton sender marker also names the live row it follows, in event order (applyEvent).
          for (const it of msg.items)
            if (it.batonMark?.kind === "sent") {
              queue.push({ type: BATON_SENT_EVENT, by: it.batonMark.by });
              if (!frame) frame = requestAnimationFrame(flush);
            }
          break;
        case "mode":
          setModeState({ mode: msg.mode, minorModes: msg.minorModes, strict: msg.strict, applies: msg.applies });
          break;
        case "sandbox":
          setSandboxState({ on: msg.on, enforcement: msg.enforcement, status: msg.status });
          break;
        case "profile": {
          const { type: _t, ...info } = msg;
          setProfileInfo(info);
          props.onProfile?.(info);
          if (info.locked) setProfileRace(null);
          break;
        }
        case "claude_login":
          setClaudeLogin(msg.login);
          props.onClaudeLogin?.(msg.login);
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
        // Someone else answered that dialog (another tab, or the Overseer): it is no longer ours to ask.
        case "ui_resolved":
          setDialogs((d) => d.filter((x) => x.id !== msg.id));
          break;
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
            // A send the server turned down for a reason it states (a baton session held by
            // someone else): the words as they are, the draft back in the box, the socket kept, no
            // turn failure. The composer's own blocked reason says the same once the list catches up.
            case "refused":
              if (msg.profileRunning) setProfileRace({ label: profileInfo()?.profile?.label ?? "This profile", running: msg.profileRunning });
              restoreUnsent();
              if (!live.entries.some((e) => e.kind === "assistant")) setLive("running", false);
              toast(msg.message);
              announce(msg.message);
              return;
            case "reloaded":
              // The Overseer's runtime can be replaced by a clear in another tab: its route may now
              // name a new file, and reconnecting here would reopen the old one.
              if (props.overseer) {
                socket.close();
                props.overseer.onReloaded();
                return;
              }
              // So can a project overseer's: open whichever conversation is current now.
              if (props.projectOverseer) {
                socket.close();
                props.projectOverseer.onReloaded();
                return;
              }
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
              // A refused switch of Claude login is its own banner, never a turn failure.
              if (msg.message.startsWith(LOGIN_UNCHANGED)) {
                setLoginError(msg.message.slice(LOGIN_UNCHANGED.length).trim());
                announce(msg.message);
                break;
              }
              // The front door may have moved this tab to a host that doesn't hold this session:
              // the reconnect's "not found" is no turn error then. Ask for the host check now and
              // keep "Reconnecting"; the view is replaced when the change is confirmed.
              if (mayBeHostMove(msg, everOpened(), !hostOf(props.path), meshOn())) {
                holdNotFound(msg.message);
                break;
              }
              turnFailed(msg.message, msg.provider);
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
  type RequestKind = "rewind" | "regenerate" | "queue_remove" | "compact";
  /** What a request settles as. `text` is a rewind's message, on its way to the composer;
      `tokensBefore` a compaction's count of what it summarized. */
  type ActionResult = { ok: true; text?: string; tokensBefore?: number } | { ok: false; reason: string; message: string };
  const requests = new Map<string, { kind: RequestKind; resolve: (result: ActionResult) => void }>();
  let requestSeq = 0;
  /** How many of each kind are waiting, reactively: a strip greys its own action while one is out,
      and the flyout's Undo row greys out while a rewind is. */
  const [pending, setPending] = createSignal<Record<RequestKind, number>>({ rewind: 0, regenerate: 0, queue_remove: 0, compact: 0 });
  const countPending = () => {
    const n: Record<RequestKind, number> = { rewind: 0, regenerate: 0, queue_remove: 0, compact: 0 };
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
  onCleanup(() => noteLinks(props.path, null));
  props.onRewindControl?.({ path: props.path, blocked: rewindBlocked, rewind });
  onCleanup(() => props.onRewindControl?.(null));
  /** The flyout's "Undo last turn": a rewind to just before the newest user message on the branch
      (never a link message: a partner's words are no rewind target). */
  const lastInput = () => {
    const list = items() ?? [];
    const o = older();
    // The hello's summary names the newest input above the list when the list holds none.
    if (o) return lastInputOf(list, o);
    for (let i = list.length - 1; i >= 0; i--) if (isInput(list[i]!)) return list[i]!.id;
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
      // Before this connection's hello nothing says where the last input is: can't run yet, and
      // nothing to say about it.
      return lastInput() ? null : older() ? "Nothing to undo yet." : "";
    },
    run: () => {
      const id = lastInput();
      // One rewind at a time: a second confirm before the reply would abandon two turns.
      if (id && rewindsPending() === 0) void rewind(id).then((r) => !r.ok && toast(r.message));
    },
  };

  // ---- Per-message actions ------------------------
  /**
   * The last refusal, kept on the message it was about. The announcement already said it once
   * (settleRequest); this is the record on the row, so a user who looked away still finds out why
   * nothing happened. One at a time: a second attempt anywhere replaces it.
   */
  const [actionNote, setActionNote] = createSignal<{ entryId: string; text: string } | null>(null);
  const noteOn = (entryId: string | undefined, text: string) => setActionNote(entryId && text ? { entryId, text } : null);
  /** Queued messages with a removal out, by id, so only that row greys. */
  const [removing, setRemoving] = createSignal<string[]>([]);

  const [forking, setForking] = createSignal(false);
  const forkFrom = async (entryId: string) => {
    if (forking()) return;
    setForking(true);
    setActionNote(null);
    try {
      const host = hostOf(props.path);
      const made = await forkSession(props.path, entryId);
      announce("Opened a fork. The original conversation is unchanged.");
      location.hash = sessionHrefOn(host, made.path);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Couldn't fork this reply.";
      noteOn(entryId, text);
      announce(text);
    } finally {
      setForking(false);
    }
  };

  /** What every strip in this chat is judged by. Reactive by construction: a turn starting, a
      compaction, a model switch or a reconnect re-enables the actions in place. */
  const actionState = (wake = false, link = false, topic = false): ActionState => ({
    chat: true,
    live: false, // a ChatView only exists for a session Sova may write to
    streaming: live.running,
    compacting: compacting(),
    // Rewind and Regenerate both move the branch on the same runtime, and the server has no
    // mutex between them: one in flight blocks the other, not just another of its own kind.
    pending: forking() || pending().rewind + pending().regenerate > 0,
    paused: blocked()?.text ?? null,
    wake,
    link,
    topic,
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

  /** The session's id, for Share. A memo: the summary is a new object on every list read, and every
      strip's items read this. */
  const shareId = createMemo(() => props.summary?.()?.id);
  /** What each delivered message offers here. Copy is ours alone; the rest are requests with a
      reason when they can't act, never a button that quietly does nothing. */
  const chatActions: MessageActionsProvider = {
    items(strip) {
      return actionsFor(strip.role, { copyable: copyable(strip) }).map((kind): MessageActionItem => {
        switch (kind) {
          case "copy":
            return { kind, reason: null, run: async () => void (await copyText(strip.text, COPIED)) };
          case "share": {
            const id = shareId();
            return { kind, reason: id ? null : SHARE_WAIT_REASON, run: () => void (id && (location.hash = shareHref(id, { host: hostOf(props.path), from: strip.entryId }))) };
          }
          case "fork":
            return { kind, reason: actionReason("fork", actionState()), run: () => forkFrom(strip.entryId) };
          case "rewind":
            return { kind, reason: actionReason("rewind", actionState()), run: () => rewindFrom(strip.entryId) };
          case "regenerate":
            return {
              kind,
              reason: actionReason("regenerate", actionState(!!strip.fromWake, !!strip.fromLink, !!strip.fromTopic)),
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
   * event. An eliminated member stays readable, which is
   * what makes elimination reversible.
   */
  const archivedPane = () => !!scope.id && !!props.summary?.()?.archived;

  /** Whether the operator holds this baton session's baton, from its strip; undefined until it has read. */
  const [batonMine, setBatonMine] = createSignal<boolean | undefined>(undefined);
  const batonGate = (): ComposerReason | null => {
    const g = batonComposerGate(props.summary?.()?.baton, batonMine());
    return g && { icon: g.ended ? "check" : "clock", text: g.text };
  };
  /** Whether the list is here at all, as its own boolean: `blocked` is read by every message's
      action strip, so reading the list itself there rebuilt every strip's buttons on each change
      of the list (an append, a turn-end reload, each chunk of a tail-first hello's history). */
  const listHere = createMemo(() => !!items());
  const blocked = (): ComposerReason | null => {
    if (archivedPane()) return { icon: "archive", text: "This session is archived. Unarchive it to send." };
    // A baton session (§app.baton/attribution): the operator writes only while holding the baton.
    const baton = batonGate();
    if (baton) return baton;
    switch (socket.status()) {
      case "connecting":
        return everOpened() ? { icon: "clock", text: "Reconnecting. Your draft is kept." } : { icon: "clock", text: "Connecting…" };
      case "reconnecting":
        return { icon: "clock", text: "Reconnecting. Your draft is kept." };
      case "failed":
      case "closed":
        return { icon: "clock", text: "Not connected." };
    }
    if (!listHere()) return { icon: "clock", text: "Connecting…" };
    if (syncing()) return { icon: "clock", text: "Saving this turn…" };
    if (pendingModel()) return { icon: "clock", text: "Switching model…" };
    // Any compaction: this chat's /compact (asked, or already running), pi's automatic one, or an
    // extension's. The server would hold a send meanwhile; saying so is better than a queue row.
    if (compacting() || pending().compact > 0) return { icon: "clock", text: COMPACTING_REASON };
    return null;
  };

  // ---- Taking recommendations from an alignment card (§chat.alignment/card) --------------
  /** The card takes ticks, option picks and its button only with align on, in a chat whose mode the user sets
      (not the Overseer's, a project overseer's or a baton session's). */
  const alignAnswerable = () =>
    !props.overseer && !props.projectOverseer && !props.summary?.()?.baton && !props.summary?.()?.projectOverseer && !!modeState()?.minorModes.includes("align");
  /** This session's picks that still apply: open questions of each alignment's newest revision. */
  const picks = createMemo(() => (alignAnswerable() ? prunePicks(picksOf(props.path), aligns()) : {}), {}, { equals: samePicks });
  /** Whether the composer holds typed text or an attachment: the card's button then waits. */
  const [hasDraft, setHasDraft] = createSignal(false);
  const alignAnswer: AlignAnswer = {
    on: alignAnswerable,
    current: (id) => aligns().find((e) => e.doc.id === id)?.doc,
    picked: (doc, q) => picks()[doc]?.some((p) => p.q === q && !p.option) ?? false,
    toggle: (doc, q, on) => choosePick(props.path, doc, q, on ? { q } : null),
    pickedOption: (doc, q) => {
      const p = picks()[doc]?.find((x) => x.q === q);
      if (!p) return undefined;
      if (p.option) return p.option.index;
      const question = alignAnswer.current(doc)?.questions.find((x) => x.id === q);
      return question ? recommendedOption(question) : undefined;
    },
    pick: (doc, q, index) => {
      const question = alignAnswer.current(doc)?.questions.find((x) => x.id === q);
      if (index === null || !question) choosePick(props.path, doc, q, null);
      else choosePick(props.path, doc, q, optionPick(question, index));
    },
    tickBlocked: () => (archivedPane() ? blocked()?.text ?? null : null),
    goBlocked: () => {
      const reason = blocked()?.text;
      if (reason) return reason;
      if (live.running) return "Wait for the turn to end.";
      return hasDraft() || pickCount(picks()) > 0 ? "Send or clear your draft first." : null;
    },
    goWithRecommendations: (doc) => {
      if (alignAnswer.goBlocked()) return;
      if (send(acceptAllMessage(doc), false, [])) {
        clearPicks(props.path, doc);
        focusComposer();
      }
    },
  };
  const composerPicks = createMemo(() => {
    const p = picks();
    return pickCount(p) === 0
      ? null
      : { label: picksLabel(p), compose: (text: string) => composeWithPicks(p, text), clear: () => clearPicks(props.path) };
  });

  if (props.overseer?.bindSender) {
    const unbind = props.overseer.bindSender({
      send: (text) => {
        if (blocked()) return false;
        const sent = send(text, false, []);
        if (sent) focusComposer();
        return sent;
      },
      blocked: () => blocked()?.text ?? null,
    });
    onCleanup(unbind);
  }

  // ---- Model switching ------------------------------------------------
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
      setModel(next);
    });
    props.onModel(next);
    if (was || next) {
      const sentence = `Model changed to ${idOf(next)}.`;
      toast(sentence);
      announce(sentence);
    }
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
  // ---- Thinking level --------------------------------------
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

  /** The composer flyout's model panel; the header no longer carries a model trigger. */
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
  /** The login label's panel (§app.claude-logins/switch-login): the server keeps the waiting pick. */
  let loginRead = 0;
  const loginControl: LoginControl = {
    login: claudeLogin,
    info: loginInfo,
    error: loginInfoError,
    refresh: () => {
      const seq = ++loginRead;
      setLoginInfoError(null);
      getChatClaudeAccounts(props.path)
        .then((info) => seq === loginRead && setLoginInfo(info))
        .catch((err) => seq === loginRead && setLoginInfoError(`Couldn't read this device's logins: ${err instanceof Error ? err.message : String(err)}`));
    },
    running: () => live.running,
    context: () => sessionContext()[props.path],
    choose: (id) => {
      if (socket.send({ type: "set_claude_login", login: id })) setLoginError(null);
    },
    cancel: () => {
      socket.send({ type: "set_claude_login", login: null });
    },
  };
  /** The composer foot's mode switch: this chat's WS "mode" state and its session file. */
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
  void ensureModelPolicy(hostOf(props.path)).catch(() => {});
  /** Why this chat can't send right now — its model is off — or null. */
  const offNow = (): string | null => {
    const ref = model();
    const policy = modelPolicy(hostOf(props.path));
    if (!ref || !policy || modelEnabled(policy, ref)) return null;
    return `${ref} is turned off in Settings → Models. Pick another model, then send this again.`;
  };

  // The same pane's turn-error state as data (the prop's doc, above): the workspace meta line
  // pairs a word with colour from this, and a pane
  // outside a workspace has nobody to tell — the prop is simply absent there.
  createEffect(() => props.onTurnError?.(turnError()));

  /** `confirm`: the Overseer's confirm card click (that card's tool call id); never set by typing. */
  const send = (text: string, steer: boolean, attachments: UploadResult[], confirm?: string) => {
    // A model turned off in Settings → Models is refused by the server on its way to the provider
    // (server/model-policy.ts). Saying so here keeps the message in the composer instead of
    // spending it on a refusal, and never picks another model for you.
    const offModel = offNow();
    if (offModel) {
      setErrors((e) => (e[e.length - 1]?.message === offModel ? e : [...e, { message: offModel }]));
      announce(offModel);
      return false;
    }
    // The id this message is known by from here on: the server echoes it in `send_ack`, lists it
    // in the queue snapshot, and takes it back by it. Minted per send, so two identical messages
    // are still two messages — which is what makes removing the middle one of three possible.
    // "/compact [instructions]" is Sova's builtin: a request with its own answer, not a message.
    const compact = compactCommand(text);
    if (compact) return sendCompact(text, compact.instructions, steer, attachments.length > 0);
    const clientId = newClientId();
    if (!socket.send(steer ? { type: "steer", text, clientId } : { type: "prompt", text, clientId, ...(confirm ? { confirm } : {}) })) return false;
    // A known slash command isn't a message to the model (templates and skills expand into other
    // text, extensions may never start the agent): no optimistic bubble or running state, just a
    // local "Ran" row, whether sent idle or as a steer mid-turn (pi runs it either way).
    // Unknown "/words" go through as ordinary messages.
    const command = /^\/(\S+)/.exec(text)?.[1];
    if (command && commands().some((c) => c.name === command)) {
      const label = text.length > 61 ? `${text.slice(0, 60)}…` : text;
      batch(() => {
        setCommandRows((rows) => [...rows, { label, tui: tuiOnlyCommand(text) !== null }]);
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

  /**
   * The web /compact (§chat.slash-commands/compact): a "Ran" row now, "Compacting context" in the
   * run status until pi's compaction_end, and Stop cancels it. A refusal turns the row into an
   * attention row that says why. Mid-turn, or with images, it is refused here without a round
   * trip — the server's reasons and copy — and the draft stays, since nothing was sent. A landed
   * one leaves the compaction row the server's hello already drew, so the local row goes.
   */
  const sendCompact = (text: string, instructions: string | undefined, streaming: boolean, images: boolean): boolean => {
    const label = text.length > 61 ? `${text.slice(0, 60)}…` : text;
    const localRefusal = images ? COMPACT_IMAGES_REFUSAL : streaming || live.running ? COMPACT_STREAMING_REASON : null;
    if (localRefusal) {
      setCommandRows((rows) => [...rows, { label, tui: false, note: localRefusal }]);
      announce(localRefusal);
      return false;
    }
    const row = { label, tui: false };
    batch(() => {
      setCommandRows((rows) => [...rows, row]);
      setResume((n) => n + 1);
    });
    void ask("compact", { type: "compact", ...(instructions ? { instructions } : {}) }).then((result) => {
      if (result.ok) {
        setCommandRows((rows) => rows.filter((r) => r !== row));
        announce(compactedAnnouncement(result.tokensBefore ?? 0));
      } else setCommandRows((rows) => rows.map((r) => (r === row ? { ...r, note: result.message } : r)));
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
      moves this session to the Archive region (an empty husk is deleted instead, and the toast
      says which). Then out of the dead session, on the app's own route to the landing page (the back link's). */
  const archive = async () => {
    if (archiving()) return;
    setArchiving(true);
    try {
      const res = await setSessionArchived(props.path, true);
      toast(archivedDropToast(!!res.deleted, orgProjectOf(props.summary?.() ?? {})).text);
      props.onArchiveChanged?.(props.path, true);
      if (!scope.id) location.hash = "#/";
    } catch (err) {
      toast(`Couldn't archive this session. ${(err as Error).message}`);
    } finally {
      setArchiving(false);
    }
  };

  /** A baton session's names, from its strip (§app/baton). */
  const [batonNames, setBatonNames] = createSignal<Record<string, string> | undefined>(undefined);
  return (
    <>
      <Show when={props.summary?.()?.baton}>
        <BatonStrip path={props.path} summary={() => props.summary?.()} onNames={setBatonNames} onOperatorHolds={setBatonMine} />
      </Show>
      <ToolSourceContext.Provider value={{ kind: "pi", path: props.path }}>
      <ThreadScroller
        path={props.path}
        restore={cached?.spot}
        onSpot={(spot) => cacheSpot(cacheKey, spot)}
        count={visibleCount(newRows(items() ?? [], newFrom()), { tools: hideTools(props.path), thinking: hideThinking(props.path) }) + live.entries.length}
        resume={resume()}
        busy={!items()}
        banner={
          <div class="stack-2">
            <Show when={!archivedPane()}>
              <ConnectionBanner socket={socket} />
            </Show>
            {/* Permanent until the world it names changes: the diagnosis and the gestures that
                fix it, derived in src/lib/open-failure.ts. The first action is the primary one. */}
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
            {/* A refused switch of Claude login (§app.claude-logins/switch-login). */}
            <Show when={loginError()}>
              {(why) => (
                <Banner
                  tone="error"
                  title="Couldn't switch the Claude login."
                  body={
                    <>
                      {why()}
                      <Show when={claudeLogin()}>{(l) => <> You're still on {l().email ?? l().name}.</>}</Show>
                    </>
                  }
                  action={
                    <button type="button" class="button button-sm button-ghost" onClick={() => setLoginError(null)}>
                      Dismiss
                    </button>
                  }
                />
              )}
            </Show>
            {/* A refused thinking change reads like a refused model switch. */}
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
            <OverseerThreadContext.Provider
              value={
                props.overseer || props.projectOverseer
                  ? {
                      answer: (text, card, sent) => {
                        const ok = send(text, false, [], card);
                        if (ok && card && sent) setCardSent({ ...cardSent(), [card]: sent });
                        return ok;
                      },
                      sent: (card) => cardSent()[card],
                      // Approvals are the global Overseer's alone; a project overseer's card carries none.
                      permits: () => (props.overseer ? autonomy()?.permits ?? [] : []),
                      card: (id) => cards().cards.get(id),
                    }
                  : null
              }
            >
            <CardJumpContext.Provider value={jumpToCardId}>
            <AlignAnswerContext.Provider value={alignAnswer}>
              <ChangesSession.Provider value={{ get path() { return props.path; }, get cwd() { return props.summary?.()?.cwd; } }}>
              <HistoryItems
                items={list()}
                author={props.author}
                names={batonNames()}
                streaming={live.running}
                hideTools={hideTools(props.path)}
                hideThinking={hideThinking(props.path)}
                limitPath={props.path}
                actions={chatActions}
                older={olderRows.api}
                liveAlignIds={liveAlignIds()}
                liveCardIds={liveCardIds()}
              />
              </ChangesSession.Provider>
              <LiveEntries
                live={live}
                author={props.author}
                names={batonNames()}
                hideTools={hideTools(props.path)}
                hideThinking={hideThinking(props.path)}
                limitPath={props.path}
                queueActions={queueActions}
              />
              <For each={commandRows()}>
                {(row) => (
                  <div class="info-row" role="note">
                    <span class="info-row-text">
                      <Icon name={row.tui || row.note ? "attention" : "terminal"} small />
                      <Switch
                        fallback={
                          <span>
                            Ran <code>{row.label}</code>
                          </span>
                        }
                      >
                        <Match when={row.note}>
                          {(note) => (
                            <span>
                              <code>{row.label}</code>: {note()}
                            </span>
                          )}
                        </Match>
                        <Match when={row.tui}>
                          <span>
                            <code>{row.label.split(/\s/)[0]}</code> needs the terminal UI. Run it in pi in a terminal.
                          </span>
                        </Match>
                      </Switch>
                    </span>
                  </div>
                )}
              </For>
              {/* Only while the thread has no rendered row. Settings-change rows (model, thinking,
                  mode) draw nothing, so they don't count; local rows such as "Ran /cmd" still do.
                  The Overseer's also while it holds only machine notes (its model and thinking
                  rows): nothing has been said yet. */}
              <Show
                when={
                  whole() &&
                  (props.overseer ? list().every((it) => it.kind === "info") : list().every((it) => isChangeRow(it) || isProfileRow(it))) &&
                  live.entries.length === 0 &&
                  commandRows().length === 0
                }
              >
                <Show
                  when={props.overseer}
                  fallback={
                    <div class="empty">
                      <p class="empty-title">
                        New session in <code>{props.cwdLabel}</code>.
                      </p>
                      <Show when={profileInfo()?.pickable && !profileInfo()?.locked && profileInfo()}>
                        {(info) => (
                          <ProfilePicker
                            path={props.path}
                            cwd={props.summary?.()?.cwd ?? null}
                            info={info()}
                            race={profileRace()}
                            blocked={blocked()?.text ?? offNow() ?? null}
                            onRunPlaybook={(pb) => {
                              // The message box is the playbook's text (§chat.profiles/playbook); a
                              // new session's first message, so never a steer.
                              if (!send(playbookTurnText(pb, drafts.get(props.path) ?? ""), false, [])) return false;
                              setTaken({ at: Date.now() });
                              return true;
                            }}
                            onFirstMessage={(text) => {
                              if (!drafts.get(props.path)?.trim()) setDraftText(props.path, text);
                            }}
                          />
                        )}
                      </Show>
                      <SessionSetupCard path={props.path} editable={!!profileInfo()?.pickable && !profileInfo()?.locked} />
                      <p class="empty-body">Your first message becomes its title.</p>
                    </div>
                  }
                >
                  {(o) => o().empty()}
                </Show>
              </Show>
            </AlignAnswerContext.Provider>
            </CardJumpContext.Provider>
            </OverseerThreadContext.Provider>
          )}
        </Show>
        {/* One failure, one row: a failure with its own errored turn row in the thread carries the
            limit switch there (with that row's provider); the error feed's mount is for failures
            that never made a thread row (a refusal before any turn, a host move). */}
        <For each={errors()}>{(m) => <><TurnError message={m.message} /><Show when={!failureHasRow(live.entries, m.message)}><SubagentLimitRow path={props.path} message={m.message} provider={m.provider} /></Show></>}</For>
      </ThreadScroller>
      </ToolSourceContext.Provider>
      <FlyoutSession.Provider value={() => props.path}>
      <Composer
        path={props.path}
        cwd={props.summary?.()?.cwd ?? null}
        blocked={blocked()}
        readOnly={batonGate()}
        commands={props.overseer ? commands().filter((c) => c.name !== "mode") : commands()}
        running={live.running}
        compacting={compacting()}
        stopping={live.stopping}
        activity={live.activity ?? waitWords()}
        detail={runDetail(live)}
        workersWorking={workersWorking()}
        workersTotal={workersTotal()}
        workersSplit={workersSplit()}
        onShowWorkers={props.onShowWorkers}
        workersOpen={props.workersOpen}
        inputsOpen={props.inputsOpen}
        paneTab={props.paneTab}
        onNewSession={props.overseer ? undefined : props.onNewSession}
        onClear={props.overseer?.onClear ?? props.projectOverseer?.onClear}
        onMode={
          props.overseer
            ? () => {
                toast(OVERSEER_MODE_FIXED);
                announce(OVERSEER_MODE_FIXED);
              }
            : undefined
        }
        accessory={
          props.overseer
            ? () => (
                <QuickActions
                  actions={props.overseer!.quickActions()}
                  disabled={blocked()?.text ?? null}
                  onPick={(prompt) => {
                    if (send(prompt, false, [])) focusComposer();
                  }}
                />
              )
            : undefined
        }
        onShowTimeline={props.onShowTimeline}
        inputCount={inputCount() ?? 0}
        inputsPending={inputsPending(inputCount(), items(), !!props.summary?.() && knownInputs(props.summary()!))}
        aligns={aligns()}
        onJumpAlign={jumpToAlign}
        cards={openCards(cards())}
        onJumpCard={jumpToCard}
        autonomy={props.overseer ? autonomy() : undefined}
        onRevokePermit={props.overseer ? revokePermit : undefined}
        onApproveSchedule={props.overseer ? approveScheduleFromPanel : undefined}
        onRevokeSchedule={props.overseer ? revokeScheduleFromPanel : undefined}
        onJumpCardId={jumpToCardId}
        onJumpToolCall={jumpToToolCall}
        autofocus={props.autofocus}
        model={modelControl}
        claudeLogin={claudeLogin}
        login={loginControl}
        thinking={thinkingControl}
        mode={props.overseer || props.summary?.()?.baton || props.summary?.()?.projectOverseer ? null : modeControl}
        sandbox={sandboxControl}
        onPlaybooks={() => setShowPlaybooks(true)}
        undo={undoControl}
        onSend={send}
        picks={composerPicks()}
        onDraft={setHasDraft}
        onAbort={abort}
        restored={restored()}
        taken={taken()}
      />
      </FlyoutSession.Provider>
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
            // After a send the next thing is the conversation; otherwise back
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
