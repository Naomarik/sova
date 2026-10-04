import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { releaseControl } from "../lib/release-control";
import type { ChatClaudeLogin, ScheduleInfo, SlashCommand, UploadResult } from "../../shared/protocol";
import { composerLogin } from "../lib/claude-login";
import { runControls } from "../lib/compact";
import { createTouchMode, enterSends } from "../lib/input-mode";
import { enterRunsLocal, insertCommand, localCommand, menuCommands, rankCommands, slashMenuSuppressed, slashTokenAt, type SlashToken } from "../lib/slash";
import { commandOptionIds, SlashMenu } from "./SlashMenu";
import {
  cachedFileIndex,
  capMentionEntries,
  ensureFileIndex,
  heldFileIndex,
  insertMention,
  mentionEntries,
  mentionIndexStatus,
  mentionQueryParts,
  mentionTokenAt,
  shouldFetchIndex,
  type MentionIndexError,
  type MentionToken,
} from "../lib/files";
import { FileMenu, mentionOptionIds, type FileMenuStatus } from "./FileMenu";
import { deleteAttachment } from "../lib/api";
import {
  ACCEPTED_TYPES,
  acceptFiles,
  dragHasAcceptedImage,
  pendingFrom,
  uploadAccepted,
  withImagePaths,
  type PendingImage,
  type RejectedFile,
} from "../lib/images";
import { modelProvider, shortModel } from "../lib/format";
import { fitPlaceholderNow, type FittedPlaceholder } from "../lib/placeholder-fit";
import { ensureModels, modelList, thinkingLevelsFor } from "../lib/models";
import {
  clearDraft,
  draftAttachments,
  drafts,
  flushDrafts,
  loadDraft,
  openLightbox,
  setDraftAttachments,
  setDraftText,
} from "../lib/ui-state";
import { paneScopedId, usePaneAnnounce, usePaneScope } from "../lib/pane-scope";
import { inputsText } from "../lib/input-count";
import { isOpenDoc, type AlignEntry } from "../lib/align";
import { AlignChip } from "./AlignChip";
import { OverseerCardChip } from "./OverseerCardChip";
import { OverseerPermitsChip } from "./OverseerPermitsChip";
import { livePermits, type Permit } from "../../shared/overseer-grants";
import type { OverseerCard } from "../../shared/overseer-card";
import { openSettings } from "../lib/settings-nav";
import { showInputsOnTimelineLabel } from "../lib/timeline";
import { showWorkersOfLabel, teamNote, type WorkingSplit, workersOfLabel, workersRunningLabel } from "../lib/workers";
import { ComposerMenu, type ComposerMenuApi, type LoginControl, type SandboxControl, type ThinkingControl, type UndoControl } from "./ComposerMenu";
import { sandboxBadge } from "../lib/sandbox";
import type { ModelControl } from "./ModelMenu";
import { ModeMenu, type ModeControl } from "./ModeMenu";
import { Icon, type IconName } from "./ui";
import type { RunDetail, RunStep } from "../lib/live";
import { hostOf } from "../lib/mesh";
import { createVoiceInput, VoiceButton, VoiceStrip } from "./VoiceInput";

/** The session pane's element id: ONE pane, five tabs, so every trigger controls the same id. */
const PANE_ID = "session-pane";

/** The run-status row's icon for what the turn is doing (§chat.transcript/streaming). */
const STEP_ICON: Record<RunStep, IconName> = { thinking: "bulb", writing: "pencil", tool: "wrench" };

const RING_R = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

/** The subagents trigger's meter: the working share of every worker, filled clockwise from 12
    o'clock, empty once all have settled. Static — the row's one live dot is what moves — and
    `aria-hidden`: the trigger's words say the same. */
function WorkersRing(props: { working: number; total: number }) {
  const fraction = () => (props.total > 0 ? Math.min(1, props.working / props.total) : 0);
  return (
    <svg class="workers-ring" viewBox="0 0 14 14" aria-hidden="true">
      <circle class="workers-ring-track" cx="7" cy="7" r={RING_R} fill="none" />
      <circle
        class="workers-ring-fill"
        cx="7"
        cy="7"
        r={RING_R}
        fill="none"
        transform="rotate(-90 7 7)"
        style={{ "stroke-dasharray": `${RING_CIRCUMFERENCE}`, "stroke-dashoffset": `${RING_CIRCUMFERENCE * (1 - fraction())}` }}
      />
    </svg>
  );
}

export interface ComposerReason {
  icon: IconName;
  text: string;
}

/** `KB` under 1 MB, rounded; otherwise one decimal. */
const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Prompt input. Enter sends, Shift+Enter adds a newline. While `running`,
 * Send becomes Steer and a small Stop appears after it. `readOnly` disables the textarea and hides Send;
 * `blocked` keeps typing allowed but makes Send and Attach aria-disabled, with the reason read
 * out. Images attach by picker, paste, or drop. Text and images are a per-session draft that
 * survives every state change.
 */
export function Composer(props: {
  path: string;
  readOnly?: ComposerReason | null;
  blocked?: ComposerReason | null;
  running: boolean;
  /** A compaction runs (§chat.slash-commands/compact): Stop and the status row, but no Steer. */
  compacting?: boolean;
  stopping: boolean;
  /** What the turn is doing: the row shows its icon, the words go to the tooltip and the name. */
  detail: RunDetail | null;
  /** A rare state that keeps its words on the row: "Compacting context", "Retrying after a provider error". */
  activity?: string | null;
  /** Subagents working now; after the turn settles they get their own status row. */
  workersWorking?: number;
  /** Every subagent this session has, working or settled, so the row survives going idle. */
  workersTotal?: number;
  /** How that count divides into team members and plain subagents; null: it can't be split. */
  workersSplit?: WorkingSplit | null;
  /** Makes the subagents status row a button that toggles the subagents pane. */
  onShowWorkers?: () => void;
  /** The pane is open for this session on the AGENTS tab: the subagents trigger's aria-expanded.
      A pane open on another tab is not this control's disclosure, so it is not "expanded". */
  workersOpen?: boolean;
  /** The pane is open for this session on the TIMELINE tab with Inputs Only on: the inputs
      trigger's aria-expanded, and its only authority — a tab name can't say whether the filter is on. */
  inputsOpen?: boolean;
  /** The pane's active tab while it is open for THIS session ("session" | "timeline" | "agents" |
      "skills" | "explain"), else null. The authority for the subagents trigger's aria-expanded;
      `workersOpen` answers only until App passes it. */
  paneTab?: string | null;
  /** Runs a bare "/new": resolves to the new session's folder label, or null if none was made. */
  onNewSession?: () => Promise<string | null>;
  /** The Overseer's "/clear": a new conversation. Given, a bare "/clear" is ours and never reaches
      the runtime; absent (every other chat), it is the runtime's as before. Resolves false when
      nothing was cleared, and the draft stays. */
  onClear?: () => Promise<boolean>;
  /** The Overseer's "/mode": given, any "/mode" (arguments too) is ours and never reaches the
      runtime, which is always in normal mode; this says so. Absent, it is the runtime's as before. */
  onMode?: () => void;
  /** At the right end of the foot, in the mode switch's slot (the Overseer's quick actions). */
  accessory?: () => JSX.Element;
  /** Opens the session pane's Timeline tab: a bare "/timeline" unfiltered; a bare "/tree" and
      the run-status row's "N inputs" trigger with `inputsOnly`, on your own messages. */
  onShowTimeline?: (inputsOnly?: boolean) => void;
  /** The branch's alignments (§chat.alignment/chip): with one open, the run-status row carries
      the alignment chip right before the Inputs trigger. */
  aligns?: AlignEntry[];
  /** Jump to an alignment's newest card. */
  onJumpAlign?: (entry: AlignEntry) => void;
  /** The Overseer's open cards (§app.overseer/confirm): with one open, the run-status row carries
      the card chip, before the alignment chip. */
  cards?: OverseerCard[];
  /** Jump to a card. */
  onJumpCard?: (card: OverseerCard) => void;
  /** The Overseer's approvals and rules and its running count (§app.overseer/approvals,
      §app.overseer/caps): the run-status row carries "3 of 10 running" while any runs, and the
      approvals chip while any is live. */
  autonomy?: { running: number; cap: number; permits: Permit[]; schedules?: ScheduleInfo[] };
  onRevokePermit?: (id: string) => Promise<string | null>;
  /** Approve or revoke a playbook schedule from the same panel (§chat.schedules/where-shown). */
  onApproveSchedule?: (s: ScheduleInfo) => Promise<string | null>;
  onRevokeSchedule?: (id: string) => Promise<string | null>;
  onJumpCardId?: (card: string) => void;
  onJumpToolCall?: (toolCallId: string) => void;
  /** User messages on this chat's active branch; the status row's inputs trigger, hidden at 0. */
  inputCount?: number;
  /** The branch has inputs whose count isn't known yet (lib/known-before-mount): the inputs
      trigger's box is held, empty, until `inputCount` says. */
  inputsPending?: boolean;
  autofocus?: boolean;
  /** This session's slash commands; the "/" autocomplete is off without them. */
  commands?: SlashCommand[];
  /** This chat's working directory — the @ file menu's root. Null (watch-only composers, a
      session whose summary hasn't landed) keeps the @ menu off. */
  cwd?: string | null;
  /** Chat sessions only: the flyout's model picker. */
  model?: ModelControl | null;
  /** Chat sessions only: the chat's Claude login (WS "claude_login"), shown beside the model. */
  claudeLogin?: () => ChatClaudeLogin | null;
  /** Chat sessions only: the login panel the login label opens (§app.claude-logins/switch-login). */
  login?: LoginControl | null;
  /** Chat sessions only: the flyout's Thinking ladder. */
  thinking?: ThinkingControl | null;
  /** Chat sessions only: this chat's mode switch, at the right end of the foot. */
  mode?: ModeControl | null;
  /** Chat sessions only: opens the Playbooks dialog (the flyout's Playbooks row). */
  onPlaybooks?: () => void;
  /** Chat sessions only: the flyout's "Undo last turn" row. */
  undo?: UndoControl | null;
  /** Chat sessions with the sandbox extension: the flyout's Sandbox row and the foot's shield. */
  sandbox?: SandboxControl | null;
  /** `text` already names each attachment's path; `attachments` are for the optimistic row. */
  onSend(text: string, steer: boolean, attachments: UploadResult[]): boolean;
  onAbort(): void;
  /** Queued text a Stop handed back; each new object goes ahead of the draft (TUI Esc order). */
  restored?: { text: string } | null;
  /** Each new object: the draft's text was sent by something else (Run Playbook, §chat.profiles/playbook), so it empties. */
  taken?: { at: number } | null;
  /** Answers picked on an alignment card (§chat.alignment/card), staged for the next send:
      the row names them, and `compose` puts their line ahead of the typed text in one message. */
  picks?: { label: string; compose(text: string): string; clear(): void } | null;
  /** Whether the draft holds anything to send (text or an attachment), as it changes. */
  onDraft?(has: boolean): void;
}) {
  const [text, setText] = createSignal(drafts.get(props.path) ?? "");
  const localOpts = () => ({ clear: !!props.onClear, mode: !!props.onMode });
  /** One row object per stored file, so the strip keeps its rows (and focus) as the list changes. */
  const rows = new Map<string, PendingImage>();
  const images = createMemo(() =>
    draftAttachments(props.path).map((a) => {
      const row = rows.get(a.path) ?? pendingFrom(a);
      rows.set(a.path, row);
      return row;
    }),
  );
  const [rejected, setRejected] = createSignal<RejectedFile[]>([]);
  const [drop, setDrop] = createSignal<"active" | "reject" | null>(null);
  /** Attach-time uploads still out. Send waits for them: a prompt must name every file it shows. */
  const [uploading, setUploading] = createSignal(0);
  // Slash-command autocomplete: the "/token" at the caret, the active row, and a token the
  // user dismissed with Esc (it stays closed until the caret leaves that token).
  const [slashToken, setSlashToken] = createSignal<SlashToken | null>(null);
  const [slashActive, setSlashActive] = createSignal(0);
  const [slashDismissed, setSlashDismissed] = createSignal<string | null>(null);
  /** Identity of a token's text: Esc keeps it closed until this changes. */
  const tokenKey = (t: SlashToken) => `${t.start}:${t.query}`;
  // @-mention autocomplete: the slash menu's twin, one level of the session cwd at a time.
  const [mentionToken, setMentionToken] = createSignal<MentionToken | null>(null);
  const [mentionActive, setMentionActive] = createSignal(0);
  const [mentionDismissed, setMentionDismissed] = createSignal<string | null>(null);
  /** Why the last index fetch failed, and for which cwd; kept until the menu next opens. */
  const [mentionError, setMentionError] = createSignal<MentionIndexError | null>(null);
  /** Bumped when an index fetch settles, so the derivation memos re-read the index cache. */
  const [indexTick, setIndexTick] = createSignal(0);
  const mentionKey = (t: MentionToken) => `${t.start}:${t.query}`;
  let input!: HTMLTextAreaElement;
  let picker: HTMLInputElement | undefined;
  let list: HTMLUListElement | undefined;
  let indicator: HTMLButtonElement | undefined;
  /** The flyout's handle, so the model indicator opens the same one popover. */
  const [menu, setMenu] = createSignal<ComposerMenuApi | null>(null);

  // The pane this composer belongs to: its id scopes every DOM id below (a workspace has N
  // composers on screen), and its label prefixes what this composer says out loud.
  const scope = usePaneScope();
  const paneId = (base: string) => paneScopedId(scope, base);
  const announce = usePaneAnnounce();
  /** Dictation into this box (§chat/voice): the mic in the row, its strip above it. */
  const voice = createVoiceInput({
    input: () => input,
    hint: () => props.cwd?.split("/").filter(Boolean).pop() ?? null,
    announce,
  });

  /** Any local write (typing, send's clear, a restore) makes this tab's text the authority, so a
      stored draft still on its way from the server must not replace it. */
  let touched = false;
  const setDraft = (v: string) => {
    touched = true;
    setText(v);
    setDraftText(props.path, v);
  };
  // Nothing in memory (a reload, or another device wrote it): seed from the stored draft. The
  // attachments seed themselves through the store, which only takes them if this tab has none.
  void loadDraft(props.path).then((stored) => {
    if (stored.text && !touched && !text()) setText(stored.text);
  });
  let disposed = false;
  /** Listeners Solid can't delegate (paste), added by hand so closing can take them off. */
  const listening = new AbortController();
  onCleanup(() => {
    disposed = true;
    flushDrafts();
    // A delegated event can keep this textarea alive after the view closes (lib/release-control):
    // make it a dead end, so what is kept is the textarea, not the closed session's transcript.
    listening.abort();
    releaseControl(input);
  });

  const reason = () => props.readOnly ?? props.blocked ?? null;
  const controls = () => runControls(props.running, !!props.compacting);
  /** TUI-live, connecting, reconnecting: nothing attaches and nothing sends. */
  const disabled = () => !!reason();
  /** What the foot says: the state's reason, else that an attachment is still uploading. */
  const shownReason = (): ComposerReason | null => reason() ?? (uploading() > 0 ? { icon: "clock", text: "Uploading…" } : null);
  // Tapped, Enter adds a line and Send sends; the placeholder's key hint shows exactly when
  // Enter sends, so it swaps in place when the mode does.
  const { touch, onPointerDown } = createTouchMode();
  /** The placeholder in reading order: the sentence, then the key hint a narrow box can spare. */
  const placeholderParts = () =>
    [props.running ? "Steer the current turn…" : "", !touch() && !props.readOnly ? "Enter sends" : ""]
      .filter(Boolean);
  /** The fitted placeholder, or null until this box has been measured. */
  const [fitted, setFitted] = createSignal<FittedPlaceholder | null>(null);
  /** What the box shows: the whole string while it fits, else the fitted one (§chat.composer/behavior). */
  const placeholder = () => fitted()?.text ?? placeholderParts().join(" ");
  /** Measure the strings against this box. The strings changing and the box changing are the two
      reasons to re-fit; a font arriving changes every width without changing either. */
  const fit = () => setFitted(fitPlaceholderNow(input, placeholderParts()));
  createEffect(() => {
    placeholderParts();
    fit();
  });
  onMount(() => {
    const observer = new ResizeObserver(() => fit());
    observer.observe(input);
    void document.fonts.ready.then(() => fit());
    onCleanup(() => observer.disconnect());
  });
  const canSend = () => !disabled() && uploading() === 0 && (text().trim().length > 0 || images().length > 0 || !!props.picks);
  createEffect(() => props.onDraft?.(text().trim().length > 0 || images().length > 0));

  // ---- Model indicator: this session's model and thinking level, and
  // the second trigger for the flyout that changes them. -----------------------------------
  /** What the session runs, or the target it's switching to — the flyout's Model row, shortened. */
  const modelRef = () => props.model?.pending() ?? props.model?.model() ?? null;
  /** The level to show, or null when this model's ladder isn't a choice. */
  const levelShown = () => {
    const thinking = props.thinking;
    if (!thinking || thinkingLevelsFor(props.model?.model(), hostOf(props.path)).length <= 1) return null;
    return thinking.pending() ?? thinking.level();
  };
  // The thinking ladder decides whether the level is worth showing, and it only arrives with the
  // model catalog — load it as soon as a session has a thinking control, not when the flyout opens.
  createEffect(() => {
    if (props.thinking && props.model?.model() && !modelList(hostOf(props.path))) void ensureModels(hostOf(props.path)).catch(() => {});
  });
  /** Open by the indicator, closed by it again: one control, one state. */
  const indicatorOpen = () => !!menu()?.open() && menu()?.anchor() === indicator;
  /** A popover's light dismiss beats our click to it, so a pointer toggle reads the state it
      had at press time; a keyboard activation (`detail` 0) never saw that dismiss. */
  let openAtPress = false;
  const toggleIndicator = (fromPointer: boolean) => {
    if (disabled() || !indicator) return;
    if (fromPointer ? openAtPress : indicatorOpen()) menu()?.close();
    else menu()?.show("model", indicator); // the panel this indicator is the label for
  };
  // ---- Claude login label: the third trigger, for the login panel (§app.claude-logins/switch-login).
  let loginLabel: HTMLButtonElement | undefined;
  const loginShown = () => composerLogin(props.claudeLogin?.() ?? null, modelRef(), !!props.running);
  const loginOpen = () => !!loginLabel && !!menu()?.open() && menu()?.anchor() === loginLabel;
  let loginOpenAtPress = false;
  const toggleLogin = (fromPointer: boolean) => {
    if (disabled() || !loginLabel || !props.login) return;
    if (fromPointer ? loginOpenAtPress : loginOpen()) menu()?.close();
    else menu()?.show("login", loginLabel);
  };
  // ---- Sandbox shield: the fourth trigger, for the sandbox panel (§chat.composer/sandbox-shield).
  let shield: HTMLButtonElement | undefined;
  const shieldOpen = () => !!shield && !!menu()?.open() && menu()?.anchor() === shield;
  let shieldOpenAtPress = false;
  const toggleShield = (fromPointer: boolean) => {
    if (disabled() || !shield || !props.sandbox) return;
    if (fromPointer ? shieldOpenAtPress : shieldOpen()) menu()?.close();
    else menu()?.show("sandbox", shield);
  };

  /** The subagents status row: what's working, or — once idle — what the session
      has, so the pane stays one click away after every worker settles. Its ring draws the
      working share of every worker the session has; a settled-workers row is only worth
      offering once the parent is idle. */
  const workersRow = () => {
    const working = props.workersWorking ?? 0;
    // The list's total can lag the socket's working count: never draw more working than there are.
    const total = Math.max(props.workersTotal ?? 0, working);
    if (working > 0)
      return {
        working,
        total,
        n: `${working}/${total}`,
        text: workersOfLabel(working, total, props.workersSplit),
        label: showWorkersOfLabel(working, total, props.workersSplit),
      };
    if (props.running) return null;
    if (total === 0 || !props.onShowWorkers) return null; // settled workers are only worth a row you can open
    const text = `${total} ${total === 1 ? "subagent" : "subagents"}`;
    return { working: 0, total, n: `${total}`, text, label: `${text} — show subagents` };
  };
  /** The subagents trigger shows a count; its tooltip is the words, plus the split of a mix of
      subagents and team members, and the team when there is one. */
  const workersTitle = (words: string) => {
    const split = props.workersSplit;
    const mix = split && split.members > 0 && split.subagents > 0 ? workersRunningLabel(props.workersWorking ?? 0, split) : undefined;
    return [words, mix, teamNote(split)].filter(Boolean).join("\n");
  };
  /** The session has work in flight: its own run status, or a subagent working. The row's one dot. */
  const inFlight = () => controls().status || (props.workersWorking ?? 0) > 0;

  /** The run-status words: the tooltip and accessible name of the icon, or, for Stopping and the
      rare states, the row's own text. */
  const stateWords = () =>
    props.stopping ? "Stopping…" : props.activity ?? (props.detail ? `Working · ${props.detail.text}` : "Working");

  /** A status-row trigger is expanded only when the pane shows ITS tab — the pane open on any
      other tab is not this control's disclosure. `paneTab` answers when App knows the tab; null
      means "no tab stored yet", where the pane falls back to Agents-if-working-else-Session, so
      the per-trigger boolean (which App derives from the same rule) answers instead. */
  const tabExpanded = (open: boolean | undefined, tab: string) =>
    props.paneTab == null ? !!open : props.paneTab === tab;

  /** The status row's inputs trigger: the branch's user messages, one click
      from the pane's Timeline with Inputs Only on. It survives an idle session with no workers —
      the row shows for it alone — and disappears at 0, where the empty state already speaks. */
  const inputsRow = () => {
    const n = props.inputCount ?? 0;
    return n > 0 && props.onShowTimeline ? { n, text: inputsText(n), label: showInputsOnTimelineLabel(n) } : null;
  };

  /** The inputs trigger is coming: its count arrives with the hello, and until then its box holds
      the row at its height, so the transcript above doesn't move when it lands. */
  const inputsHeld = () => !inputsRow() && !!props.inputsPending && !!props.onShowTimeline;

  /** The alignment chip, while an alignment is open (and there is somewhere to jump). */
  const runningRow = () => (props.autonomy && props.autonomy.running > 0 ? props.autonomy : null);
  // The chip shows while an approval or rule is live, or while Sova knows of a schedule.
  const permitsRow = () =>
    props.autonomy && props.onRevokePermit && (livePermits(props.autonomy.permits).length || props.autonomy.schedules?.length)
      ? { permits: props.autonomy.permits, schedules: props.autonomy.schedules ?? [] }
      : null;
  const alignRow = () => (props.onJumpAlign && (props.aligns ?? []).some((e) => isOpenDoc(e.doc)) ? props.aligns! : null);

  // ---- Slash-command autocomplete (combobox: focus stays in the textarea) ----------------
  const slashMatches = createMemo(() => {
    const token = slashToken();
    return token ? rankCommands(menuCommands(props.commands ?? []), token.query) : [];
  });
  const slashIds = createMemo(() => commandOptionIds(slashMatches(), scope.id));
  /** Never while disabled, nor on a bare local command. Streaming is fine: pi runs a
      "/command" steer as a command. */
  const slashOpen = () => {
    const token = slashToken();
    return (
      !!token &&
      !disabled() &&
      (props.commands?.length ?? 0) > 0 &&
      slashDismissed() !== tokenKey(token) &&
      !slashMenuSuppressed(text(), localOpts())
    );
  };
  /** Re-reads the token under the caret; call after input, clicks, and caret keys. */
  const updateSlash = () => {
    const token = slashTokenAt(input.value, input.selectionStart ?? 0);
    const prev = slashToken();
    if (token?.start !== prev?.start || token?.query !== prev?.query) setSlashActive(0);
    if (!token || tokenKey(token) !== slashDismissed()) setSlashDismissed(null);
    setSlashToken(token);
  };
  const moveSlash = (delta: number) => {
    const n = slashMatches().length;
    if (n) setSlashActive((i) => (i + delta + n) % n);
  };
  const pickSlash = (index: number) => {
    const token = slashToken();
    const cmd = slashMatches()[index];
    if (!token || !cmd) return;
    const next = insertCommand(input.value, token, cmd.name);
    buttonSlash = null; // that "/" is now part of a command
    setDraft(next.text);
    input.value = next.text;
    input.setSelectionRange(next.caret, next.caret);
    input.focus();
    updateSlash(); // the caret now sits after "/name ", outside any token
  };

  // ---- @-mention autocomplete (combobox: focus stays in the textarea) -------------------
  /** The host whose folder `props.cwd` is: a peer's session lists that peer's files. */
  const indexHost = () => hostOf(props.path);
  // What the menu lists is the HELD index, however old: aging out only re-arms the next opening's
  // fetch (the effect below), so a token open past the TTL keeps its rows.
  /** Every match — the true count, for the head and the announcement. */
  const mentionAll = createMemo(() => {
    indexTick(); // a fetch settling bumps this, so the derivation re-runs
    const token = mentionToken();
    const idx = props.cwd ? heldFileIndex(props.cwd, indexHost()) : null;
    return token && idx ? mentionEntries(idx.files, token.query) : [];
  });
  /** The rows drawn (capped); arrow keys, Enter and the ids index into these. */
  const mentionCapped = createMemo(() => capMentionEntries(mentionAll()));
  const mentionMatches = () => mentionCapped().shown;
  const mentionIds = createMemo(() => mentionOptionIds(mentionMatches()));
  const mentionTruncated = createMemo(() => {
    indexTick();
    return props.cwd ? heldFileIndex(props.cwd, indexHost())?.truncated : undefined;
  });
  const mentionStatus = createMemo<FileMenuStatus>(() => {
    indexTick();
    const cwd = props.cwd;
    return mentionIndexStatus({ cwd, cached: !!(cwd && heldFileIndex(cwd, indexHost())), error: mentionError() });
  });
  /** Never while disabled. Streaming is fine: a completed path is ordinary prompt text. */
  const mentionOpen = () => {
    const token = mentionToken();
    return !!token && !disabled() && !!props.cwd && mentionDismissed() !== mentionKey(token);
  };
  /** Re-reads the token under the caret; call after input, clicks, and caret keys. */
  const updateMention = () => {
    const token = mentionTokenAt(input.value, input.selectionStart ?? 0);
    const prev = mentionToken();
    if (token?.start !== prev?.start || token?.query !== prev?.query) setMentionActive(0);
    if (!token || mentionKey(token) !== mentionDismissed()) setMentionDismissed(null);
    setMentionToken(token);
  };
  const pickMention = (index: number) => {
    const token = mentionToken();
    const entry = mentionMatches()[index];
    if (!token || !entry) return;
    const next = insertMention(input.value, token, entry);
    setDraft(next.text);
    input.value = next.text;
    input.setSelectionRange(next.caret, next.caret);
    input.focus();
    updateMention(); // after a directory pick the caret sits right after "/", still in the token
  };
  /** The cwd the open menu has already tried to read: one attempt per opening, per folder. */
  let mentionFetchedFor: string | null = null;
  createEffect(() => {
    const token = mentionToken();
    const cwd = props.cwd ?? null;
    if (!token) {
      mentionFetchedFor = null; // closed: the next opening tries again
      return;
    }
    if (!shouldFetchIndex({ cwd, cached: !!(cwd && cachedFileIndex(cwd, Date.now(), indexHost())), fetchedFor: mentionFetchedFor })) return;
    mentionFetchedFor = cwd;
    setMentionError(null);
    void ensureFileIndex(cwd!, indexHost()).then(
      () => setIndexTick((t) => t + 1),
      (err) => {
        if (disposed) return;
        setMentionError({ cwd: cwd!, message: err instanceof Error ? err.message : String(err) });
        setIndexTick((t) => t + 1);
      },
    );
  });
  // The session's folder changed under an open menu: its list, its error and its active row all
  // described the folder we left. Drop them; the effect above refetches for the folder we're in.
  //
  // The comparison is ours on purpose. `props.cwd` is read off a summary object the session poll
  // REPLACES every few seconds, so the effect re-runs constantly with the same string — and `on`
  // would not save us: it re-runs whenever its tracked source changes, equal value or not (the
  // equality option belongs to createMemo's OUTPUT, which this isn't). Measured before the guard:
  // two polls moved the active row off the entry the user had arrowed to.
  let lastCwd = props.cwd ?? null;
  createEffect(() => {
    const cwd = props.cwd ?? null;
    if (cwd === lastCwd) return;
    lastCwd = cwd;
    setMentionActive(0);
    setMentionError(null);
  });

  /** The open menu's listbox id and active row id, whichever menu that is (only one can be open). */
  const listboxControls = () =>
    slashOpen()
      ? slashMatches().length > 0
        ? paneId("command-listbox")
        : null
      : mentionOpen()
        ? mentionMatches().length > 0
          ? "file-listbox"
          : null
        : null;
  const listboxActive = () =>
    slashOpen()
      ? slashMatches().length > 0
        ? (slashIds()[slashActive()] ?? null)
        : null
      : mentionOpen()
        ? mentionMatches().length > 0
          ? (mentionIds()[mentionActive()] ?? null)
          : null
        : null;

  // ---- Commands button: opens the same menu by inserting "/" at the caret ----------------
  /** The "/" (and the space before it) the button inserted; removed if closed untouched. */
  let buttonSlash: { at: number; space: boolean } | null = null;
  const dropButtonSlash = () => {
    const ins = buttonSlash;
    buttonSlash = null;
    if (!ins) return;
    const v = input.value;
    const token = slashTokenAt(v, ins.at + 1);
    if (v[ins.at] !== "/" || token?.start !== ins.at || token.query !== "") return; // user typed on
    const from = ins.space ? ins.at - 1 : ins.at;
    const next = v.slice(0, from) + v.slice(ins.at + 1);
    setDraft(next);
    input.value = next;
    input.setSelectionRange(from, from);
  };
  const toggleCommands = () => {
    if (disabled() || !(props.commands?.length ?? 0)) return;
    if (slashOpen()) {
      const token = slashToken();
      setSlashDismissed(token ? tokenKey(token) : null);
      dropButtonSlash();
      input.focus();
      updateSlash();
      return;
    }
    const v = input.value;
    const caret = document.activeElement === input ? input.selectionStart ?? v.length : v.length;
    const inToken = slashTokenAt(v, caret);
    if (inToken) {
      // Already in a (dismissed) token: just reopen it.
      setSlashDismissed(null);
      input.focus();
      input.setSelectionRange(caret, caret);
      updateSlash();
      return;
    }
    const space = caret > 0 && !/\s/.test(v[caret - 1]!);
    const insert = `${space ? " " : ""}/`;
    const next = v.slice(0, caret) + insert + v.slice(caret);
    setDraft(next);
    input.value = next;
    const at = caret + insert.length - 1;
    buttonSlash = { at, space };
    input.focus();
    input.setSelectionRange(at + 1, at + 1);
    updateSlash();
  };
  // Announce the count on open and when it changes, at most once a second (latest wins).
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  let lastAnnounced = 0;
  onCleanup(() => clearTimeout(announceTimer));
  createEffect(
    on(
      () => (slashOpen() ? slashMatches().length : null),
      (n) => {
        clearTimeout(announceTimer);
        if (n === null) return;
        const say = () => {
          lastAnnounced = Date.now();
          announce(n === 0 ? "0 commands match." : `${n} ${n === 1 ? "command" : "commands"} available.`);
        };
        const wait = 1000 - (Date.now() - lastAnnounced);
        if (wait <= 0) say();
        else announceTimer = setTimeout(say, wait);
      },
    ),
  );
  // The @ menu's own count, through the same throttle (only one menu can be open at a time).
  let mentionAnnounceTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(mentionAnnounceTimer));
  createEffect(
    on(
      () => (mentionOpen() ? (mentionStatus().state === "ready" ? mentionAll().length : null) : null),
      (n) => {
        clearTimeout(mentionAnnounceTimer);
        if (n === null) return;
        const say = () => {
          lastAnnounced = Date.now();
          announce(n === 0 ? "0 files match." : `${n} ${n === 1 ? "file" : "files"} available.`);
        };
        const wait = 1000 - (Date.now() - lastAnnounced);
        if (wait <= 0) say();
        else mentionAnnounceTimer = setTimeout(say, wait);
      },
    ),
  );

  /** The single entry point for picker, paste, and drop. Each accepted file uploads now, in
      parallel, and its row appears when it lands; the stored draft then holds it. */
  const addFiles = (files: File[], pasted = false) => {
    if (disabled() || files.length === 0) return;
    const result = acceptFiles(files, images().length + uploading(), pasted);
    const said: string[] = [];
    if (result.accepted.length) {
      said.push(`${result.accepted.length} ${result.accepted.length === 1 ? "image" : "images"} attached.`);
    }
    if (result.rejected.length) {
      setRejected([...rejected(), ...result.rejected]);
      for (const r of result.rejected) said.push(`${r.name} wasn't attached. ${r.reason}.`);
    }
    // One announcement: the live region only speaks its latest text.
    if (said.length) announce(said.join(" "));
    // The path is fixed now: an upload that lands after a session switch still joins its own draft.
    const path = props.path;
    setUploading((n) => n + result.accepted.length);
    for (const a of result.accepted) {
      uploadAccepted(a, path)
        .then((stored) => setDraftAttachments(path, [...draftAttachments(path), stored]))
        .catch(() => {
          if (disposed) return;
          setRejected((r) => [...r, { id: a.id, name: a.name, reason: "Upload failed" }]);
          announce(`${a.name} wasn't attached. Upload failed.`);
        })
        .finally(() => setUploading((n) => n - 1));
    }
  };

  /** After Remove/Dismiss: the next item's button, else the previous one's, else the textarea. */
  const focusAfterRemoval = (index: number) =>
    queueMicrotask(() => {
      const buttons = list?.querySelectorAll<HTMLButtonElement>(".attachment .button-icon") ?? [];
      (buttons[index] ?? buttons[index - 1] ?? input).focus();
    });
  const remove = (p: PendingImage, index: number) => {
    setDraftAttachments(props.path, draftAttachments(props.path).filter((x) => x.path !== p.path));
    rows.delete(p.path);
    // Best effort: a file left behind is only disk, and the draft no longer names it.
    void deleteAttachment(p.path).catch(() => {});
    focusAfterRemoval(index);
  };
  const dismiss = (r: RejectedFile, index: number) => {
    setRejected(rejected().filter((x) => x.id !== r.id));
    focusAfterRemoval(images().length + index);
  };

  // Stray drops anywhere else must not navigate the tab to the image. Both events, or it lands anyway.
  const guard = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  };
  window.addEventListener("dragover", guard);
  window.addEventListener("drop", guard);
  onCleanup(() => {
    window.removeEventListener("dragover", guard);
    window.removeEventListener("drop", guard);
  });

  // Auto-grow fallback where `field-sizing: content` isn't supported.
  const grow = () => {
    if (CSS.supports("field-sizing", "content")) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  };
  createEffect(on(text, () => queueMicrotask(grow)));
  createEffect(
    on(
      () => props.restored,
      (r) => r?.text && setDraft([r.text, text()].filter((t) => t.trim()).join("\n\n")),
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => props.taken,
      (t) => {
        if (!t) return;
        touched = true;
        setText("");
        setDraftText(props.path, "");
      },
      { defer: true },
    ),
  );
  onMount(() => {
    // Pasted files attach; a paste with text keeps its text, the files are ours either way. By hand,
    // not `onPaste`: Solid doesn't delegate paste, and closing must be able to take it off.
    input.addEventListener(
      "paste",
      (e) => {
        const files = [...(e.clipboardData?.files ?? [])];
        if (files.length === 0) return;
        if (!e.clipboardData?.getData("text/plain")) e.preventDefault();
        addFiles(files, true);
      },
      { signal: listening.signal },
    );
    // After the frame, so a closing dialog's focus handling has already run. Not on a touch-only
    // device: focusing the textarea there raises the keyboard over the new session.
    const touchOnly = matchMedia("(hover: none) and (pointer: coarse)").matches;
    if (props.autofocus && !props.readOnly && !touchOnly) requestAnimationFrame(() => input.focus());
  });

  let startingNew = false;
  const send = async (e?: Event) => {
    e?.preventDefault();
    if (!canSend()) return;
    // "/agents" is ours: it opens the subagents pane instead of reaching a runtime whose own
    // monitor is TUI-only. With images attached it's a message like any other.
    if (!props.picks && localCommand(text()) === "subagents" && props.onShowWorkers && images().length === 0) {
      if (!props.workersOpen) props.onShowWorkers();
      setDraft("");
      input.value = "";
      setSlashToken(null);
      announce(props.workersOpen ? "Subagents already open." : "Subagents open.");
      return;
    }
    // "/tree" is ours as well: pi's is a TUI built-in, so it would reach the model as literal
    // text. Here it opens the Timeline on your own messages, where each row rewinds to before
    // that message.
    if (!props.picks && localCommand(text()) === "tree" && props.onShowTimeline && images().length === 0) {
      props.onShowTimeline(true);
      setDraft("");
      input.value = "";
      setSlashToken(null);
      announce("Timeline open, your messages only.");
      return;
    }
    // "/timeline" is ours in the same way: pi has no such built-in, so it would reach the model as
    // literal text. Here it opens the Timeline tab, the session's one time axis.
    if (!props.picks && localCommand(text()) === "timeline" && props.onShowTimeline && images().length === 0) {
      props.onShowTimeline();
      setDraft("");
      input.value = "";
      setSlashToken(null);
      announce("Timeline open.");
      return;
    }
    // "/new" is ours too: a fresh session in this folder, and this one archived. Nothing
    // reaches the runtime, so no "Ran" row. The draft stays if no session was made.
    if (!props.picks && localCommand(text()) === "new" && props.onNewSession && images().length === 0) {
      if (startingNew) return;
      startingNew = true;
      const cwd = await props.onNewSession().finally(() => (startingNew = false));
      if (cwd === null) return;
      setDraft("");
      input.value = "";
      setSlashToken(null);
      announce(`New session in ${cwd}.`);
      return;
    }
    // "/clear" in the Overseer: a new conversation. Nothing reaches the runtime; the old one stays
    // in the Overseer's history.
    if (!props.picks && localCommand(text(), localOpts()) === "clear" && props.onClear && images().length === 0) {
      if (startingNew) return;
      startingNew = true;
      const cleared = await props.onClear().finally(() => (startingNew = false));
      if (!cleared) return;
      setDraft("");
      input.value = "";
      setSlashToken(null);
      announce("Cleared. The previous conversation is in History.");
      return;
    }
    // "/mode" in the Overseer: it is always in normal mode, so a switch is answered here and
    // nothing reaches the runtime. With images too: they stay in the draft.
    if (!props.picks && localCommand(text(), localOpts()) === "mode" && props.onMode) {
      props.onMode();
      setDraft("");
      input.value = "";
      setSlashToken(null);
      return;
    }
    // Every attachment is already stored (Send waits for uploads), so this only names them. The
    // optimistic row takes each file's own name, as the transcript will once it's refetched.
    const pending = draftAttachments(props.path);
    const attachments = pending.map((a) => ({ ...a, name: a.path.slice(a.path.lastIndexOf("/") + 1) }));
    const picks = props.picks;
    if (props.onSend(withImagePaths(picks ? picks.compose(text().trim()) : text().trim(), pending), props.running, attachments)) {
      touched = true;
      picks?.clear();
      setText("");
      clearDraft(props.path);
      rows.clear();
      setRejected([]);
    }
    input.focus();
  };

  const runStatus = () => (
    <>
        {/* One row, whichever of the three has something to say (they can coexist: the inputs
            trigger sits at its right end while a turn streams, and alone when nothing runs). */}
        <Show when={controls().status || workersRow() || inputsRow() || inputsHeld() || alignRow() || props.cards?.length || runningRow() || permitsRow()}>
          <p class="run-status">
            {/* One dot leads the row while anything works — the turn, a stop, a rare state, a
                compaction or a subagent — and nothing else in the row pulses. */}
            <Show when={inFlight()}>
              <span class="live-dot" aria-hidden="true" />
            </Show>
            {/* Two forms, picked by the composer's width in CSS (§chat.transcript/streaming): wide,
                "Working · running bash" in words; narrow, the step's icon, the same words visually
                hidden, so they're read once either way. Stopping and the rare states keep their
                words in both. */}
            <Show when={controls().status}>
              <Show
                when={!props.stopping && !props.activity}
                fallback={
                  <span class="run-status-state" title={stateWords()}>
                    <span class="run-status-words">{stateWords()}</span>
                  </span>
                }
              >
                <span class="run-status-state" title={stateWords()}>
                  <Show when={props.detail}>{(d) => <Icon name={STEP_ICON[d().step]} small class="run-status-narrow" />}</Show>
                  <span class="run-status-say">
                    Working
                    <Show when={props.detail}>{(d) => <span class="run-status-detail">· {d().text}</span>}</Show>
                  </span>
                </span>
              </Show>
            </Show>
            <Show when={workersRow()}>
              {(row) => (
                <>
                  <Show
                    when={props.onShowWorkers}
                    fallback={
                      <span class="run-status-workers" title={workersTitle(row().text)}>
                        <WorkersRing working={row().working} total={row().total} />
                        <span class="text-num run-status-narrow" aria-hidden="true">{row().n}</span>
                        <span class="run-status-say">{row().text}</span>
                      </span>
                    }
                  >
                    {(show) => (
                      <button
                        type="button"
                        class="run-status-link"
                        aria-label={row().label}
                        title={workersTitle(row().label)}
                        aria-expanded={tabExpanded(props.workersOpen, "agents") ? "true" : "false"}
                        aria-controls={PANE_ID}
                        onClick={() => show()()}
                      >
                        <WorkersRing working={row().working} total={row().total} />
                        <span class="text-num run-status-narrow">{row().n}</span>
                        <span class="run-status-wide">{row().text}</span>
                        <Icon name="chevron-right" small />
                      </button>
                    )}
                  </Show>
                </>
              )}
            </Show>
            {/* The alignment chip, then the inputs trigger: right-aligned together (the chip takes the
                auto margin when it is there), so they keep their place whatever else the row carries. */}
            <Show when={runningRow()}>
              {(r) => (
                <button
                  type="button"
                  class="run-status-link run-status-running text-num"
                  title="Sessions the Overseer started or messaged that are working now, of its limit. Opens Settings → Overseer → Limits."
                  onClick={() => openSettings("overseer", "overseer-limits")}
                >
                  {r().running} of {r().cap} running
                </button>
              )}
            </Show>
            <Show when={permitsRow()}>
              {(permits) => (
                <OverseerPermitsChip
                  permits={permits().permits}
                  schedules={permits().schedules}
                  onRevoke={(id) => props.onRevokePermit?.(id) ?? Promise.resolve(null)}
                  onApproveSchedule={(s) => props.onApproveSchedule?.(s) ?? Promise.resolve(null)}
                  onRevokeSchedule={(id) => props.onRevokeSchedule?.(id) ?? Promise.resolve(null)}
                  onJumpCard={(id) => props.onJumpCardId?.(id)}
                  onJumpUse={(id) => props.onJumpToolCall?.(id)}
                />
              )}
            </Show>
            <Show when={props.onJumpCard && props.cards?.length ? props.cards : null}>{(cards) => <OverseerCardChip cards={cards()} onJump={(c) => props.onJumpCard?.(c)} />}</Show>
            <Show when={alignRow()}>{(entries) => <AlignChip entries={entries()} onJump={(e) => props.onJumpAlign?.(e)} />}</Show>
            <Show when={inputsRow()}>
              {(row) => (
                <button
                  type="button"
                  class="run-status-link"
                  style={{ "margin-left": alignRow() ? "calc(var(--run-status-pad) * -1)" : "auto", "margin-right": 0 }}
                  aria-label={row().label}
                  aria-expanded={props.inputsOpen ? "true" : "false"}
                  aria-controls={PANE_ID}
                  onClick={() => props.onShowTimeline?.(true)}
                >
                  {row().text}
                  <Icon name="chevron-right" small />
                </button>
              )}
            </Show>
            <Show when={inputsHeld()}>
              <span
                class="run-status-link"
                aria-hidden="true"
                style={{ visibility: "hidden", "margin-left": alignRow() ? "calc(var(--run-status-pad) * -1)" : "auto", "margin-right": 0 }}
              >
                {inputsText(1)}
                <Icon name="chevron-right" small />
              </span>
            </Show>
          </p>
        </Show>
    </>
  );

  return (
    <footer
      class="composer"
      data-drop={drop() ?? undefined}
      onDragOver={(e) => {
        if (disabled() || !e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        const ok = dragHasAcceptedImage(e.dataTransfer);
        e.dataTransfer.dropEffect = ok ? "copy" : "none";
        setDrop(ok ? "active" : "reject");
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
      }}
      onDrop={(e) => {
        setDrop(null);
        if (disabled() || !e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        addFiles([...e.dataTransfer.files]);
      }}
    >
      <div class="composer-drop" aria-hidden="true">
        <Show when={drop() === "reject"} fallback={<><Icon name="image" /><span>Drop images to attach</span></>}>
          <Icon name="alert-circle" />
          <span>Only images can be attached</span>
        </Show>
      </div>

      <form class="composer-inner" aria-label="Message the agent" onSubmit={send}>
        {/* First child: base.css anchors it just above the composer at full width. */}
        <Show when={slashOpen()}>
          <SlashMenu
            commands={slashMatches()}
            ids={slashIds()}
            active={slashActive()}
            query={slashToken()?.query ?? ""}
            touch={touch()}
            onPick={pickSlash}
            onHover={setSlashActive}
          />
        </Show>
        {/* Its twin: whichever token the caret is in, only one can be open. */}
        <Show when={mentionOpen()}>
          <FileMenu
            entries={mentionMatches()}
            total={mentionAll().length}
            ids={mentionIds()}
            active={mentionActive()}
            segment={mentionQueryParts(mentionToken()?.query ?? "").segment}
            dir={mentionQueryParts(mentionToken()?.query ?? "").dir}
            status={mentionStatus()}
            truncated={mentionTruncated()}
            root={props.cwd ?? undefined}
            onPick={pickMention}
            onHover={setMentionActive}
          />
        </Show>
        {runStatus()}

        <Show when={props.picks}>
          {(p) => (
            <div class="align-picks" role="group" aria-label="Staged answers">
              <Icon name="check" small />
              <span class="align-picks-text" title={`Answering: ${p().label}`}>
                Answering: <span class="text-mono">{p().label}</span>
              </span>
              <button type="button" class="button button-icon button-ghost" aria-label="Clear Picks" title="Clear Picks" onClick={() => p().clear()}>
                <Icon name="close" small />
              </button>
            </div>
          )}
        </Show>
        <VoiceStrip voice={voice} />
        <Show when={images().length > 0 || rejected().length > 0}>
          <ul class="attachments" aria-label="Attachments" ref={list}>
            <For each={images()}>
              {(img, i) => (
                <li class="attachment">
                  <button
                    type="button"
                    class="attachment-thumb-button"
                    aria-haspopup="dialog"
                    aria-label={`View ${img.name}`}
                    title={img.name}
                    onClick={(e) => openLightbox([{ src: img.previewUrl, alt: `Attachment ${img.name}` }], 0, e.currentTarget)}
                  >
                    <img class="attachment-thumb" src={img.previewUrl} alt="attachment" />
                  </button>
                  <span class="attachment-text">
                    <span class="attachment-name" title={img.name}>
                      {img.name}
                    </span>
                    <span class="attachment-meta">{size(img.size)}</span>
                  </span>
                  <button type="button" class="button button-icon" aria-label={`Remove ${img.name}`} onClick={() => remove(img, i())}>
                    <Icon name="close" small />
                  </button>
                </li>
              )}
            </For>
            <For each={rejected()}>
              {(r, i) => (
                <li class="attachment attachment-rejected">
                  <span class="attachment-icon">
                    <Icon name="alert-circle" />
                  </span>
                  <span class="attachment-text">
                    <span class="attachment-name" title={r.name}>
                      {r.name}
                    </span>
                    <span class="attachment-meta">{r.reason}</span>
                  </span>
                  <button type="button" class="button button-icon" aria-label={`Dismiss ${r.name}`} onClick={() => dismiss(r, i())}>
                    <Icon name="close" small />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <div class="composer-row">
          {/* The mic first, left of the plus; gone with the textarea's writability (§chat.voice/button). */}
          <Show when={!props.readOnly}>
            <VoiceButton voice={voice} />
          </Show>
          {/* One flyout in place of the old Attach and Commands buttons. */}
          <ComposerMenu
            disabled={disabled()}
            commandsAvailable={(props.commands?.length ?? 0) > 0}
            onAttach={() => picker?.click()}
            onCommands={toggleCommands}
            model={props.model}
            thinking={props.thinking}
            onPlaybooks={props.onPlaybooks}
            undo={props.undo}
            sandbox={props.sandbox}
            login={props.login}
            onRefocus={() => input.focus()}
            onApi={setMenu}
          />
          <Show when={!props.readOnly}>
            <input
              ref={picker}
              class="visually-hidden"
              type="file"
              multiple
              tabindex="-1"
              aria-hidden="true"
              accept={ACCEPTED_TYPES.join(",")}
              onChange={(e) => {
                addFiles([...(e.currentTarget.files ?? [])]);
                e.currentTarget.value = ""; // so the same file can be picked twice
              }}
            />
          </Show>
          <label class="visually-hidden" for={paneId("composer-input")}>
            Message
          </label>
          <textarea
            ref={input}
            class="input textarea composer-input"
            id={paneId("composer-input")}
            rows={1}
            placeholder={placeholder()}
            data-ph-size={fitted()?.size === "caption" ? "caption" : undefined}
            enterkeyhint={touch() ? "enter" : "send"}
            aria-describedby={paneId("composer-reason")}
            aria-autocomplete={slashOpen() || mentionOpen() ? "list" : undefined}
            aria-controls={listboxControls() ?? undefined}
            aria-activedescendant={listboxActive() ?? undefined}
            value={text()}
            disabled={!!props.readOnly}
            onInput={(e) => {
              buttonSlash = null; // typed: the "/" is the user's now
              setDraft(e.currentTarget.value);
              updateSlash();
              updateMention();
            }}
            onClick={() => {
              updateSlash();
              updateMention();
            }}
            onKeyUp={(e) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
                updateSlash();
                updateMention();
              }
            }}
            onPointerDown={onPointerDown}
            // focusout, not blur: a delegated handler is one releaseControl can drop (the textarea
            // has no children, so the two fire alike).
            onFocusOut={() => {
              dropButtonSlash(); // closing by blur undoes an untouched button "/" too
              setSlashToken(null);
              setMentionToken(null);
            }}
            onKeyDown={(e) => {
              // A bare local command runs on the Enter that would send; in touch mode it's a newline.
              const runsLocal = enterSends(e, touch()) && enterRunsLocal(text(), e.key, e.shiftKey, localOpts());
              if (slashOpen() && !e.isComposing && !runsLocal) {
                const hasMatches = slashMatches().length > 0;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  if (!hasMatches) return;
                  e.preventDefault();
                  moveSlash(e.key === "ArrowDown" ? 1 : -1);
                  return;
                }
                if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                  if (hasMatches) {
                    e.preventDefault();
                    pickSlash(slashActive());
                    return;
                  }
                  if (e.key === "Tab") return; // nothing to insert: Tab moves focus as usual
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  const token = slashToken();
                  setSlashDismissed(token ? tokenKey(token) : null);
                  dropButtonSlash(); // a "/" the Commands button added, untouched, goes away
                  updateSlash();
                  return;
                }
              }
              if (mentionOpen() && !e.isComposing) {
                const hasMatches = mentionMatches().length > 0;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  if (!hasMatches) return;
                  e.preventDefault();
                  const n = mentionMatches().length;
                  setMentionActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
                  return;
                }
                // Enter and Tab both complete: the next Enter, menu closed, does what Enter does.
                // With no match, Enter falls through to that rule with the typed text as-is.
                if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                  if (hasMatches) {
                    e.preventDefault();
                    pickMention(mentionActive());
                    return;
                  }
                  if (e.key === "Tab") return; // nothing to complete: Tab moves focus as usual
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  const token = mentionToken();
                  setMentionDismissed(token ? mentionKey(token) : null);
                  updateMention();
                  return;
                }
              }
              if (enterSends(e, touch())) void send(e);
            }}
          />
          <div class="composer-actions">
            <Show when={!props.readOnly}>
              <button
                type="submit"
                class="button button-primary"
                aria-disabled={canSend() ? undefined : "true"}
                aria-describedby={paneId("composer-reason")}
              >
                <Icon name="arrow-right" small />
                <span class="button-label">{controls().steer ? "Steer" : "Send"}</span>
              </button>
            </Show>
            <Show when={controls().stop && !props.readOnly}>
              {/* Icon only, at every width: the 44px square is the form the actions row already
                  collapses to under 480px, and the run-status row above says "Stopping…" — so the
                  word was repeating what the status row and the glyph already say. */}
              <button
                type="button"
                class="button button-destructive button-icon"
                aria-label="Stop"
                title="Stop"
                aria-disabled={props.stopping ? "true" : undefined}
                onClick={() => {
                  if (!props.stopping) props.onAbort();
                  input.focus();
                }}
              >
                <Icon name="stop" />
              </button>
            </Show>
          </div>
        </div>

        <div class="composer-foot">
          <Show when={props.model}>
            <button
              ref={indicator}
              type="button"
              class="composer-model"
              aria-haspopup="menu"
              aria-controls={paneId("composer-flyout")}
              aria-expanded={indicatorOpen() ? "true" : "false"}
              aria-disabled={disabled() ? "true" : undefined}
              aria-label={`${modelRef() ?? "No model yet"}${levelShown() ? `, thinking ${levelShown()}` : ""} — Change Model & Thinking`}
              title={`${modelRef() ?? "Choose model"} · Change model & thinking`}
              onPointerDown={() => (openAtPress = indicatorOpen())}
              onClick={(e) => toggleIndicator(e.detail > 0)}
            >
              <Show when={props.model?.pending()}>
                <span class="live-dot" />
              </Show>
              <span class="composer-model-id">{shortModel(modelRef()) ?? "Choose model"}</span>
              <Show when={modelProvider(modelRef())}>
                {(provider) => <span class="composer-model-meta">{provider()}</span>}
              </Show>
              <Show when={levelShown()}>
                {(level) => (
                  <>
                    <span class="composer-model-sep" aria-hidden="true">·</span>
                    <Show when={props.thinking?.pending()}>
                      <span class="live-dot" />
                    </Show>
                    <span class="composer-model-level">{level()}</span>
                  </>
                )}
              </Show>
              <Icon name="chevron-down" small class="composer-model-caret" />
            </button>
          </Show>
          <Show when={loginShown()}>
            {(l) => (
              <button
                ref={loginLabel}
                type="button"
                class="composer-login"
                aria-haspopup="menu"
                aria-controls={paneId("composer-flyout")}
                aria-expanded={loginOpen() ? "true" : "false"}
                aria-disabled={disabled() || !props.login ? "true" : undefined}
                title={l().title}
                aria-label={l().label}
                onPointerDown={() => (loginOpenAtPress = loginOpen())}
                onClick={(e) => toggleLogin(e.detail > 0)}
              >
                <Show when={l().pending}>
                  <span class="live-dot" />
                </Show>
                <span class="composer-login-full">{l().text}</span>
                <span class="composer-login-short">{l().short}</span>
              </button>
            )}
          </Show>
          <span class="composer-reason" id={paneId("composer-reason")}>
            <Show when={shownReason()}>
              {(r) => (
                <>
                  <Icon name={r().icon} small />
                  {r().text}
                </>
              )}
            </Show>
          </span>
          <Show when={sandboxBadge(props.sandbox?.state() ?? null)}>
            {(b) => (
              <button
                ref={shield}
                type="button"
                class={`composer-sandbox composer-sandbox-${b().tone}`}
                aria-haspopup="menu"
                aria-controls={paneId("composer-flyout")}
                aria-expanded={shieldOpen() ? "true" : "false"}
                aria-disabled={disabled() ? "true" : undefined}
                title={b().label}
                onPointerDown={() => (shieldOpenAtPress = shieldOpen())}
                onClick={(e) => toggleShield(e.detail > 0)}
              >
                <Icon name={b().icon} small />
                <Show when={b().word}>{(w) => <span aria-hidden="true">{w()}</span>}</Show>
                <span class="visually-hidden">{b().label}</span>
              </button>
            )}
          </Show>
          <Show when={props.mode}>{(c) => <ModeMenu control={c()} />}</Show>
          <Show when={props.accessory}>
            {(accessory) => <div class="composer-accessory">{accessory()()}</div>}
          </Show>
        </div>
      </form>
    </footer>
  );
}
