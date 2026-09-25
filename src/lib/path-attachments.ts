// Image paths named in transcript text (in /tmp, or a session's attachments folder) (TranscriptItem.attachments, the images spec "Path
// attachments"). Inline chips come in two builds that must match: an HTML string for markdown
// (lib/markdown.ts) and a Solid component for plain text (components/PathAttachment.tsx).

import type { TmpAttachment } from "../../shared/protocol";
import { findTmpImagePaths, isPiClipboardName } from "../../shared/tmp-paths";
import { copyText, openLightbox } from "./ui-state";
import { routeUrl } from "./mesh";

/** Where the browser gets the bytes. It never reads /tmp itself. */
export const attachmentUrl = (path: string) => routeUrl(`/api/attachment?path=${encodeURIComponent(path)}`);

/** `KB` under 1 MB, rounded; otherwise one decimal (same format as composer attachments). */
export const fileSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** pi's clipboard names keep 4 characters of the uuid: "pi-clipboard-a587….png". Others as-is. */
export function shortName(name: string): string {
  if (!isPiClipboardName(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = name.slice(0, dot);
  const cut = stem.length - 36 + 4; // keep the prefix and the uuid's first 4
  return `${stem.slice(0, cut)}…${name.slice(dot)}`;
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * A user row's display text without the paths pi (or Sova's upload) inserted, since the
 * attachment unit stands in for them; typed paths stay. Client twin of the server's
 * inlineTmpImages(text, true), so an optimistic row reads the same after the refetch.
 */
export function stripPastedPaths(text: string): string {
  let shown = text;
  const cut = findTmpImagePaths(text).filter((m) => isPiClipboardName(baseName(m.path)));
  if (cut.length === 0) return text;
  for (const { start, end } of cut.reverse()) {
    let a = start;
    let b = end;
    while (a > 0 && (shown[a - 1] === " " || shown[a - 1] === "\t")) a--;
    while (b < shown.length && (shown[b] === " " || shown[b] === "\t")) b++;
    shown = shown.slice(0, a) + "\u0000" + shown.slice(b);
  }
  return shown.replace(/^\u0000+|\u0000+$/gm, "").replace(/\u0000+/g, " ").trim();
}

/** The one "gone" note, also used by the user-row unit. Says nothing about where the file lived:
    the same note covers a cleaned /tmp and a deleted attachments folder. */
export const MISSING_NOTE = "No longer on disk";

/** Accessible name and title for an inline chip. */
export function chipLabels(a: TmpAttachment): { label: string; title: string } {
  return a.available
    ? { label: `Open image ${a.name}`, title: a.path }
    : { label: `Copy path ${a.path}, ${MISSING_NOTE.toLowerCase()}`, title: `${a.path} · ${MISSING_NOTE}. Select to copy the path.` };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The chip as escaped HTML, for markdown. Clicks are handled by activatePathChip. */
export function chipHtml(a: TmpAttachment): string {
  const { label, title } = chipLabels(a);
  return (
    `<button type="button" class="path-chip${a.available ? "" : " path-chip-missing"}" data-path-chip="${escapeHtml(a.path)}"` +
    `${a.available ? ' data-available aria-haspopup="dialog"' : ""} aria-label="${escapeHtml(label)}" title="${escapeHtml(title)}">` +
    `<span class="icon icon-sm" style="--icon: url(/icons/image.svg)" aria-hidden="true"></span>` +
    `<span class="path-chip-name">${escapeHtml(shortName(a.name))}</span>` +
    `${a.available ? "" : `<span class="path-chip-note">· ${MISSING_NOTE}</span>`}</button>`
  );
}

/** A chip was clicked: open the image, or copy the path of a file that's gone. */
export function activatePathChip(chip: HTMLElement): void {
  const path = chip.dataset.pathChip;
  if (!path) return;
  if (chip.hasAttribute("data-available")) {
    openLightbox([{ src: attachmentUrl(path), alt: `Attachment ${baseName(path)}` }], 0, chip);
  } else {
    void copyText(path, "Copied path.");
  }
}
