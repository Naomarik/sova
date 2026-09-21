import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { SlashCommand, UploadResult } from "../../shared/protocol";
import { enterRunsLocal, insertCommand, localCommand, rankCommands, slashMenuSuppressed, slashTokenAt, type SlashToken } from "../lib/slash";
import { commandOptionIds, SlashMenu } from "./SlashMenu";
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
import { ensureModels, modelList, thinkingLevelsFor } from "../lib/models";
import {
  announce,
  clearDraft,
  draftAttachments,
  drafts,
  flushDrafts,
  loadDraft,
  openLightbox,
  setDraftAttachments,
  setDraftText,
} from "../lib/ui-state";
import { inputsText } from "../lib/input-count";
import { showInputsOnTimelineLabel } from "../lib/timeline";
import { showWorkersLabel, teamNote, type WorkingSplit, workersRunningLabel, workersWorkingLabel } from "../lib/workers";
import { ComposerMenu, type ComposerMenuApi, type ThinkingControl, type UndoControl } from "./ComposerMenu";
import type { ModelControl } from "./ModelMenu";
import { ModeMenu, type ModeControl } from "./ModeMenu";
import { Icon, type IconName } from "./ui";

/** The session pane's element id: ONE pane, five tabs, so every trigger controls the same id. */
const PANE_ID = "session-pane";

export interface ComposerReason {
  icon: IconName;
  text: string;
}

/** `KB` under 1 MB, rounded; otherwise one decimal. */
const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Prompt input (spec/04-composer.md §4, §4b). Enter sends, Shift+Enter adds a newline. While `running`,
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
  stopping: boolean;
  /** "running bash" / "thinking" / "writing" / "Compacting context" … */
  detail: string | null;
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
  /** Runs a bare "/new" (§4d): resolves to the new session's folder label, or null if none was made. */
  onNewSession?: () => Promise<string | null>;
  /** Opens the session pane's Timeline tab: a bare "/timeline" (§4d) unfiltered; a bare "/tree" and
      the run-status row's "N inputs" trigger with `inputsOnly`, on your own messages. */
  onShowTimeline?: (inputsOnly?: boolean) => void;
  /** User messages on this chat's active branch; the status row's inputs trigger, hidden at 0. */
  inputCount?: number;
  autofocus?: boolean;
  /** This session's slash commands; the "/" autocomplete is off without them. */
  commands?: SlashCommand[];
  /** Chat sessions only: the flyout's model picker (§4c). */
  model?: ModelControl | null;
  /** Chat sessions only: the flyout's Thinking ladder (§4b). */
  thinking?: ThinkingControl | null;
  /** Chat sessions only: this chat's mode switch, at the right end of the foot (§4g). */
  mode?: ModeControl | null;
  /** Opens this session's info modal from the flyout (§4h). */
  onShowInfo?: () => void;
  /** Chat sessions only: the flyout's "Undo last turn" row. */
  undo?: UndoControl | null;
  /** `text` already names each attachment's path; `attachments` are for the optimistic row. */
  onSend(text: string, steer: boolean, attachments: UploadResult[]): boolean;
  onAbort(): void;
  /** Queued text a Stop handed back; each new object goes ahead of the draft (TUI Esc order). */
  restored?: { text: string } | null;
}) {
  const [text, setText] = createSignal(drafts.get(props.path) ?? "");
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
  let input!: HTMLTextAreaElement;
  let picker: HTMLInputElement | undefined;
  let list: HTMLUListElement | undefined;
  let indicator: HTMLButtonElement | undefined;
  /** The flyout's handle (§4b), so the model indicator opens the same one popover. */
  const [menu, setMenu] = createSignal<ComposerMenuApi | null>(null);

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
  onCleanup(() => {
    disposed = true;
    flushDrafts();
  });

  const reason = () => props.readOnly ?? props.blocked ?? null;
  /** TUI-live, connecting, reconnecting: nothing attaches and nothing sends. */
  const disabled = () => !!reason();
  /** What the foot says: the state's reason, else that an attachment is still uploading. */
  const shownReason = (): ComposerReason | null => reason() ?? (uploading() > 0 ? { icon: "clock", text: "Uploading…" } : null);
  // The key hint lives in the placeholder, and only at unfolded width: a touch-first device has
  // no Enter key to speak of. Live, so a resize across 768px swaps it in place.
  const unfolded = matchMedia("(min-width: 768px)");
  const [keyHint, setKeyHint] = createSignal(unfolded.matches);
  const onBand = (e: MediaQueryListEvent) => setKeyHint(e.matches);
  unfolded.addEventListener("change", onBand);
  onCleanup(() => unfolded.removeEventListener("change", onBand));
  const placeholder = () => `${props.running ? "Steer the current turn…" : "Ask pi to…"}${keyHint() && !props.readOnly ? "—Enter sends, Shift+Enter adds a line" : ""}`;
  const canSend = () => !disabled() && uploading() === 0 && (text().trim().length > 0 || images().length > 0);

  // ---- Model indicator (§4 ".composer-foot"): this session's model and thinking level, and
  // the second trigger for the flyout that changes them. -----------------------------------
  /** What the session runs, or the target it's switching to — the flyout's Model row, shortened. */
  const modelRef = () => props.model?.pending() ?? props.model?.model() ?? null;
  /** The level to show, or null when this model's ladder isn't a choice (§4b "Thinking"). */
  const levelShown = () => {
    const thinking = props.thinking;
    if (!thinking || thinkingLevelsFor(props.model?.model()).length <= 1) return null;
    return thinking.pending() ?? thinking.level();
  };
  // The thinking ladder decides whether the level is worth showing, and it only arrives with the
  // model catalog — load it as soon as a session has a thinking control, not when the flyout opens.
  createEffect(() => {
    if (props.thinking && props.model?.model() && !modelList()) void ensureModels().catch(() => {});
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

  /** The subagents status row (§11 Trigger): what's working, or — once idle — what the session
      has, so the pane stays one click away after every worker settles. While the parent's own
      turn runs it stays too, showing the counts without repeating "working" beside the Working
      label; a settled-workers row is only worth offering once the parent is idle. */
  const workersRow = () => {
    const working = props.workersWorking ?? 0;
    if (working > 0)
      return {
        live: true,
        text: props.running ? workersRunningLabel(working, props.workersSplit) : workersWorkingLabel(working, props.workersSplit),
        label: showWorkersLabel(working, props.workersSplit),
      };
    if (props.running) return null;
    const total = props.workersTotal ?? 0;
    if (total === 0 || !props.onShowWorkers) return null; // settled workers are only worth a row you can open
    const text = `${total} ${total === 1 ? "subagent" : "subagents"}`;
    return { live: false, text, label: `${text} — show subagents` };
  };

  /** A status-row trigger is expanded only when the pane shows ITS tab — the pane open on any
      other tab is not this control's disclosure. `paneTab` answers when App knows the tab; null
      means "no tab stored yet", where the pane falls back to Agents-if-working-else-Session, so
      the per-trigger boolean (which App derives from the same rule) answers instead. */
  const tabExpanded = (open: boolean | undefined, tab: string) =>
    props.paneTab == null ? !!open : props.paneTab === tab;

  /** The status row's inputs trigger (§4 ".run-status"): the branch's user messages, one click
      from the pane's Timeline with Inputs Only on. It survives an idle session with no workers —
      the row shows for it alone — and disappears at 0, where the empty state already speaks. */
  const inputsRow = () => {
    const n = props.inputCount ?? 0;
    return n > 0 && props.onShowTimeline ? { n, text: inputsText(n), label: showInputsOnTimelineLabel(n) } : null;
  };

  // ---- Slash-command autocomplete (combobox: focus stays in the textarea) ----------------
  const slashMatches = createMemo(() => {
    const token = slashToken();
    return token ? rankCommands(props.commands ?? [], token.query) : [];
  });
  const slashIds = createMemo(() => commandOptionIds(slashMatches()));
  /** Never while disabled, nor on a bare local command (§4d). Streaming is fine: pi runs a
      "/command" steer as a command. */
  const slashOpen = () => {
    const token = slashToken();
    return (
      !!token &&
      !disabled() &&
      (props.commands?.length ?? 0) > 0 &&
      slashDismissed() !== tokenKey(token) &&
      !slashMenuSuppressed(text())
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

  // Stray drops anywhere else must not navigate the tab to the image.
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
  onMount(() => {
    // After the frame, so a closing dialog's focus handling has already run. Not on a touch-only
    // device: focusing the textarea there raises the keyboard over the new session (§5, §4c).
    const touchOnly = matchMedia("(hover: none) and (pointer: coarse)").matches;
    if (props.autofocus && !props.readOnly && !touchOnly) requestAnimationFrame(() => input.focus());
  });

  let startingNew = false;
  const send = async (e?: Event) => {
    e?.preventDefault();
    if (!canSend()) return;
    // "/agents" is ours: it opens the subagents pane instead of reaching a runtime whose own
    // monitor is TUI-only (§11 Trigger). With images attached it's a message like any other.
    if (localCommand(text()) === "subagents" && props.onShowWorkers && images().length === 0) {
      if (!props.workersOpen) props.onShowWorkers();
      setDraft("");
      input.value = "";
      setSlashToken(null);
      announce(props.workersOpen ? "Subagents already open." : "Subagents open.");
      return;
    }
    // "/tree" is ours as well: pi's is a TUI built-in, so it would reach the model as literal
    // text. Here it opens the Timeline on your own messages, where each row rewinds to before
    // that message (§4d).
    if (localCommand(text()) === "tree" && props.onShowTimeline && images().length === 0) {
      props.onShowTimeline(true);
      setDraft("");
      input.value = "";
      setSlashToken(null);
      announce("Timeline open, your messages only.");
      return;
    }
    // "/timeline" is ours in the same way: pi has no such built-in, so it would reach the model as
    // literal text. Here it opens the Timeline tab, the session's one time axis (§4d).
    if (localCommand(text()) === "timeline" && props.onShowTimeline && images().length === 0) {
      props.onShowTimeline();
      setDraft("");
      input.value = "";
      setSlashToken(null);
      announce("Timeline open.");
      return;
    }
    // "/new" is ours too: a fresh session in this folder, and this one archived (§4d). Nothing
    // reaches the runtime, so no "Ran" row. The draft stays if no session was made.
    if (localCommand(text()) === "new" && props.onNewSession && images().length === 0) {
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
    // Every attachment is already stored (Send waits for uploads), so this only names them. The
    // optimistic row takes each file's own name, as the transcript will once it's refetched.
    const pending = draftAttachments(props.path);
    const attachments = pending.map((a) => ({ ...a, name: a.path.slice(a.path.lastIndexOf("/") + 1) }));
    if (props.onSend(withImagePaths(text().trim(), pending), props.running, attachments)) {
      touched = true;
      setText("");
      clearDraft(props.path);
      rows.clear();
      setRejected([]);
    }
    input.focus();
  };

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
            onPick={pickSlash}
            onHover={setSlashActive}
          />
        </Show>
        {/* One row, whichever of the three has something to say (they can coexist: the inputs
            trigger sits at its right end while a turn streams, and alone when nothing runs). */}
        <Show when={props.running || workersRow() || inputsRow()}>
          <p class="run-status">
            <Show when={props.running}>
              <span class="live-dot" />
              <Show when={!props.stopping} fallback="Stopping…">
                Working
                <Show when={props.detail}>
                  <span class="run-status-detail">· {props.detail}</span>
                </Show>
              </Show>
            </Show>
            <Show when={workersRow()}>
              {(row) => (
                <>
                  <Show
                    when={props.onShowWorkers}
                    fallback={
                      <>
                        <span class="live-dot" />
                        <span title={teamNote(props.workersSplit)}>{row().text}</span>
                      </>
                    }
                  >
                    {(show) => (
                      <button
                        type="button"
                        class="run-status-link"
                        aria-label={row().label}
                        title={teamNote(props.workersSplit)}
                        aria-expanded={tabExpanded(props.workersOpen, "agents") ? "true" : "false"}
                        aria-controls={PANE_ID}
                        onClick={() => show()()}
                      >
                        <Show when={row().live}>
                          <span class="live-dot" />
                        </Show>
                        {row().text}
                        <Icon name="chevron-right" small />
                      </button>
                    )}
                  </Show>
                </>
              )}
            </Show>
            {/* Right-aligned, so it keeps its place whatever else the row carries. */}
            <Show when={inputsRow()}>
              {(row) => (
                <button
                  type="button"
                  class="run-status-link"
                  style={{ "margin-left": "auto", "margin-right": 0 }}
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
          </p>
        </Show>

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
          {/* One flyout in place of the old Attach and Commands buttons (§4b). */}
          <ComposerMenu
            disabled={disabled()}
            commandsAvailable={(props.commands?.length ?? 0) > 0}
            onAttach={() => picker?.click()}
            onCommands={toggleCommands}
            model={props.model}
            thinking={props.thinking}
            onShowInfo={props.onShowInfo}
            undo={props.undo}
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
          <label class="visually-hidden" for="composer-input">
            Message
          </label>
          <textarea
            ref={input}
            class="input textarea composer-input"
            id="composer-input"
            rows={1}
            placeholder={placeholder()}
            aria-describedby="composer-reason"
            aria-autocomplete={slashOpen() ? "list" : undefined}
            aria-controls={slashOpen() && slashMatches().length > 0 ? "command-listbox" : undefined}
            aria-activedescendant={slashOpen() && slashMatches().length > 0 ? slashIds()[slashActive()] : undefined}
            value={text()}
            disabled={!!props.readOnly}
            onInput={(e) => {
              buttonSlash = null; // typed: the "/" is the user's now
              setDraft(e.currentTarget.value);
              updateSlash();
            }}
            onClick={updateSlash}
            onKeyUp={(e) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) updateSlash();
            }}
            onBlur={() => {
              dropButtonSlash(); // closing by blur undoes an untouched button "/" too
              setSlashToken(null);
            }}
            onPaste={(e) => {
              const files = [...(e.clipboardData?.files ?? [])];
              if (files.length === 0) return;
              // A paste with text keeps its text; the files are ours either way.
              if (!e.clipboardData?.getData("text/plain")) e.preventDefault();
              addFiles(files, true);
            }}
            onKeyDown={(e) => {
              if (slashOpen() && !e.isComposing && !enterRunsLocal(text(), e.key, e.shiftKey)) {
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
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) void send(e);
            }}
          />
          <div class="composer-actions">
            <Show when={!props.readOnly}>
              <button
                type="submit"
                class="button button-primary"
                aria-disabled={canSend() ? undefined : "true"}
                aria-describedby="composer-reason"
              >
                <Icon name="arrow-right" small />
                <span class="button-label">{props.running ? "Steer" : "Send"}</span>
              </button>
            </Show>
            <Show when={props.running && !props.readOnly}>
              <button
                type="button"
                class="button button-destructive"
                aria-disabled={props.stopping ? "true" : undefined}
                onClick={() => {
                  if (!props.stopping) props.onAbort();
                  input.focus();
                }}
              >
                <Icon name="stop" small />
                <span class="button-label">Stop</span>
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
              aria-controls="composer-flyout"
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
          <span class="composer-reason" id="composer-reason">
            <Show when={shownReason()}>
              {(r) => (
                <>
                  <Icon name={r().icon} small />
                  {r().text}
                </>
              )}
            </Show>
          </span>
          <Show when={props.mode}>{(c) => <ModeMenu control={c()} />}</Show>
        </div>
      </form>
    </footer>
  );
}
