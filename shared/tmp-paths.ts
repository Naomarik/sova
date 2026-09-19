// Image paths directly in /tmp, found in message text (TranscriptItem.attachments). Pure: the
// server uses it to detect them, the client to place inline chips in plain text. No fs here.

/** A file name directly in /tmp: no separators, no leading dot, image extension. */
const NAME = String.raw`[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif)`;
/** Exactly `/tmp/<name>`, nothing more. */
export const TMP_IMAGE_PATH = new RegExp(`^/tmp/${NAME}$`, "i");
/** Standalone: not part of a longer path on either side; a trailing "." ends a sentence. */
const TOKEN = String.raw`(?<![\w./-])/tmp/${NAME}(?![\w/-]|\.\w)`;
/** Names pi or pi-web write (interactive-mode handleClipboardPaste, utils/clipboard-image,
    and pi-web's POST /api/upload). */
const PI_CLIPBOARD = /^pi-(?:clipboard|wsl-clip|web)-[0-9a-f-]{36}\.[a-z]+$/i;

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

/** Every standalone /tmp image path outside markdown code, in order (duplicates included). */
export function findTmpImagePaths(text: string): TmpPathMatch[] {
  if (!text.includes("/tmp/")) return [];
  const masked = maskCode(text);
  const re = new RegExp(TOKEN, "gi");
  const found: TmpPathMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) found.push({ path: m[0], start: m.index, end: m.index + m[0].length });
  return found;
}
