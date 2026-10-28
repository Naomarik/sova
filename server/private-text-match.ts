/**
 * The private-text backstop's matcher (§app.outreach/channels, §app.owner-page/updates): does a text a model
 * wrote repeat a run of PRIVATE_REPEAT or more characters of a private source, ignoring case and spacing?
 * Pure: no reads. The words it names are cut from the checked text (what the model itself wrote), never from
 * the source, so a refusal tells the model nothing it didn't already put in its own text.
 */

/** The shortest repeated run (normalized characters) that counts as copying private text. */
export const PRIVATE_REPEAT = 60;

/** The longest quote of the matched words a refusal carries. */
const QUOTE_MAX = 200;

/** Lower case, every run of whitespace one space; `at[k]` is the index in `t` of normalized character k. */
function normalize(t: string): { s: string; at: number[] } {
  let s = "";
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (/\s/.test(c)) {
      if (s.length && !space) {
        s += " ";
        at.push(i);
      }
      space = true;
      continue;
    }
    space = false;
    const l = c.toLowerCase();
    for (let k = 0; k < l.length; k++) {
      s += l[k];
      at.push(i);
    }
  }
  return { s, at };
}

const norm = (t: string): string => normalize(t).s.trim();

const wordChar = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}]/u.test(c);

/**
 * The words of `text` that repeat a run of at least `min` characters of `secret` (the longest such run, widened
 * to whole words of `text`, at most QUOTE_MAX characters), or null when none does.
 */
export function repeatedRun(text: string, secret: string, min: number = PRIVATE_REPEAT): string | null {
  if (!text || !secret) return null;
  const hay = normalize(text);
  const s = norm(secret);
  if (s.length < min || hay.s.length < min) return null;
  let best: { p: number; len: number } | null = null;
  for (let i = 0; i + min <= s.length; i++) {
    const window = s.slice(i, i + min);
    let p = hay.s.indexOf(window);
    while (p >= 0) {
      let len = min;
      while (i + len < s.length && p + len < hay.s.length && s[i + len] === hay.s[p + len]) len++;
      if (!best || len > best.len) best = { p, len };
      p = hay.s.indexOf(window, p + 1);
    }
  }
  if (!best) return null;
  let start = hay.at[best.p]!;
  let end = hay.at[best.p + best.len - 1]! + 1;
  while (start > 0 && wordChar(text[start - 1]) && wordChar(text[start])) start--;
  while (end < text.length && wordChar(text[end]) && wordChar(text[end - 1])) end++;
  const words = text.slice(start, end).replace(/\s+/g, " ").trim();
  return words.length > QUOTE_MAX ? `${words.slice(0, QUOTE_MAX - 1).trimEnd()}…` : words;
}

/** Does `text` hold the contact value `value` (ignoring case and spacing)? Values under 5 characters never count. */
export function holdsContact(text: string, value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length < 5) return false;
  return norm(text).includes(norm(value));
}
