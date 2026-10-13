// Whether a key pressed on an element belongs to the element (the user is typing there) rather
// than to a page-wide shortcut such as the sidebar's "/". Pure, so it runs under `tsx --test`.

/**
 * The question is "is the user TYPING here", and `tagName === "INPUT"` does not answer it: a
 * checkbox or a button-typed input is an `<input>` too, and a shortcut must still work from one.
 * Only the input types that carry a caret count, plus `<textarea>` and anything contenteditable.
 * A type attribute that is missing or unknown is text (the HTML default), so a new type is never
 * silently treated as a button.
 */
const CARETLESS_INPUT_TYPES = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

export function isTextEntry(el: { tagName?: string | null; type?: string | null; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  return !CARETLESS_INPUT_TYPES.has((el.type ?? "text").toLowerCase());
}
