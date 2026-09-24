// Putting a forked message into the NEW session's composer.
//
// THE RULE THAT MATTERS: the child never borrows the source's files. Every image is COPIED into
// the child session's own attachments — paths are fetched and re-uploaded, stored bytes are
// uploaded — and the draft's text is rewritten to name the copies. Staging the source's own path
// instead would hand the child a file the SOURCE transcript still references, and the composer
// chip's Remove deletes by path (server/attachments.ts `deleteAttachment` allows anything under
// the attachments root): removing that chip in the fork would delete the picture out of the
// message it was forked from. Silent, permanent loss in the original session — which is why
// nothing here ever reuses a source path.
//
// What can't be copied is counted and said out loud (`forkSentence`); nothing is dropped quietly,
// because a composer that looks complete and fails at send is the worse failure.

import { uploadImage, type ForkEditor } from "./api";
import { attachmentUrl } from "./path-attachments";
import { isPiClipboardName } from "../../shared/tmp-paths";
import { draftAttachments, drafts, setDraftAttachments, setDraftText } from "./ui-state";
import { forkDraft, type ForkStage } from "./message-actions";
import type { SessionSummary, TmpAttachment, UploadResult } from "../../shared/protocol";
import { sessionHref } from "../components/Sidebar";

/** A `data:<mime>;base64,<payload>` image as a File, or null when it isn't one. */
export function fileFromDataUrl(url: string, name: string): File | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const [, mime, base64, payload] = match;
  try {
    const text = base64 ? atob(payload!) : decodeURIComponent(payload!);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return new File([bytes], name, { type: mime || "image/png" });
  } catch {
    return null;
  }
}

const extensionOf = (mime: string) => (mime.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "") || "png";
const mimeOfDataUrl = (url: string) => url.slice(5).split(/[;,]/)[0] || "image/png";

/** What staging will try to copy, decided before anything is written. */
export interface StagePlan {
  /** Source paths whose file is readable: fetched, then uploaded into the child. */
  paths: TmpAttachment[];
  /** Stored image bytes: uploaded into the child. */
  bytes: string[];
  /** Paths whose file isn't readable, so there is nothing to copy. Counted, never staged. */
  lost: number;
}

/**
 * What a fork can bring, from the two channels the server sends: `attachments` are the image PATHS
 * the message's text named, and `images` are the stored `ImageContent` BYTES the model saw.
 *
 * BOTH are taken. An earlier version suppressed the bytes whenever a readable path existed, on the
 * assumption that they were the same picture — but nothing here can check that assumption, and
 * where it is wrong the bytes vanish uncounted, so the sentence claims a clean fork. Identity is
 * PROVED instead, by comparing the copied content (`stageFork`): a duplicate is dropped because it
 * is one, and everything else arrives.
 *
 * A path whose file isn't readable is counted and never staged: it cannot be copied, and giving
 * the child the dead path instead would put a chip in the composer that fails at send.
 */
export function stagePlan(editor: ForkEditor | undefined): StagePlan {
  const attachments = editor?.attachments ?? [];
  const paths = attachments.filter((a) => a.available !== false);
  return { paths, bytes: editor?.images ?? [], lost: attachments.length - paths.length };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Removes generated attachment references the child doesn't own — and only those. Every other
 * byte of the message survives: indentation, tabs, runs of spaces, blank lines, fenced code.
 *
 * Two local tidies, both scoped to the reference itself rather than to the text as a whole: the
 * horizontal whitespace that immediately preceded a path goes with it, so a path removed from the
 * middle of a sentence doesn't leave a double space; and a line that existed ONLY to carry such a
 * path is dropped rather than left as a blank. A line that merely mentioned one keeps its own
 * text and its own spacing exactly as it was.
 */
export function stripPaths(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const before = text.split("\n");
  const touched = new Set<number>();
  const after = before.map((line, i) => {
    let next = line;
    for (const p of paths) {
      if (!next.includes(p)) continue;
      touched.add(i);
      next = next.replace(new RegExp(`[ \\t]*${escapeRe(p)}`, "g"), "");
    }
    return next;
  });
  return after.filter((line, i) => !(touched.has(i) && line.trim() === "" && before[i]!.trim() !== "")).join("\n");
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * How `stageFork` reaches the world; swapped in tests, so the copying rules can be driven.
 *
 * The draft writes are here too, and deliberately: the invariant that protects the source session
 * is about WHAT LANDS IN THE DRAFT, so a test has to be able to see that. Asserting only on what
 * was uploaded would pass a version that uploaded a copy and then staged the source's path anyway.
 */
export interface StageDeps {
  /** The bytes behind a source path (GET /api/attachment), or null when it can't be read. */
  read(path: string): Promise<File | null>;
  /** Uploads into THIS session's own attachments folder (POST /api/upload?draft=). */
  upload(file: File, sessionPath: string): Promise<UploadResult>;
  /** The forked message's text, ahead of whatever is already drafted there. */
  setText(target: string, text: string): void;
  /** The staged files, added to the target's draft. Every one is a copy the child owns. */
  setAttachments(target: string, files: UploadResult[]): void;
}

/**
 * The bytes behind a source path, as a File ready to re-upload. The URL comes from
 * `attachmentUrl`, the one place that string is written — the browser never reads /tmp itself, and
 * a second copy of the query shape here would be a second thing to keep in step.
 */
async function readAttachment(path: string): Promise<File | null> {
  const res = await fetch(attachmentUrl(path));
  if (!res.ok) return null;
  const blob = await res.blob();
  return new File([blob], path.split("/").pop() || "image.png", { type: blob.type || "image/png" });
}

const realDeps: StageDeps = {
  read: readAttachment,
  upload: uploadImage,
  setText: (target, text) => setDraftText(target, forkDraft(text, drafts.get(target) ?? "")),
  setAttachments: (target, files) => setDraftAttachments(target, [...draftAttachments(target), ...files]),
};

/**
 * Stages a fork's message into `target`'s draft: its text, and a COPY of every image it can take.
 * Returns what actually landed, so the caller's sentence counts copies made rather than what the
 * server offered.
 *
 * A failure never touches the source — nothing here writes to it — and never leaves a reference to
 * it either: a path that couldn't be copied comes out of the draft's text and is counted, so the
 * composer holds no name for a file the child doesn't own. Copies that already succeeded are kept;
 * they belong to the child now, and are the only things a cleanup could ever remove.
 */
export async function stageFork(target: string, editor: ForkEditor | undefined, deps: StageDeps = realDeps): Promise<ForkStage> {
  const stage: ForkStage = { text: false, carried: 0, lost: 0 };
  if (!editor) return stage;
  const plan = stagePlan(editor);
  stage.lost = plan.lost;
  const files: UploadResult[] = [];
  const copied: Uint8Array[] = [];
  /** Source path → the child's own copy, for rewriting the text that names it. */
  const moved = new Map<string, string>();
  /**
   * Source paths with no copy in the child. A GENERATED name (pi's clipboard paste, a Sova
   * upload) comes out of the text: it is a reference the composer would otherwise re-send for a
   * file the child doesn't have. A path the USER TYPED stays, whatever happened to the file —
   * that is their sentence, not a generated reference, and editing someone's message to tidy up
   * our own bookkeeping is not ours to do. Same predicate the server strips by.
   */
  const dead = (editor.attachments ?? []).filter((a) => a.available === false && isPiClipboardName(a.name)).map((a) => a.path);

  for (const a of plan.paths) {
    const file = await deps.read(a.path).catch(() => null);
    if (!file) {
      stage.lost++;
      if (isPiClipboardName(a.name)) dead.push(a.path);
      continue;
    }
    try {
      const up = await deps.upload(file, target);
      files.push(up);
      copied.push(new Uint8Array(await file.arrayBuffer()));
      moved.set(a.path, up.path);
      stage.carried++;
    } catch {
      // The 20MB cap, a write that failed: this image did not come along, and the sentence says
      // only that — the states that produce it can't be told apart, so neither do we.
      stage.lost++;
      if (isPiClipboardName(a.name)) dead.push(a.path);
    }
  }

  let n = 0;
  for (const url of plan.bytes) {
    n++;
    const file = fileFromDataUrl(url, `forked-${n}.${extensionOf(mimeOfDataUrl(url))}`);
    if (!file) {
      stage.lost++;
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Proven identity, not assumed: this picture is already in the child as one of the copies
    // above, so uploading it again would put the same image in the composer twice.
    if (copied.some((c) => sameBytes(c, bytes))) continue;
    try {
      files.push(await deps.upload(file, target));
      copied.push(bytes);
      stage.carried++;
    } catch {
      stage.lost++;
    }
  }

  // The text goes in last, naming the child's own copies — and naming nothing it doesn't own.
  //
  // NOTHING ELSE ABOUT IT IS TOUCHED. An earlier version ran every forked message through
  // `line.replace(/[ \t]{2,}/g, " ").trimEnd()` and a final `.trim()` to tidy up after removing a
  // path from mid-line — which quietly collapsed indentation, tabs and deliberate spacing in EVERY
  // fork, including ones with no attachments at all: fenced code came out dedented, aligned
  // columns came out ragged. Tidying our own bookkeeping is never worth rewriting what the user
  // wrote. Replacements are exact substring swaps, removals take only the reference and the
  // horizontal space that introduced it, and a message with neither is byte-for-byte the original.
  if (editor.text) {
    let text = editor.text;
    for (const [from, to] of moved) text = text.split(from).join(to);
    if (dead.length) text = stripPaths(text, dead);
    // Whitespace-only after a removal means the message was nothing but that reference.
    if (text.trim()) {
      deps.setText(target, text);
      stage.text = true;
    }
  }
  if (files.length) deps.setAttachments(target, files);
  return stage;
}

/**
 * Opens a session this tab just made. The app's own adopt path is the right one: it registers the
 * session so the ROUTE resolves before the sidebar's refetch lands, refreshes the list, and moves
 * the hash and the focus together. Setting `location.hash` alone lands on "Couldn't find this
 * session." until the next list poll — verified end to end, which is the only way this shows up.
 * The bare hash stays as the fallback for a caller with no adopt hook.
 */
export function openCreated(session: SessionSummary, adopt?: (s: SessionSummary) => void): void {
  if (adopt) adopt(session);
  else location.hash = sessionHref(session.path);
}
