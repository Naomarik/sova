import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { OutboundImage } from "../../shared/protocol";
import {
  ACCEPTED_TYPES,
  acceptImages,
  dragHasAcceptedImage,
  encodeImages,
  releaseImage,
  type PendingImage,
  type RejectedFile,
} from "../lib/images";
import { announce, draftImages, drafts } from "../lib/ui-state";
import { Icon, type IconName } from "./ui";

export interface ComposerReason {
  icon: IconName;
  text: string;
}

/** `KB` under 1 MB, rounded; otherwise one decimal. */
const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Prompt input (DESIGN_NOTES §4, §4b). Enter sends, Shift+Enter adds a newline. While `running`,
 * Send becomes Steer and Stop Turn appears. `readOnly` disables the textarea and hides Send;
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
  autofocus?: boolean;
  /** `dataUrls` are the same images, for the optimistic bubble and for restoring on refusal. */
  onSend(text: string, steer: boolean, images: OutboundImage[], dataUrls: string[]): boolean;
  onAbort(): void;
}) {
  const [text, setText] = createSignal(drafts.get(props.path) ?? "");
  const [images, setImagesSignal] = createSignal<PendingImage[]>(draftImages.get(props.path) ?? []);
  const [rejected, setRejected] = createSignal<RejectedFile[]>([]);
  const [drop, setDrop] = createSignal<"active" | "reject" | null>(null);
  const [encoding, setEncoding] = createSignal(false);
  let input!: HTMLTextAreaElement;
  let picker: HTMLInputElement | undefined;
  let list: HTMLUListElement | undefined;

  const setDraft = (v: string) => {
    setText(v);
    if (v) drafts.set(props.path, v);
    else drafts.delete(props.path);
  };
  const setImages = (next: PendingImage[]) => {
    setImagesSignal(next);
    if (next.length) draftImages.set(props.path, next);
    else draftImages.delete(props.path);
  };

  const reason = () => props.readOnly ?? props.blocked ?? null;
  /** TUI-live, connecting, reconnecting: nothing attaches and nothing sends. */
  const disabled = () => !!reason();
  const canSend = () => !disabled() && !encoding() && (text().trim().length > 0 || images().length > 0);

  /** The single entry point for picker, paste, and drop. */
  const addFiles = (files: File[], pasted = false) => {
    if (disabled() || files.length === 0) return;
    const result = acceptImages(files, images().length, pasted);
    const said: string[] = [];
    if (result.added.length) {
      setImages([...images(), ...result.added]);
      said.push(`${result.added.length} ${result.added.length === 1 ? "image" : "images"} attached.`);
    }
    if (result.rejected.length) {
      setRejected([...rejected(), ...result.rejected]);
      for (const r of result.rejected) said.push(`${r.name} wasn't attached. ${r.reason}.`);
    }
    // One announcement: the live region only speaks its latest text.
    if (said.length) announce(said.join(" "));
  };

  /** After Remove/Dismiss: the next item's button, else the previous one's, else the textarea. */
  const focusAfterRemoval = (index: number) =>
    queueMicrotask(() => {
      const buttons = list?.querySelectorAll<HTMLButtonElement>(".attachment .button-icon") ?? [];
      (buttons[index] ?? buttons[index - 1] ?? input).focus();
    });
  const remove = (p: PendingImage, index: number) => {
    releaseImage(p);
    setImages(images().filter((x) => x.id !== p.id));
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
  onMount(() => {
    // After the frame, so a closing dialog's focus handling has already run.
    if (props.autofocus && !props.readOnly) requestAnimationFrame(() => input.focus());
  });

  const send = async (e?: Event) => {
    e?.preventDefault();
    if (!canSend()) return;
    const pending = images();
    setEncoding(true);
    let encoded: Awaited<ReturnType<typeof encodeImages>>;
    try {
      encoded = await encodeImages(pending);
    } catch {
      setEncoding(false);
      announce("Couldn't read the attached images. Nothing was sent.");
      return;
    }
    setEncoding(false);
    if (props.onSend(text().trim(), props.running, encoded.outbound, encoded.dataUrls)) {
      pending.forEach(releaseImage);
      setDraft("");
      setImages([]);
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
        <Show when={props.running}>
          <p class="run-status">
            <span class="live-dot" />
            <Show when={!props.stopping} fallback="Stopping…">
              Working
              <Show when={props.detail}>
                <span class="run-status-detail">· {props.detail}</span>
              </Show>
            </Show>
          </p>
        </Show>

        <Show when={images().length > 0 || rejected().length > 0}>
          <ul class="attachments" aria-label="Attachments" ref={list}>
            <For each={images()}>
              {(img, i) => (
                <li class="attachment">
                  <img class="attachment-thumb" src={img.previewUrl} alt="attachment" />
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
          <Show when={!props.readOnly}>
            <button
              type="button"
              class="button button-icon button-ghost"
              aria-label="Attach Images"
              aria-describedby="composer-reason"
              aria-disabled={disabled() ? "true" : undefined}
              onClick={() => !disabled() && picker?.click()}
            >
              <Icon name="attach" />
            </button>
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
            placeholder={props.running ? "Steer the current turn…" : "Ask pi to…"}
            aria-describedby="composer-reason"
            value={text()}
            disabled={!!props.readOnly}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onPaste={(e) => {
              const files = [...(e.clipboardData?.files ?? [])];
              if (files.length === 0) return;
              // A paste with text keeps its text; the files are ours either way.
              if (!e.clipboardData?.getData("text/plain")) e.preventDefault();
              addFiles(files, true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) void send(e);
            }}
          />
          <div class="composer-actions">
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
                <Icon name="pause" small />
                <span class="button-label">Stop Turn</span>
              </button>
            </Show>
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
          </div>
        </div>

        <div class="composer-foot">
          <span class="composer-reason" id="composer-reason">
            <Show when={reason()}>
              {(r) => (
                <>
                  <Icon name={r().icon} small />
                  {r().text}
                </>
              )}
            </Show>
          </span>
          <Show when={!props.readOnly}>
            <span class="composer-hint">
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
            </span>
          </Show>
        </div>
      </form>
    </footer>
  );
}
