/**
 * The executable definition of a Sova theme file: the token names, the grammar each value
 * family accepts, and the read pipeline. The ground rules' "Theme" section is the contract;
 * this file is its only canonical copy, and BOTH sides import it — the server to read files,
 * the client to write the custom properties.
 *
 * Two rules from the ground rules are load-bearing and easy to lose in a refactor:
 *
 *  1. **Every value is validated against what is allowed, never against a list of what isn't.**
 *     Nothing here enumerates a rejected spelling. The color grammar is a hex shape or ONE call
 *     from a ten-name list, and it is the name list — not the charset — that refuses `url(`,
 *     `image-set(` and `src(`: the charset happily spells `url(//host/x.png)`, and a
 *     protocol-relative URL needs no colon. The single `(` is what refuses `rgb(var(--x))`.
 *  2. **Validation runs AFTER `$name` resolution** (`readTheme` below, steps 2 then 3). Backwards,
 *     every theme using `vars` dies at once with an error naming the color grammar while pointing
 *     at a value that was never a color. 16 of the 18 shipped themes use `vars`.
 *
 * Values are emitted VERBATIM — the authored string, never parsed, normalized, lowercased or
 * re-serialized. `--focus-color` and `--focus-ring` are not theme keys and are never written:
 * they resolve through `var(--color-accent)` in tokens.css, which is how a theme's accent reaches
 * the focus ring. They are deliberately absent from CSS_PROPERTY below.
 */

import type { ThemeInfo, ThemeTokens } from "./protocol";

/** The 27 color keys. `scrim` and `skeleton-sweep` are colors, not open-charset keys:
    `scrim` paints `background` at three sites, so an open charset would let it fetch. */
export const COLOR_KEYS = [
  "bg", "surface", "sunken", "ink", "ink-2", "ink-muted", "border", "border-strong",
  "accent", "accent-hover", "accent-tint", "on-accent",
  "status-success", "status-warn", "status-error", "status-info",
  "status-success-bg", "status-warn-bg", "status-error-bg", "status-info-bg",
  "diff-add-bg", "diff-add-ink", "diff-del-bg", "diff-del-ink", "diff-gutter",
  "scrim", "skeleton-sweep",
] as const;

/** Elevation. The one family on the open charset — `box-shadow` takes no image. */
export const SHADOW_KEYS = ["shadow-1", "shadow-2", "shadow-3"] as const;

/** Faces, weights, size/line-height pairs and tracking. */
export const FONT_KEYS = ["font-body", "font-display", "font-mono"] as const;
const STEPS = ["display-xl", "display-l", "heading-m", "heading-s", "body", "caption", "mono", "micro"] as const;
export const FS_KEYS = STEPS.map((s) => `fs-${s}`) as readonly string[];
export const LH_KEYS = STEPS.map((s) => `lh-${s}`) as readonly string[];
export const FW_KEYS = ["fw-regular", "fw-medium", "fw-semibold", "fw-display"] as const;
export const LS_KEYS = ["ls-display", "ls-heading", "ls-heading-s", "ls-wordmark", "ls-body", "ls-mono-caps", "ls-eyebrow"] as const;
export const TYPOGRAPHY_KEYS: readonly string[] = [...FONT_KEYS, ...FS_KEYS, ...LH_KEYS, ...FW_KEYS, ...LS_KEYS];
/** `colors` carries the 27 colors AND the 3 shadows — 30 keys, as the shipped files do. */
export const COLOR_MAP_KEYS: readonly string[] = [...COLOR_KEYS, ...SHADOW_KEYS];

/** Which grammar a key is held to. One key belongs to exactly one family. */
export type KeyFamily = "color" | "shadow" | "font" | "length" | "number" | "weight";

export function familyOf(key: string): KeyFamily | null {
  if ((COLOR_KEYS as readonly string[]).includes(key)) return "color";
  if ((SHADOW_KEYS as readonly string[]).includes(key)) return "shadow";
  if ((FONT_KEYS as readonly string[]).includes(key)) return "font";
  if (FS_KEYS.includes(key) || (LS_KEYS as readonly string[]).includes(key)) return "length";
  if (LH_KEYS.includes(key)) return "number";
  if ((FW_KEYS as readonly string[]).includes(key)) return "weight";
  return null;
}

/**
 * key → the custom property it lands on. The one shared table: the server emits nothing the
 * client can't name, and the client writes nothing the server didn't check. Colors drop their
 * `--color-` / `--status-` / `--diff-` prefix in the file; everything else is `--${key}`.
 */
export const CSS_PROPERTY: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries([
    ...COLOR_KEYS.map((k) => [k, k.startsWith("status-") || k.startsWith("diff-") || k === "scrim" || k === "skeleton-sweep" ? `--${k}` : `--color-${k}`]),
    ...SHADOW_KEYS.map((k) => [k, `--${k}`]),
    ...TYPOGRAPHY_KEYS.map((k) => [k, `--${k}`]),
  ]),
);

/* ---------------------------------------------------------------------------
   The grammar (the ground rules' table, one function per row)
   ------------------------------------------------------------------------ */

/** The ten call names a color may use. Anything else — `url`, `image-set`, `src`, `hwb`,
    a bare `red` — is not a color, because it is not on this list. */
export const COLOR_FUNCTIONS = ["rgb", "rgba", "hsl", "hsla", "oklch", "oklab", "lab", "lch", "color-mix", "color"] as const;

const COLOR_CHARSET = /^[A-Za-z0-9 #%(),./+-]*$/;
const HEX = /^#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
/** name `(` args `)` and nothing else: one `(` in the whole value, so no nesting and no `var()`. */
const ONE_CALL = new RegExp(`^(${COLOR_FUNCTIONS.join("|")})\\([^()]*\\)$`, "i");
const MAX_COLOR = 120;
const MAX_SHADOW = 200;
const MAX_STACK = 200;

/** A font stack has no use for parentheses, so it carries none — which is the whole of what
    keeps `url(`, `src(` and `image-set(` out. The structural characters go too: a `;`, `}` or
    `@` in a custom property is a declaration the author didn't mean to write. */
const STACK_FORBIDDEN = /[;{}@<\\]|\/\*|\*\//;

const isColor = (v: string) => v.length <= MAX_COLOR && COLOR_CHARSET.test(v) && (HEX.test(v) || ONE_CALL.test(v));
const isShadow = (v: string) => v.length <= MAX_SHADOW && COLOR_CHARSET.test(v);
const isStack = (v: string) => v.length <= MAX_STACK && !v.includes("(") && !v.includes(")") && !STACK_FORBIDDEN.test(v);
const isLength = (v: string) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:px|em)$/.test(v) || /^[+-]?0$/.test(v);
const isNumber = (v: string) => /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(v) && Number(v) > 0;
const isWeight = (v: string) => /^\d{3}$/.test(v) && Number(v) >= 100 && Number(v) <= 900;

const ACCEPTS: Record<KeyFamily, (v: string) => boolean> = {
  color: isColor,
  shadow: isShadow,
  font: isStack,
  length: isLength,
  number: isNumber,
  weight: isWeight,
};

/** The copy deck's "Settings · Themes": name the key, the value, and the shapes that
    would have worked. A rejection that only says *invalid* sends you looking for a typo. */
const REASON: Record<KeyFamily, string> = {
  color: `A color is a hex value, or one call to ${COLOR_FUNCTIONS.slice(0, -1).join(", ")}, or ${COLOR_FUNCTIONS.at(-1)}.`,
  shadow: "A shadow takes lengths, an optional inset, and a color.",
  font: "A font stack takes names, quotes, and commas — no parentheses.",
  length: "That takes a px or em length, or 0.",
  number: "That takes a plain number.",
  weight: "That takes a number from 100 to 900.",
};

/** Long values are elided in the copy the way the copy deck elides them ("accent is image-set(…)."). */
const shown = (value: string) => (value.length > 60 ? `${value.slice(0, 60)}…` : value);

/** null when the value may be emitted, else the reason, ready for a broken row. */
export function checkValue(key: string, value: unknown): string | null {
  const family = familyOf(key);
  if (!family) return `${key} isn't a theme key.`;
  if (typeof value !== "string") return `${key} is not a string. A theme value is written as a JSON string.`;
  if (ACCEPTS[family](value)) return null;
  return `${key} is ${shown(value)}. ${REASON[family]}`;
}

/* ---------------------------------------------------------------------------
   The pipeline: read → resolve $name → validate → emit
   ------------------------------------------------------------------------ */

/** A theme file as JSON, before anything is believed about it. */
interface RawTheme {
  $schema?: unknown;
  name?: unknown;
  extends?: unknown;
  vars?: unknown;
  colors?: unknown;
  typography?: unknown;
}

export type ThemeBase = "dark" | "light";
export const THEME_BASES: readonly ThemeBase[] = ["dark", "light"];
/** The id the picker falls back to when the stored one no longer resolves. */
export const DEFAULT_THEME_ID = "dark";

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Step 2 of the ground rules' pipeline: every `"$name"` becomes the value it names, and nothing downstream sees a `$`.
 * A var may only name a var DEFINED ABOVE IT, which is what makes a cycle unspellable; a
 * forward reference and a self reference are the same mistake and read as one.
 */
function resolveVars(raw: unknown, warn: (reason: string) => void): Map<string, string> {
  const out = new Map<string, string>();
  const vars = asRecord(raw);
  if (!vars) {
    if (raw !== undefined) warn("vars isn't an object. It maps a name to a value each later key can use as \"$name\".");
    return out;
  }
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value !== "string") {
      warn(`$${name} is not a string. A var is written as a JSON string.`);
      continue;
    }
    if (!value.startsWith("$")) {
      out.set(name, value);
      continue;
    }
    const target = value.slice(1);
    if (out.has(target)) out.set(name, out.get(target)!);
    else if (target in vars) warn(`$${name} names $${target}, which is defined below it. A var can only use a var above it.`);
    else warn(`$${name} names $${target}, and no var by that name is defined.`);
  }
  return out;
}

/** One authored value → the string to emit, or a reason it can't be. */
function deref(key: string, value: unknown, vars: Map<string, string>): { value: string } | { reason: string } {
  if (typeof value === "string" && value.startsWith("$")) {
    const name = value.slice(1);
    const hit = vars.get(name);
    if (hit === undefined) return { reason: `${key} names $${name}, and no var by that name resolved.` };
    return { value: hit };
  }
  return typeof value === "string" ? { value } : { reason: `${key} is not a string. A theme value is written as a JSON string.` };
}

/** What one file turned into: the tokens it authored (already deref'd and checked) plus its
    own metadata. Merging onto a base happens later, in `mergeThemes`. */
export interface ParsedTheme {
  name: string;
  base: ThemeBase;
  tokens: ThemeTokens;
  warnings: string[];
  error?: string;
}

/**
 * The ground rules' four steps over one file's text. Returns a ParsedTheme whose `error` is set when the
 * theme can't be worn at all — the file isn't JSON, it has no name, or it holds a value we
 * won't emit ("A value that fails becomes a broken row … and the theme it came from is not
 * applied"). Every rejected value is also listed in `warnings`, in file order, and its key
 * is dropped, so no unchecked string is in the payload a picker row previews.
 */
export function parseTheme(text: string): ParsedTheme {
  const warnings: string[] = [];
  const warn = (reason: string) => warnings.push(reason);
  const tokens: ThemeTokens = {};

  let raw: RawTheme | null;
  try {
    raw = asRecord(JSON.parse(text)) as RawTheme | null;
  } catch (err) {
    // The parser's own message: V8 names the line for most syntax errors, and our own copy
    // would be promising a position it sometimes can't give.
    return { name: "", base: "dark", tokens, warnings, error: (err as Error).message };
  }
  if (!raw) return { name: "", base: "dark", tokens, warnings, error: "A theme is a JSON object." };

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (typeof raw.$schema === "string" && raw.$schema !== "sova-theme/v1")
    warn(`$schema is ${shown(raw.$schema)}. This app reads sova-theme/v1.`);

  let base: ThemeBase = "dark";
  if (THEME_BASES.includes(raw.extends as ThemeBase)) base = raw.extends as ThemeBase;
  else if (raw.extends !== undefined) warn(`extends is ${shown(String(raw.extends))}. A theme extends dark or light.`);

  const vars = resolveVars(raw.vars, warn);
  let fatal: string | undefined;
  const take = (map: unknown, allowed: readonly string[], label: string) => {
    const entries = asRecord(map);
    if (!entries) {
      if (map !== undefined) warn(`${label} isn't an object.`);
      return;
    }
    for (const [key, value] of Object.entries(entries)) {
      if (!allowed.includes(key)) {
        warn(`${key} isn't a ${label} key, so nothing was set from it.`); // unknown keys are inert, not fatal
        continue;
      }
      const d = deref(key, value, vars);
      if ("reason" in d) {
        warn(d.reason);
        fatal ??= d.reason;
        continue;
      }
      const reason = checkValue(key, d.value);
      if (reason) {
        warn(reason);
        fatal ??= reason;
        continue;
      }
      tokens[key] = d.value; // verbatim, as authored
    }
  };
  take(raw.colors, COLOR_MAP_KEYS, "color");
  take(raw.typography, TYPOGRAPHY_KEYS, "typography");

  // A nameless file can't be listed as anything: the picker needs a label before a reason.
  if (!name) return { name: "", base, tokens, warnings, error: "This theme has no name." };
  return { name, base, tokens, warnings, ...(fatal ? { error: fatal } : {}) };
}

/** A theme stands on the base it extends: what it omits comes from that base, so a
    three-key file is a whole theme. The base is always the BUILT-IN dark or light, because
    that is what `tokens.css` actually paints under `data-theme`. */
export function mergeTokens(base: ThemeTokens, over: ThemeTokens): ThemeTokens {
  return { ...base, ...over };
}

/** The picker's row, assembled from one file and the base it stands on. A broken theme is
    listed but never worn, so it gets no base fill: it carries only the keys it authored and we
    accepted, and the value that failed was dropped before this. Nothing unchecked is in `tokens`
    either way — a row previews a file nobody selected. */
export function themeInfo(input: {
  id: string;
  source: ThemeInfo["source"];
  path: string;
  parsed: ParsedTheme;
  baseTokens: ThemeTokens;
  replacesBuiltin?: boolean;
}): ThemeInfo {
  const { id, source, path, parsed, baseTokens, replacesBuiltin } = input;
  return {
    id,
    name: parsed.name,
    source,
    path,
    base: parsed.base,
    tokens: parsed.error ? { ...parsed.tokens } : mergeTokens(baseTokens, parsed.tokens),
    warnings: parsed.warnings,
    ...(parsed.error ? { error: parsed.error } : {}),
    ...(replacesBuiltin ? { replacesBuiltin: true } : {}),
  };
}
