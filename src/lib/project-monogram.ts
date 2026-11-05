// A project's letters (§app.projects/icon): two letters like a profile avatar, white on one of 8 fixed colours picked by
// the project's id, so a rename keeps its colour. Pure and DOM-free.

/** White letters read on each in both themes (contrast 4.9 to 6.7); none is Sova's accent. */
export const PROJECT_TINTS = ["#2F6690", "#1F7A72", "#5E7A1F", "#8A6512", "#A4502A", "#A63D5C", "#7A4E9C", "#4F5D75"] as const;

const SPLIT = /[\s\-_./]+/u;
const CAMEL = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})/u;
const WORD_START = /^[\p{L}\p{N}]/u;

const first = (s: string): string => Array.from(s)[0] ?? "";

/** "Landing Site" → LS, acme-api → AA, LandingSite → LS, Sova → So, API → AP, x → X, "" → ?. */
export function projectLetters(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const words = trimmed
    .split(SPLIT)
    .flatMap((w) => w.split(CAMEL))
    .filter((w) => WORD_START.test(w));
  if (words.length === 0) return first(trimmed);
  if (words.length >= 2) return (first(words[0]!) + first(words[1]!)).toUpperCase();
  const cps = Array.from(words[0]!);
  const w = words[0]!;
  if (cps.length >= 2 && w === w.toUpperCase() && /\p{Lu}/u.test(w)) return cps[0]! + cps[1]!;
  return cps[0]!.toUpperCase() + (cps[1] ?? "").toLowerCase();
}

/** The project's colour: FNV-1a over its id, never its name. */
export function projectTint(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return PROJECT_TINTS[(h >>> 0) % PROJECT_TINTS.length]!;
}
