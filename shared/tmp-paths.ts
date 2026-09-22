// Image paths found in message text (TranscriptItem.attachments): directly in /tmp, or in a
// session's folder under Sova's attachments root (<agent dir>/sova/attachments/<session id>/, or the
// legacy pi-web spelling from before the rename — transcripts are never rewritten, so both tails are
// recognised forever). Pure: the server uses it to detect them, the client to place inline chips in
// plain text. No fs here, and no agent dir: the client doesn't know it, so an attachments path is
// recognised by its tail; the server's checkTmpImage then decides whether it really sits under this
// machine's root (re-anchoring legacy paths there).

/** A file name directly in /tmp: no separators, no leading dot, image extension. */
const NAME = String.raw`[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif)`;
/** A session id (sessions-index idOf: the uuidv7 after the file name's last "_"). No dots, so never "..". */
export const SESSION_ID = String.raw`[A-Za-z0-9][A-Za-z0-9-]*`;
/** Exactly `/tmp/<name>`, nothing more. */
export const TMP_IMAGE_PATH = new RegExp(`^/tmp/${NAME}$`, "i");
/** Exactly `<id>/<name>`: what may follow the attachments root. */
export const ATTACHMENT_TAIL = new RegExp(`^${SESSION_ID}/${NAME}$`, "i");
/** Where an attachments root ends, as seen in a path: stateRoot()/legacyStateRoot() + "attachments". */
const ROOT_TAILS = ["/sova/attachments/", "/pi-web/attachments/"] as const;
const ROOT_TAIL_ALT = String.raw`(?:/sova/attachments/|/pi-web/attachments/)`;
/** Standalone: not part of a longer path on either side; a trailing "." ends a sentence. An
    attachments path is any absolute path ending in the root's tail, then `<id>/<name>`; "~" is
    also refused before it, so "~/.pi/…" isn't read as "/.pi/…". */
const TOKEN = String.raw`(?<![\w./-])(?:/tmp/${NAME}|(?<!~)(?:/[\w.-]+)*${ROOT_TAIL_ALT}${SESSION_ID}/${NAME})(?![\w/-]|\.\w)`;
/** Generated upload/paste names: pi's own (interactive-mode handleClipboardPaste,
    utils/clipboard-image) and Sova's POST /api/upload — `sova-<uuid>` now, `pi-web-<uuid>` before
    the rename. Both strip/label the same (a generated reference, never a typed name). */
const PI_CLIPBOARD = /^(?:pi-(?:clipboard|wsl-clip|web)|sova)-[0-9a-f-]{36}\.[a-z]+$/i;

export const isPiClipboardName = (name: string) => PI_CLIPBOARD.test(name);

/** One found path: `text.slice(start, end) === path`. */
export interface TmpPathMatch {
  path: string;
  start: number;
  end: number;
}

/**
 * Blank out markdown code (fenced blocks, ``` or ~~~, open to the end if never closed; inline
 * code spans of any backtick-run length), keeping every offset. A path in code is being talked
 * about, not attached.
 */
function maskCode(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = "\u0001";
  };
  // Fences, line by line.
  let offset = 0;
  let fence: { char: string; len: number; from: number } | null = null;
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.len && line.trim() === m[1]) {
        blank(fence.from, offset + line.length);
        fence = null;
      }
    } else if (m) {
      fence = { char: m[1]![0]!, len: m[1]!.length, from: offset };
    }
    offset += line.length + 1;
  }
  if (fence) blank(fence.from, text.length);
  // Inline spans: a run of n backticks closes at the next run of exactly n.
  const masked = out.join("");
  const run = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = run.exec(masked))) {
    const n = m[0].length;
    const close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, "g");
    close.lastIndex = m.index + n;
    const c = close.exec(masked);
    if (!c) continue; // a lone run is literal backticks
    blank(m.index, c.index + n);
    run.lastIndex = c.index + n;
  }
  return out.join("");
}

/** Every standalone image path (in /tmp or an attachments folder) outside markdown code, in
    order (duplicates included). */
export function findTmpImagePaths(text: string): TmpPathMatch[] {
  if (!text.includes("/tmp/") && !ROOT_TAILS.some((tail) => text.includes(tail))) return [];
  const masked = maskCode(text);
  const re = new RegExp(TOKEN, "gi");
  const found: TmpPathMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) found.push({ path: m[0], start: m.index, end: m.index + m[0].length });
  return found;
}
