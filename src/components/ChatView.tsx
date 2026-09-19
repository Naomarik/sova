import { batch, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Portal } from "solid-js/web";
import type { ChatServerMessage, TranscriptItem } from "../../shared/protocol";
import { fetchTranscript, wsUrl } from "../lib/api";
import { addPendingPrompt, applyEvent, emptyLive, runDetail, type LiveState } from "../lib/live";
import { isObj, str } from "../lib/message";
import { createReconnectingSocket } from "../lib/socket";
import { announce, drafts, toast } from "../lib/ui-state";
import { Composer, type ComposerReason } from "./Composer";
import { ConnectionBanner } from "./ConnectionBanner";
import { HistoryItems, LiveEntries, ThreadScroller, TranscriptSkeleton, TurnError } from "./Thread";
import { UiDialog } from "./UiDialog";

export type ChatRefusal = "busy" | "recent";

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
  onRefused(kind: ChatRefusal, message: string): void;
  onSettled(): void;
}) {
  const [items, setItems] = createSignal<TranscriptItem[] | null>(null);
  const [live, setLive] = createStore<LiveState>(emptyLive());
  const [syncing, setSyncing] = createSignal(false);
  const [errors, setErrors] = createSignal<string[]>([]);
  const [dialogs, setDialogs] = createSignal<{ id: string; request: unknown }[]>([]);
  const [resume, setResume] = createSignal(0);
  const [everOpened, setEverOpened] = createSignal(false);

  const resync = async () => {
    setSyncing(true);
    try {
      const next = await fetchTranscript(props.path);
      batch(() => {
        setItems(next);
        setLive(reconcile(emptyLive()));
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

  /** Puts prompts the server never accepted back into the draft, so nothing typed is lost. */
  const restoreUnsent = () => {
    const unsent = live.entries.flatMap((e) => (e.kind === "user" && !e.confirmed ? [e.text] : []));
    if (unsent.length === 0) return;
    const current = drafts.get(props.path);
    drafts.set(props.path, [...unsent, ...(current ? [current] : [])].join("\n\n"));
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
          props.onModel(msg.model);
          break;
        case "event":
          queue.push(msg.event);
          if (!frame) frame = requestAnimationFrame(flush);
          break;
        case "ui_request": {
          const req = isObj(msg.request) ? msg.request : {};
          if (!req.fireAndForget) setDialogs((d) => [...d, { id: msg.id, request: msg.request }]);
          else if (req.method === "notify" && str(req.message)) toast(str(req.message)!);
          // setStatus is TUI chrome (and ANSI-coded); nothing to show.
          break;
        }
        case "error":
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
    return null;
  };

  const send = (text: string, steer: boolean) => {
    if (!socket.send({ type: steer ? "steer" : "prompt", text })) return false;
    batch(() => {
      addPendingPrompt(setLive, text);
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
        banner={<ConnectionBanner socket={socket} />}
      >
        <Show when={items()} fallback={<TranscriptSkeleton />}>
          {(list) => (
            <>
              <HistoryItems items={list()} author={props.author} streaming={live.running} />
              <LiveEntries live={live} author={props.author} />
              {/* Model/thinking info rows alone don't count as a conversation. */}
              <Show when={live.entries.length === 0 && !list().some((i) => i.kind !== "info")}>
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
        running={live.running}
        stopping={live.stopping}
        detail={live.activity ?? runDetail(live)}
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
