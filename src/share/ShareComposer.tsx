import { createEffect, createSignal, For, on, onCleanup, Show, type Accessor } from "solid-js";
import { createStore } from "solid-js/store";
import { createTouchMode } from "../lib/input-mode";
import { composerEnterKeyHint, composerKeySends, composerPlaceholder, countFrom, type SendKey } from "../lib/share-composer";
import { PhotoFormatError, processPhoto, sizeLabel, type UploadRefusal } from "./photos";
import { filesWord } from "./files";

/**
 * The share build's message box (§app.baton/outsider-view, §app.project-assistant/chat): one rounded
 * field holding the pending photos (and files, where a page takes them), then attach · text · Send.
 * Photos are processed on the device and uploaded at once; Send waits for them. The page owns the
 * draft, the error line and what a send does; this owns the attachments, the keys and the field.
 * Share build only: it never imports the operator app's composer.
 */

export interface Limits {
  perMessage: number;
  maxBytes: number;
}
export interface Upload<T extends { id: string }> {
  done: Promise<T>;
  abort(): void;
}
/** A photo or file in the composer. */
export interface Attachment {
  cid: string;
  kind: "photo" | "file";
  name: string;
  size: number;
  /** The processed bytes, kept for a retry or a re-upload after an expiry; null once refused on the device. */
  blob: Blob | null;
  thumb: string | null;
  state: "processing" | "uploading" | "ready" | "failed";
  progress: number;
  id?: string;
  reason?: string;
  abort?: () => void;
}
/** What a send came to: sent (the box empties), kept (the text stays; the page says why), or a
    staged photo or file expired (uploaded again once, then sent again). */
export type SendOutcome = "sent" | "kept" | { expired: "photo" | "file" };

let seq = 0;
const nextCid = () => `a${++seq}`;
const photosWord = (n: number) => (n === 1 ? "1 photo" : `${n} photos`);
const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

export function ShareComposer(props: {
  /** A class beside `share-composer` on the form. */
  class?: string;
  /** The textarea's id (its hidden label points at it). */
  id: string;
  label: string;
  /** The placeholder without a key hint. */
  placeholder: string;
  maxLength: number;
  /** "mod-enter": Ctrl/⌘+Enter sends, the foot says so (hand-off pages). "enter": Enter sends as in
      Sova's own chat (§chat.composer/behavior), the hint is in the placeholder. */
  sendKey: SendKey;
  draft: Accessor<string>;
  setDraft(text: string): void;
  /** The page's error line under the field. */
  error: Accessor<string | null>;
  /** Photos while they can be sent; null: no paperclip, a pasted picture is refused. */
  photos: Accessor<Limits | null>;
  /** Files while they can be sent (hand-off pages only). */
  files?: Accessor<Limits | null>;
  uploadPhoto(blob: Blob, progress: (p: number) => void): Upload<{ id: string }>;
  uploadFile?(blob: Blob, name: string, progress: (p: number) => void): Upload<{ id: string }>;
  /** An upload was refused with this status (a 410: the page is gone). */
  onUploadRefused?(r: UploadRefusal): void;
  /** Send's own state beside the field's: true greys Send (a reply being written, not ready). */
  blocked?: Accessor<boolean>;
  sending: Accessor<boolean>;
  /** Called on Send or a sending key; the page checks its own guards. `again`: the resend after an
      expiry's uploads, which never answers `expired` again. */
  send(text: string, photos: Attachment[], files: Attachment[], again: boolean): Promise<SendOutcome>;
  /** What a pasted picture says when photos can't be sent (absent: the paste is left alone). */
  photosOff?: string;
  /** Called with the input once it exists (the page focuses it or puts a draft in it). */
  ref?(api: { input: HTMLTextAreaElement; fit(): void }): void;
}) {
  const [atts, setAtts] = createStore<Attachment[]>([]);
  const [announce, setAnnounce] = createSignal("");
  const [dropping, setDropping] = createSignal(false);
  const [refusal, setRefusal] = createSignal<string | null>(null);
  const { touch, onPointerDown } = createTouchMode();
  let fileInput: HTMLInputElement | undefined;
  let input: HTMLTextAreaElement | undefined;

  const files = () => props.files?.() ?? null;
  const canAttach = () => !!props.photos() || !!files();
  const patch = (id: string, p: Partial<Attachment>) => setAtts((a) => a.cid === id, p);
  const find = (id: string) => atts.find((a) => a.cid === id);
  const live = () => atts.filter((a) => a.state !== "failed" || a.blob !== null);
  const uploading = () => atts.some((a) => a.state === "processing" || a.state === "uploading");
  const ready = () => atts.filter((a) => a.state === "ready" && a.id);
  const readyOf = (kind: Attachment["kind"]) => ready().filter((a) => a.kind === kind);
  const uploadingFiles = () => atts.some((a) => a.kind === "file" && (a.state === "processing" || a.state === "uploading"));

  const upload = async (id: string): Promise<boolean> => {
    const a = find(id);
    if (!a?.blob) return false;
    const up = a.kind === "file" ? props.uploadFile?.(a.blob, a.name, (p) => patch(id, { progress: p })) : props.uploadPhoto(a.blob, (p) => patch(id, { progress: p }));
    if (!up) return false;
    patch(id, { state: "uploading", progress: 0, reason: undefined, id: undefined, abort: up.abort });
    try {
      const staged = await up.done;
      if (!find(id)) return false;
      patch(id, { state: "ready", id: staged.id, progress: 1, abort: undefined });
      return true;
    } catch (err) {
      const r = err as UploadRefusal;
      if (!find(id) || r.code === "aborted") return false;
      if (r.status) props.onUploadRefused?.(r);
      const reason = r.status ? r.error : "Upload failed.";
      patch(id, { state: "failed", reason, abort: undefined });
      setAnnounce(`${a.name} wasn't attached. ${reason}`);
      return false;
    }
  };

  const addFiles = async (picked: readonly File[], pasted = false) => {
    if (!canAttach() || !picked.length) return;
    let added = 0;
    let addedFiles = 0;
    // One announcement for the whole pick: a later one would replace a refusal before it is read.
    const refused: string[] = [];
    for (const file of picked) {
      const id = nextCid();
      // An image goes the photo path while photos can be sent; anything else is a file (§app.baton/files).
      const limits = props.photos();
      if (!file.type.startsWith("image/") || !limits) {
        const fl = files();
        const name = file.name || (pasted ? "Pasted file" : "File");
        if (!fl) continue;
        const reason = live().filter((a) => a.kind === "file").length >= fl.perMessage ? `Up to ${fl.perMessage} files per message.` : file.size > fl.maxBytes ? `Over ${mb(fl.maxBytes)} MB.` : null;
        if (reason) {
          setAtts(atts.length, { cid: id, kind: "file", name, size: file.size, blob: null, thumb: null, state: "failed", progress: 0, reason });
          refused.push(`${name} wasn't attached. ${reason}`);
          continue;
        }
        setAtts(atts.length, { cid: id, kind: "file", name, size: file.size, blob: file, thumb: null, state: "uploading", progress: 0 });
        addedFiles++;
        void upload(id);
        continue;
      }
      const name = pasted ? "Pasted photo" : file.name || "Photo";
      if (live().filter((a) => a.kind === "photo").length >= limits.perMessage) {
        const reason = `Up to ${limits.perMessage} photos per message.`;
        setAtts(atts.length, { cid: id, kind: "photo", name, size: file.size, blob: null, thumb: null, state: "failed", progress: 0, reason });
        refused.push(`${name} wasn't attached. ${reason}`);
        continue;
      }
      setAtts(atts.length, { cid: id, kind: "photo", name, size: file.size, blob: null, thumb: null, state: "processing", progress: 0 });
      let blob: Blob;
      let preview: string;
      try {
        ({ blob, preview } = await processPhoto(file));
      } catch (err) {
        const reason = err instanceof PhotoFormatError ? err.message : "This photo's format can't be sent.";
        patch(id, { state: "failed", reason });
        refused.push(`${name} wasn't attached. ${reason}`);
        continue;
      }
      if (!find(id)) continue;
      if (blob.size > limits.maxBytes) {
        const reason = `Over ${mb(limits.maxBytes)} MB.`;
        patch(id, { state: "failed", reason });
        refused.push(`${name} wasn't attached. ${reason}`);
        continue;
      }
      patch(id, { blob, size: blob.size, thumb: preview });
      added++;
      void upload(id);
    }
    setAnnounce([...(added ? [`${photosWord(added)} attached.`] : []), ...(addedFiles ? [`${filesWord(addedFiles)} attached.`] : []), ...refused].join(" "));
  };
  const remove = (id: string) => {
    find(id)?.abort?.();
    setAtts((list) => list.filter((x) => x.cid !== id));
  };
  /** What a pick, paste or drop may attach: any file while files can be sent, else images only. */
  const attachable = (list: FileList | null | undefined): File[] => [...(list ?? [])].filter((f) => !!files() || f.type.startsWith("image/"));
  /** A picture pasted or dropped while photos can't be sent. */
  const refuse = () => {
    if (!props.photosOff) return;
    setRefusal(props.photosOff);
    setAnnounce(props.photosOff);
  };
  // A stray drop anywhere else on the page must not navigate away to the file.
  const stray = (e: DragEvent) => {
    if ((canAttach() || props.photosOff) && e.dataTransfer?.types.includes("Files")) e.preventDefault();
  };
  window.addEventListener("dragover", stray);
  window.addEventListener("drop", stray);
  onCleanup(() => {
    window.removeEventListener("dragover", stray);
    window.removeEventListener("drop", stray);
  });

  // The textarea grows with its text from one line up to its CSS max-height, then scrolls.
  const fit = () => {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  };
  createEffect(on(props.draft, () => queueMicrotask(fit)));

  const send = async (e?: Event) => {
    e?.preventDefault();
    const text = props.draft().trim();
    if ((!text && !ready().length) || uploading()) return;
    setRefusal(null);
    let r = await props.send(text, readyOf("photo"), readyOf("file"), false);
    // A staged photo or file expired (a restart, a day's wait): upload them again, once, and resend.
    if (typeof r === "object") {
      const again = readyOf(r.expired);
      const ok = again.length ? await Promise.all(again.map((a) => upload(a.cid))) : [false];
      r = ok.every(Boolean) ? await props.send(text, readyOf("photo"), readyOf("file"), true) : "kept";
      if (typeof r === "object") r = "kept";
    }
    if (r !== "sent") return;
    // The previews now belong to the page's echo; the strip empties.
    setAtts([]);
    props.setDraft("");
  };

  const placeholder = () => composerPlaceholder(props.sendKey, props.placeholder, touch());
  const error = () => refusal() ?? props.error();

  return (
    <form
      class={props.class ? `share-composer ${props.class}` : "share-composer"}
      onSubmit={(e) => void send(e)}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        if (canAttach()) {
          e.preventDefault();
          setDropping(true);
        } else if (props.photosOff) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={(e) => {
        if (!canAttach()) {
          // A picture dropped where none can be sent: say so, and don't open it in the tab.
          if (props.photosOff && e.dataTransfer?.types.includes("Files")) {
            e.preventDefault();
            refuse();
          }
          return;
        }
        e.preventDefault();
        setDropping(false);
        void addFiles(attachable(e.dataTransfer?.files));
      }}
    >
      {/* One field: the pending photos, then attach · text · Send in a row. A click on its padding
          focuses the text, as a plain input would. */}
      <div
        class="share-field"
        classList={{ "share-composer-drop": dropping() }}
        onClick={(e) => {
          if (e.target === e.currentTarget) input?.focus();
        }}
      >
        <Show when={atts.length}>
          <ul class="share-atts" aria-label={atts.some((a) => a.kind === "file") ? "Files to send" : "Photos to send"}>
            <For each={atts}>
              {(a) => (
                <li class="share-att" classList={{ "share-att-failed": a.state === "failed" }}>
                  <Show
                    when={a.thumb}
                    fallback={<span class="icon share-att-icon" classList={{ "share-icon-alert": a.state === "failed", "share-icon-file": a.state !== "failed" }} aria-hidden="true" />}
                  >
                    <img class="share-att-thumb" src={a.thumb!} alt="" />
                  </Show>
                  <span class="share-att-text">
                    <span class="share-att-name" title={a.name}>
                      {a.name}
                    </span>
                    <span class="share-att-meta">
                      {a.state === "failed" ? a.reason : a.state === "processing" ? "Preparing" : a.state === "uploading" ? `Uploading ${Math.round(a.progress * 100)}%` : sizeLabel(a.size)}
                    </span>
                    <Show when={a.state === "uploading"}>
                      <progress class="share-att-progress" max="1" value={a.progress} aria-hidden="true" />
                    </Show>
                  </span>
                  <Show when={a.state === "failed" && a.blob}>
                    <button type="button" class="button button-ghost share-att-retry" aria-label={`Retry ${a.name}`} onClick={() => void upload(a.cid)}>
                      Retry
                    </button>
                  </Show>
                  <button type="button" class="button button-icon button-ghost" aria-label={`Remove ${a.name}`} onClick={() => remove(a.cid)}>
                    <span class="icon share-icon-close" aria-hidden="true" />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <label class="visually-hidden" for={props.id}>
          {props.label}
        </label>
        <div class="share-compose-row">
          <Show when={canAttach()}>
            <button
              type="button"
              class="button button-icon button-ghost share-clip"
              aria-label={files() ? "Attach Files" : "Attach Photos"}
              title={files() ? "Attach Files" : "Attach Photos"}
              onClick={() => fileInput?.click()}
            >
              <span class="icon share-icon-attach" aria-hidden="true" />
            </button>
            <input
              ref={fileInput}
              class="visually-hidden"
              type="file"
              accept={files() ? undefined : "image/*"}
              multiple
              tabindex="-1"
              aria-hidden="true"
              onChange={(e) => {
                const picked = attachable(e.currentTarget.files);
                e.currentTarget.value = "";
                void addFiles(picked);
              }}
            />
          </Show>
          <textarea
            ref={(el) => {
              input = el;
              props.ref?.({ input: el, fit });
            }}
            id={props.id}
            class="share-input"
            rows={1}
            maxlength={props.maxLength}
            placeholder={placeholder()}
            enterkeyhint={composerEnterKeyHint(props.sendKey, touch())}
            aria-describedby={`${props.id}-hint`}
            value={props.draft()}
            onInput={(e) => {
              setRefusal(null);
              props.setDraft(e.currentTarget.value);
            }}
            onPointerDown={(e) => onPointerDown(e)}
            onPaste={(e) => {
              const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
              if (!canAttach()) {
                // A picture where none can be sent: say so, and keep any text the paste carried.
                if (images.length && props.photosOff) {
                  if (!e.clipboardData?.types.includes("text/plain")) e.preventDefault();
                  refuse();
                }
                return;
              }
              const pasted = attachable(e.clipboardData?.files);
              if (!pasted.length) return;
              // A paste with text keeps its text and attaches the image too.
              if (!e.clipboardData?.types.includes("text/plain")) e.preventDefault();
              void addFiles(pasted, true);
            }}
            onKeyDown={(e) => {
              if (!composerKeySends(props.sendKey, e, touch())) return;
              // No newline is left behind by a key that sends.
              e.preventDefault();
              void send();
            }}
          />
          <button
            type="submit"
            class="button button-icon share-send"
            aria-label={props.sending() ? "Sending" : "Send"}
            title={props.sending() ? "Sending" : "Send"}
            aria-disabled={props.sending() || uploading() || props.blocked?.() || (!props.draft().trim() && !ready().length) ? "true" : undefined}
          >
            <span class="icon share-icon-send" aria-hidden="true" />
          </button>
        </div>
      </div>
      <Show when={error()}>
        <p class="field-error" role="alert">
          {error()}
        </p>
      </Show>
      {/* Quiet: the keys only where there is a keyboard to press them (CSS), the count only near the limit. */}
      <p id={`${props.id}-hint`} class="field-hint share-composer-foot">
        <Show when={!uploading()} fallback={<span>{uploadingFiles() ? "Waiting for files to finish." : "Waiting for photos to finish."}</span>}>
          <Show when={props.sendKey === "mod-enter"}>
            <span class="share-hint-keys">Ctrl+Enter sends</span>
          </Show>
          <Show when={props.draft().length >= countFrom(props.maxLength)}>
            <span class="share-hint-count">
              {props.draft().length.toLocaleString("en-US")} of {props.maxLength.toLocaleString("en-US")} characters
            </span>
          </Show>
        </Show>
      </p>
      <p class="visually-hidden" aria-live="polite">
        {announce()}
      </p>
    </form>
  );
}
