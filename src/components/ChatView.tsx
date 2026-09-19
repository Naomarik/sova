import { batch, createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Portal } from "solid-js/web";
import type { ChatServerMessage, SlashCommand, TranscriptItem, WorkerInfo } from "../../shared/protocol";
import { fetchTranscriptWithContext, wsUrl } from "../lib/api";
import { contextStateFor, usageTokens, windowOf } from "../lib/context";
import { addPendingPrompt, applyEvent, emptyLive, runDetail, type LiveState } from "../lib/live";
import { isObj, str } from "../lib/message";
import { createReconnectingSocket } from "../lib/socket";
import type { UploadResult } from "../../shared/protocol";
import { announce, drafts, sessionContext, setLocalRunning, setSessionContext, toast } from "../lib/ui-state";
import { Composer, type ComposerReason } from "./Composer";
import { ConnectionBanner } from "./ConnectionBanner";
import type { ModeControl, ModeState } from "./ModeMenu";
import type { ModelControl } from "./ModelMenu";
import { HistoryItems, InfoRow, LiveEntries, ThreadScroller, TranscriptSkeleton, TurnError } from "./Thread";
import { Banner, Icon } from "./ui";
import { UiDialog } from "./UiDialog";

export type ChatRefusal = "busy" | "recent";

/** ui_request kinds UiDialog can show (DESIGN_NOTES §6); anything else needs the terminal UI. */
const UI_DIALOG_METHODS = ["select", "confirm", "input", "editor"];

/**
 * Full-duplex chat with a webapp-owned session. When the server refuses to let us write
 * (`busy`: a TUI owns it; `recent`: an unknown process wrote it moments ago), `onRefused` hands
 * control back so the parent can switch to the read-only watch view.
 */
export function ChatView(props: {
  path: string;
  cwdLabel: string;
  author: string;
  /** Reconnect past the server's recent-write guard (never past a live TUI). */
  force: boolean;
  autofocus?: boolean;
  onModel(model: string | null): void;
  /** Hands the header its model picker's controls; null when this view goes away. */
  onModelControl?(control: ModelControl | null): void;
  /** Hands the header this chat's mode state (§4g); null when this view goes away. */
  onModeControl?(control: ModeControl | null): void;
  onRefused(kind: ChatRefusal, message: string): void;
  onSettled(): void;
  /** This runtime's subagents (WS "workers"; [] after each hello), for the subagents pane. */
  onWorkers?(workers: WorkerInfo[]): void;
  /** Toggles the subagents pane from the composer's subagents row. */
  onShowWorkers?(): void;
  workersOpen?: boolean;
}) {
  const [items, setItems] = createSignal<TranscriptItem[] | null>(null);
  const [live, setLive] = createStore<LiveState>(emptyLive());
  const [syncing, setSyncing] = createSignal(false);
  const [errors, setErrors] = createSignal<string[]>([]);
  const [dialogs, setDialogs] = createSignal<{ id: string; request: unknown }[]>([]);
  const [resume, setResume] = createSignal(0);
  const [everOpened, setEverOpened] = createSignal(false);
  const [model, setModel] = createSignal<string | null>(null);
  const [pendingModel, setPendingModel] = createSignal<string | null>(null);
  const [modelError, setModelError] = createSignal<{ target: string; from: string | null; body: string | { noCredentials: string } } | null>(null);
  /** "Model changed to …" rows shown until a transcript reload brings the persisted entry. */
  const [modelRows, setModelRows] = createSignal<string[]>([]);
  /** This session's slash commands (sent after hello, and again after a runtime reload). */
  const [commands, setCommands] = createSignal<SlashCommand[]>([]);
  /** The global mode and how it applies to this chat (WS "mode"). */
  const [modeState, setModeState] = createSignal<ModeState | null>(null);
  /** Local "Ran /name args" rows; `tui` marks one that asked for a UI pi-web can't show. */
  const [commandRows, setCommandRows] = createSignal<{ label: string; tui: boolean }[]>([]);
  /** Subagents working now (WS "workers"); 0 until the first one arrives. */
  const [workersWorking, setWorkersWorking] = createSignal(0);
  let modelTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(modelTimer));

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
        if (isObj(ev) && ev.type === "compaction_end") setSessionContext(props.path, "compacted");
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
   * Uploaded images come back as their /tmp paths, already part of the text.
   */
  const restoreUnsent = () => {
    const unsent = live.entries.flatMap((e) => (e.kind === "user" && !e.confirmed ? [e] : []));
    if (unsent.length === 0) return;
    const texts = unsent.map((e) => e.text).filter(Boolean);
    const current = drafts.get(props.path);
    if (texts.length) drafts.set(props.path, [...texts, ...(current ? [current] : [])].join("\n\n"));
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
          batch(() => {
            setItems(msg.items);
            setLive(reconcile({ ...emptyLive(), running: msg.isStreaming }));
          });
          setModel(msg.model);
          setSessionContext(props.path, contextStateFor(msg.context ?? null, msg.items));
          setModelRows([]);
          setWorkersWorking(0); // a runtime without workers sends no "workers" after hello
          props.onWorkers?.([]);
          props.onModel(msg.model);
          break;
        case "workers":
          setWorkersWorking(msg.working);
          props.onWorkers?.(msg.workers);
          break;
        case "commands":
          setCommands(msg.commands);
          break;
        case "model":
          modelSwitched(msg.model);
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
          else if (req.method === "notify" && str(req.message)) toast(str(req.message)!);
          // setStatus is TUI chrome (and ANSI-coded); nothing to show.
          break;
        }
        case "error":
          if (pendingModel()) modelFailed(msg.message, msg.code);
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
            default:
              if (modelError()) break; // shown as the switch's banner
              setErrors((e) => [...e, msg.message]);
              // A prompt that failed before the agent started leaves nothing running.
              if (!live.entries.some((e) => e.kind === "assistant")) setLive("running", false);
          }
          break;
      }
    },
  });

  const answer = (id: string, value: unknown) => {
    socket.send({ type: "ui_response", id, value });
    setDialogs((d) => d.filter((x) => x.id !== id));
  };

  const blocked = (): ComposerReason | null => {
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

  // ---- Model switching (DESIGN_NOTES §4c) ------------------------------------------------
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
  props.onModelControl?.({
    model,
    pending: pendingModel,
    blocked: () => {
      if (live.running) return { title: "Model changes wait until this turn finishes.", body: "Stop or wait, then pick one." };
      const reason = blocked();
      return reason && !pendingModel() ? { title: reason.text } : null;
    },
    choose: chooseModel,
  });
  onCleanup(() => props.onModelControl?.(null));
  props.onModeControl?.({ state: modeState });
  onCleanup(() => props.onModeControl?.(null));

  // Mirror this session's run state for the sidebar's Busy chip (the list refetches on settle).
  const setMine = (running: boolean | undefined) =>
    setLocalRunning((m) => {
      const next = { ...m };
      if (running === undefined) delete next[props.path];
      else next[props.path] = running;
      return next;
    });
  createEffect(() => setMine(live.running));
  onCleanup(() => setMine(undefined));

  const send = (text: string, steer: boolean, uploads: UploadResult[]) => {
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
      addPendingPrompt(setLive, text, [], uploads);
      setLive("running", true);
      setResume((n) => n + 1);
    });
    return true;
  };

  const abort = () => {
    if (socket.send({ type: "abort" })) setLive("stopping", true);
  };

  return (
    <>
      <ThreadScroller
        count={(items()?.length ?? 0) + live.entries.length}
        resume={resume()}
        busy={!items()}
        banner={
          <div class="stack-2">
            <ConnectionBanner socket={socket} />
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
          </div>
        }
      >
        <Show when={items()} fallback={<TranscriptSkeleton />}>
          {(list) => (
            <>
              <HistoryItems items={list()} author={props.author} streaming={live.running} />
              <LiveEntries live={live} author={props.author} />
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
      <Composer
        path={props.path}
        blocked={blocked()}
        commands={commands()}
        running={live.running}
        stopping={live.stopping}
        detail={live.activity ?? runDetail(live)}
        workersWorking={workersWorking()}
        onShowWorkers={props.onShowWorkers}
        workersOpen={props.workersOpen}
        autofocus={props.autofocus}
        onSend={send}
        onAbort={abort}
      />
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
