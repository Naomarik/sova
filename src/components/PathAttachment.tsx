import { createMemo, createSignal, For, Show } from "solid-js";
import type { TmpAttachment } from "../../shared/protocol";
import { findTmpImagePaths } from "../../shared/tmp-paths";
import { activatePathChip, attachmentUrl, chipLabels, fileSize, MISSING_NOTE, shortName } from "../lib/path-attachments";
import { ImageStrip } from "./ImageStrip";
import { Icon } from "./ui";

/**
 * An image a user message or tool result names by path.
 * Collapsed; the image is requested only once opened. A file /tmp no longer has is a plain row
 * that says so.
 */
export function PathAttachment(props: { attachment: TmpAttachment; where: string }) {
  const [open, setOpen] = createSignal(false);
  const a = () => props.attachment;
  return (
    <Show
      when={a().available}
      fallback={
        <div class="message-attachment message-attachment-missing" title={a().path}>
          <Icon name="image" small />
          <span class="disclosure-label">Attachment</span>
          <span class="message-attachment-name">{a().name}</span>
          <span class="message-attachment-meta">
            · {a().size !== undefined ? `Too large to show · ${fileSize(a().size!)}` : MISSING_NOTE}
          </span>
        </div>
      }
    >
      <details class="disclosure message-attachment" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary class="disclosure-summary" title={a().path}>
          <Icon name="chevron-right" small class="icon-twist" />
          <Icon name="image" small />
          <span class="disclosure-label">Attachment</span>
          <span class="message-attachment-name">{a().name}</span>
          <Show when={a().size !== undefined}>
            <span class="message-attachment-meta">· {fileSize(a().size!)}</span>
          </Show>
        </summary>
        <Show when={open()}>
          <div class="message-attachment-body">
            <ImageStrip images={[attachmentUrl(a().path)]} where={props.where} noun={`Attachment ${a().name}`} />
          </div>
        </Show>
      </details>
    </Show>
  );
}

/** The inline chip, same markup as lib/path-attachments chipHtml (used by markdown). */
function PathChip(props: { attachment: TmpAttachment }) {
  const a = () => props.attachment;
  const labels = () => chipLabels(a());
  return (
    <button
      type="button"
      class="path-chip"
      classList={{ "path-chip-missing": !a().available }}
      data-path-chip={a().path}
      data-available={a().available ? "" : undefined}
      aria-haspopup={a().available ? "dialog" : undefined}
      aria-label={labels().label}
      title={labels().title}
      onClick={(e) => activatePathChip(e.currentTarget)}
    >
      <Icon name="image" small />
      <span class="path-chip-name">{shortName(a().name)}</span>
      <Show when={!a().available}>
        <span class="path-chip-note">· {MISSING_NOTE}</span>
      </Show>
    </button>
  );
}

/** Plain text with its attachments' paths shown as chips (paths in code stay text). */
export function PathText(props: { text: string; attachments?: TmpAttachment[] }) {
  const parts = createMemo(() => {
    const byPath = new Map((props.attachments ?? []).map((a) => [a.path, a] as const));
    if (byPath.size === 0) return [props.text];
    const out: (string | TmpAttachment)[] = [];
    let at = 0;
    for (const m of findTmpImagePaths(props.text)) {
      const a = byPath.get(m.path);
      if (!a) continue;
      out.push(props.text.slice(at, m.start), a);
      at = m.end;
    }
    out.push(props.text.slice(at));
    return out;
  });
  return <For each={parts()}>{(part) => (typeof part === "string" ? part : <PathChip attachment={part} />)}</For>;
}
