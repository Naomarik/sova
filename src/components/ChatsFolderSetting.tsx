import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { ChatsFolderPreview } from "../../shared/chats-folder";
import { cancelChatsFolderMove, moveChatsFolder, previewChatsFolder } from "../lib/api";
import { chatsFolderInfo, folderMissing, liveSyncWarning, MISSING_TITLE, missingBody, moveFraction, moveProgressLine, moveRunning, previewLine, refreshChatsFolder } from "../lib/chats-folder";
import { relativeTime, tildePath } from "../lib/format";
import { home } from "../lib/ui-state";
import { FolderPicker } from "./FolderPicker";
import { Banner, trapFocus } from "./ui";
import "./ChatsFolderSetting.css";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** The folder holding `p`: where Change… starts browsing, beside the chats folder in force. */
const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";

/** Read again every 500 ms while a move runs, else once. */
function usePolling(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gone = false;
  const tick = async () => {
    const i = await refreshChatsFolder();
    if (gone) return;
    timer = setTimeout(tick, moveRunning(i?.move) ? 500 : 30_000);
  };
  onMount(() => void tick());
  onCleanup(() => {
    gone = true;
    clearTimeout(timer);
  });
}

/**
 * Settings → General's **Chats folder** row, in "Chats · this computer" (§app.chat-homes/chats-folder): the folder every
 * chat's home is in, and Change…, which moves them all to another. Set by a variable, the row says so and offers no
 * Change…. A folder that is missing, a move that runs, stopped partway or failed, each says so here.
 */
export function ChatsFolderRow() {
  usePolling();
  const [open, setOpen] = createSignal<string | null>(null);
  const info = chatsFolderInfo;
  const move = () => info()?.move;
  const shown = (p: string) => tildePath(p, home());
  return (
    <div class="settings-field chats-folder" role="group" aria-labelledby="chats-folder-label">
      <div class="chats-folder-row">
        <div class="chats-folder-main">
          <span class="field-label" id="chats-folder-label">
            Chats folder
          </span>
          <Show when={info()} fallback={<span class="text-muted">Reading…</span>}>
            {(i) => <code class="chats-folder-path">{shown(i().path)}</code>}
          </Show>
        </div>
        <Show when={info() && !info()!.locked}>
          <button type="button" class="button" onClick={() => setOpen(info()!.move?.phase === "interrupted" ? info()!.move!.to : parentOf(info()!.path))}>
            Change…
          </button>
        </Show>
      </div>
      <Show when={info()}>
        {(i) => (
          <p class="field-hint">
            <Show when={i().source === "env"} fallback="Every chat's home is kept here, its helpers' conversations and records with it. Chats from before chat homes stay in pi's own folder.">
              {i().locked}
            </Show>
          </p>
        )}
      </Show>
      <Show when={folderMissing(info())}>
        <Banner tone="warn" title={MISSING_TITLE} body={missingBody(shown(info()!.path))} />
      </Show>
      <Show when={moveRunning(move()) && !open()}>
        <p class="field-hint" role="status">
          Moving your chats to <code>{shown(move()!.to)}</code>. {moveProgressLine(move()!)}
        </p>
      </Show>
      <Show when={move()?.phase === "interrupted"}>
        <Banner
          tone="warn"
          title="The move stopped partway."
          body={
            <>
              Sova stopped while your chats were being copied to <code>{shown(move()!.to)}</code>. They're still in <code>{shown(move()!.from)}</code>, and Resume Move goes on from the files already checked.
            </>
          }
          action={
            <button type="button" class="button button-sm" onClick={() => setOpen(move()!.to)}>
              Resume Move
            </button>
          }
        />
      </Show>
      <Show when={move()?.phase === "failed"}>
        <Banner tone="error" title="Your chats didn't move." body={move()!.error} />
      </Show>
      <Show when={move()?.phase === "done" && move()!.finishedAt}>
        <p class="field-hint">
          Moved from <code>{shown(move()!.from)}</code> {relativeTime(move()!.finishedAt!)}. That folder is still there, untouched; delete it yourself once you've checked your chats.
        </p>
      </Show>
      <Show when={open() !== null}>
        <ChatsFolderDialog start={open()!} onClose={() => setOpen(null)} />
      </Show>
    </div>
  );
}

/**
 * "Move your chats to this folder?": the folder being browsed is the choice, read at once (how many chats, how big,
 * free space, a live-sync service, or why it can't); Move Chats starts the move, and the dialog shows it to its end.
 * Cancel stops it before the switch.
 */
function ChatsFolderDialog(props: { start: string; onClose: () => void }) {
  const [folder, setFolder] = createSignal(props.start);
  const [preview, setPreview] = createSignal<ChatsFolderPreview | null>(null);
  const [picking, setPicking] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [started, setStarted] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const move = () => chatsFolderInfo()?.move;
  const mine = () => started() && !!move();
  let gone = false;
  onCleanup(() => (gone = true));
  let seq = 0;
  const pick = (path: string) => {
    setFolder(path);
    setError(null);
    const at = ++seq;
    setPreview(null);
    void previewChatsFolder(path).then(
      (p) => at === seq && setPreview(p),
      (err) => at === seq && setError(errText(err)),
    );
  };
  const ready = () => {
    const p = preview();
    return p && !p.refusal ? p : null;
  };
  const start = async () => {
    const p = ready();
    if (!p || sending()) return;
    setSending(true);
    setError(null);
    try {
      await moveChatsFolder(folder());
      setStarted(true);
      // Its progress, every 500 ms until it ends (the row reads it too, on its own clock).
      for (;;) {
        const i = await refreshChatsFolder();
        if (gone || !moveRunning(i?.move)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setSending(false);
    }
  };
  const cancel = async () => {
    try {
      await cancelChatsFolderMove();
      await refreshChatsFolder();
    } catch (err) {
      setError(errText(err));
    }
  };
  const running = () => mine() && moveRunning(move());
  const close = () => {
    if (running()) return;
    props.onClose();
  };
  const shown = (p: string) => tildePath(p, home());
  return (
    <Portal>
      <div class="scrim chats-folder-scrim" onClick={close} />
      <div
        class="modal chats-folder-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chats-folder-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="chats-folder-title">
            Move your chats to this folder?
          </h2>
        </div>
        <div class="modal-body stack">
          <Show
            when={!mine()}
            fallback={
              <div class="chats-folder-progress" role="status" aria-live="polite">
                <Show when={move()}>
                  {(m) => (
                    <>
                      <p>
                        To <code>{shown(m().to)}</code>
                      </p>
                      <Show when={moveRunning(m())}>
                        <div class="meter">
                          <p class="meter-head">
                            <span class="meter-label">{moveProgressLine(m())}</span>
                            <span class="meter-value">{moveFraction(m())}%</span>
                          </p>
                          <div class="meter-track" aria-hidden="true">
                            <span class="meter-fill" style={{ width: `${moveFraction(m())}%` }} />
                          </div>
                          <p class="meter-context">
                            {m().chats} {m().chats === 1 ? "chat" : "chats"} · every chat stopped until the move is done
                          </p>
                        </div>
                      </Show>
                      <Show when={m().phase === "done"}>
                        <Banner
                          tone="success"
                          title={`Your chats are in ${shown(m().to)} now.`}
                          body={m().error ? `${m().error}` : `They open from there. The old folder, ${shown(m().from)}, is still there with nothing deleted.`}
                        />
                      </Show>
                      <Show when={m().phase === "cancelled"}>
                        <Banner tone="info" title="Move cancelled." body={`Your chats stay in ${shown(m().from)}, and the partial copy is gone.`} />
                      </Show>
                      <Show when={m().phase === "failed"}>
                        <Banner tone="error" title="Your chats didn't move." body={m().error} />
                      </Show>
                    </>
                  )}
                </Show>
              </div>
            }
          >
            <p class="field-hint">Choose a folder on this computer. Every chat stops while its files are copied and checked, then opens from the new folder. Nothing in the old folder is deleted.</p>
            <Show
              when={picking()}
              fallback={
                <>
                  <p class="text-mono chats-folder-picked">{shown(folder())}</p>
                  <button type="button" class="button button-sm chats-folder-again" onClick={() => setPicking(true)}>
                    Choose Another Folder
                  </button>
                </>
              }
            >
              <FolderPicker start={folder()} recents={[]} onPick={pick} onClose={() => setPicking(false)} />
            </Show>
            <div aria-live="polite" class="stack-2">
              <Show when={preview()}>
                {(p) => (
                  <>
                    <p class="chats-folder-target">
                      <span class="field-label">New folder</span>
                      <code>{shown(p().target)}</code>
                    </p>
                    <Show when={!p().refusal || p().chats > 0}>
                      <p class="field-hint">{previewLine(p())}</p>
                    </Show>
                    <Show when={p().liveSync && !p().refusal}>
                      <Banner tone="warn" title={liveSyncWarning(p().liveSync!)} />
                    </Show>
                    <Show when={p().refusal}>
                      <p class="field-error">{p().refusal}</p>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </Show>
          <Show when={error()}>
            <p class="field-error">{error()}</p>
          </Show>
        </div>
        <div class="modal-foot">
          <span class="modal-spacer" />
          <Show
            when={!mine()}
            fallback={
              <Show
                when={running()}
                fallback={
                  <button type="button" class="button button-primary" onClick={() => props.onClose()}>
                    Done
                  </button>
                }
              >
                <button type="button" class="button button-ghost" disabled={move()?.phase === "switching"} onClick={() => void cancel()}>
                  Cancel Move
                </button>
              </Show>
            }
          >
            <button type="button" class="button button-ghost" onClick={() => props.onClose()}>
              Cancel
            </button>
            <button type="button" class="button button-primary" disabled={!ready() || sending()} aria-busy={sending() ? "true" : undefined} onClick={() => void start()}>
              Move Chats
            </button>
          </Show>
        </div>
      </div>
    </Portal>
  );
}

/** The chat list's warning when the chats folder is missing (instead of a list that looks empty). */
export function ChatsFolderMissing() {
  usePolling();
  return (
    <Show when={folderMissing(chatsFolderInfo())}>
      <div class="transcript-banner">
        <Banner tone="warn" title={MISSING_TITLE} body={missingBody(tildePath(chatsFolderInfo()!.path, home()))} />
      </div>
    </Show>
  );
}
