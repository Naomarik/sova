/**
 * The Typography catalogue and its persistence shape (spec/12-settings-dialog.md §12
 * "Typography", spec/00-ground-rules.md §0 "Theme"): the closed list of faces this browser can
 * put over a theme, and the read/validate/serialize of the choice.
 *
 * This module is pure — no DOM, no signals, no theme import — so the tests below can hold it
 * against fixed strings. Painting the choice, and its precedence over the theme, lives in
 * `theme.ts`, which owns the one place custom properties are written.
 *
 * The catalogue is CLOSED: a choice is an id from the lists below, never a stack the user typed.
 * Every family named here is bundled under `public/fonts/` and declared in `tokens.css`, so a
 * choice is always a face that exists on the client, offline, on the phone too. That is why the
 * persistence is validated against ids rather than against the theme file's stack grammar: a
 * string that isn't an id is not "a stack we can't check", it is not a choice at all.
 */

export type FontKind = "text" | "mono";

export interface FontOption {
  /** What persists, and what the `<select>` holds. Stable: renaming a label never moves a choice. */
  id: string;
  label: string;
  /** The stack written to the custom property. The tail is the default's own tail, so a glyph the
      face lacks still falls through to the same system fonts it would today. */
  stack: string;
  /** One line under the label where a face needs one (§09). */
  note?: string;
}

const SANS_TAIL = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const MONO_TAIL = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** The text faces: what a person reads — UI chrome, transcript prose, headings. A pick sets
    `--font-body` AND `--font-display`; a separate heading face is not a control worth having. */
export const TEXT_FONTS: readonly FontOption[] = [
  { id: "inter", label: "Inter", stack: `"Inter", ${SANS_TAIL}` },
  { id: "source-sans-3", label: "Source Sans 3", stack: `"Source Sans 3", ${SANS_TAIL}` },
  { id: "atkinson-hyperlegible-next", label: "Atkinson Hyperlegible Next", stack: `"Atkinson Hyperlegible Next", ${SANS_TAIL}` },
  { id: "ibm-plex-sans", label: "IBM Plex Sans", stack: `"IBM Plex Sans", ${SANS_TAIL}` },
  { id: "noto-sans", label: "Noto Sans", stack: `"Noto Sans", ${SANS_TAIL}` },
];

/** The code faces: machine facts — paths, ids, diffs, fenced blocks, timestamps. Sets `--font-mono`. */
export const MONO_FONTS: readonly FontOption[] = [
  { id: "jetbrains-mono", label: "JetBrains Mono", stack: `"JetBrains Mono", ${MONO_TAIL}` },
  { id: "fira-code", label: "Fira Code", stack: `"Fira Code", ${MONO_TAIL}` },
  { id: "ibm-plex-mono", label: "IBM Plex Mono", stack: `"IBM Plex Mono", ${MONO_TAIL}`, note: "Static weights: medium and display text render one step heavier." },
  { id: "source-code-pro", label: "Source Code Pro", stack: `"Source Code Pro", ${MONO_TAIL}` },
];

export const fontsOf = (kind: FontKind): readonly FontOption[] => (kind === "text" ? TEXT_FONTS : MONO_FONTS);

/** The option an id names, or null when it names nothing in that list. */
export function fontById(kind: FontKind, id: string | null | undefined): FontOption | null {
  if (!id) return null;
  return fontsOf(kind).find((f) => f.id === id) ?? null;
}

/**
 * The choice: one id per kind, or nothing — "Theme default", which is the initial state and
 * what Use Theme Fonts returns to. `inter` and `jetbrains-mono` are real choices distinct from
 * the default: a theme may name another face, and picking Inter explicitly is how you refuse it.
 */
export interface Typography {
  text: string | null;
  mono: string | null;
}

export const NO_TYPOGRAPHY: Typography = Object.freeze({ text: null, mono: null });

/** §12: the choice persists here, like the theme and for the same reason — it is this browser's. */
export const TYPOGRAPHY_KEY = "sova:typography";
/** The pre-rebrand spelling, read and mirrored while the rename bridge is open (storage-keys.ts). */
export const LEGACY_TYPOGRAPHY_KEY = "pi-web:typography";

/** True when nothing is overridden: the theme's own faces are what's on screen. */
export const isThemeDefault = (t: Typography): boolean => t.text === null && t.mono === null;

/**
 * The stored string → a choice. Tolerant in the one direction that matters: anything that is not
 * an id from the catalogue reads as "no choice" for that kind, so a renamed or removed face, a
 * hand-edited value, or a stack string from some earlier idea can never reach a custom property.
 */
export function parseTypography(raw: string | null | undefined): Typography {
  if (!raw) return NO_TYPOGRAPHY;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return NO_TYPOGRAPHY;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return NO_TYPOGRAPHY;
  const v = data as Record<string, unknown>;
  const pick = (kind: FontKind, value: unknown) => (typeof value === "string" ? (fontById(kind, value)?.id ?? null) : null);
  return { text: pick("text", v.text), mono: pick("mono", v.mono) };
}

/** The choice → the stored string, or null when there is nothing to store (the key is removed). */
export function serializeTypography(t: Typography): string | null {
  if (isThemeDefault(t)) return null;
  const out: Record<string, string> = {};
  if (t.text) out.text = t.text;
  if (t.mono) out.mono = t.mono;
  return JSON.stringify(out);
}

/**
 * What the choice writes, keyed by custom property: nothing for a kind left on Theme default, so
 * the theme's own value (or tokens.css's) stays. `theme.ts` writes these AFTER the theme's tokens,
 * which is the whole precedence rule: pick over theme over default.
 */
export function typographyProperties(t: Typography): Record<string, string> {
  const out: Record<string, string> = {};
  const text = fontById("text", t.text);
  if (text) {
    out["--font-body"] = text.stack;
    out["--font-display"] = text.stack;
  }
  const mono = fontById("mono", t.mono);
  if (mono) out["--font-mono"] = mono.stack;
  return out;
}

/**
 * The face a surface would actually show for a given theme: the pick, else the theme's own
 * token, else undefined (meaning tokens.css's default). The theme card sample and the Typography
 * preview both ask this, so a preview never shows a face the page wouldn't (§12).
 */
export function effectiveStack(kind: FontKind, themeTokens: Record<string, string>, t: Typography): string | undefined {
  const pick = fontById(kind, kind === "text" ? t.text : t.mono);
  if (pick) return pick.stack;
  return themeTokens[kind === "text" ? "font-body" : "font-mono"];
}
