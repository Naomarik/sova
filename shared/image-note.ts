// pi 0.87's image resize note, removed from user text for DISPLAY only. When `prompt()` resizes an
// attached image it appends a note for the model to the message's stored text
// (dist/core/agent-session.js `prompt`, from dist/utils/image-process.js `processImage`):
//
//   userText = hints.length > 0 ? `${expandedText}\n\n${hints.join("\n")}` : expandedText
//   content  = [{ type: "text", text: userText }, ...images]
//
// Each image contributes, in order, an optional "[Image converted from <mime> to <mime>.]" and an
// optional dimension note (dist/utils/image-resize.js `formatDimensionNote`):
//
//   [Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.28 to map to original image.]
//
// and an image that could not be processed contributes one "[Image omitted: …]" line instead of
// its block. Only the dimension notes are removed; the other hints stay as written. The session
// file and what the model is sent are never touched — shared between the server (transcript,
// titles, fork and rewind text) and the client (a live user message_start), so both show the same.

const DIMENSION_NOTE = /^\[Image: original (\d+)x(\d+), displayed at (\d+)x(\d+)\. Multiply coordinates by (\d+\.\d\d) to map to original image\.\]$/;
const CONVERTED_HINT = /^\[Image converted from [^\n]+ to image\/(?:png|jpeg|gif|webp)\.\]$/;
const OMITTED_HINTS: ReadonlySet<string> = new Set([
  "[Image omitted: could not be converted to a supported inline image format.]",
  "[Image omitted: could not be resized below the inline image size limit.]",
]);

/** A dimension note as formatDimensionNote writes it, down to its own arithmetic: the scale must be
    originalWidth / width to two places, so a hand-typed line with made-up numbers does not count. */
function isDimensionNote(line: string): boolean {
  const m = DIMENSION_NOTE.exec(line);
  if (!m) return false;
  const [ow, , w] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return w > 0 && (ow / w).toFixed(2) === m[5];
}

/** Image blocks of a message in the shape pi's prompt() builds — exactly one text block, first,
    then only images — else 0. Any other shape was not built there and is never stripped. */
function promptImageCount(content: unknown): number {
  if (!Array.isArray(content) || content.length < 2 || content[0]?.type !== "text") return 0;
  const rest = content.slice(1);
  return rest.every((b) => b?.type === "image") ? rest.length : 0;
}

/**
 * `text` (the text of the user message whose stored `content` is given) without pi's image
 * dimension notes. Changes nothing unless ALL of these hold: the message carries images in pi's
 * prompt shape; the text ends in a hint block after its last blank line in which every line is a
 * hint pi writes; at least one line is a dimension note whose scale matches its own dimensions; and
 * there are no more dimension notes (or conversion hints) than images. A note-only message comes
 * back as "" (the typed text was empty).
 */
export function stripImageNotes(text: string, content: unknown): string {
  const images = promptImageCount(content);
  if (images === 0) return text;
  const at = text.lastIndexOf("\n\n");
  if (at === -1) return text;
  const lines = text.slice(at + 2).split("\n");
  let notes = 0;
  let converted = 0;
  for (const line of lines) {
    if (isDimensionNote(line)) notes++;
    else if (CONVERTED_HINT.test(line)) converted++;
    else if (!OMITTED_HINTS.has(line)) return text;
  }
  if (notes === 0 || notes > images || converted > images) return text;
  const kept = lines.filter((line) => !isDimensionNote(line));
  const typed = text.slice(0, at);
  return kept.length ? `${typed}\n\n${kept.join("\n")}` : typed;
}
