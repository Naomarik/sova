/**
 * The shared grammar of every `vis` kind: lines, `#` comment lines, `title:` / `caption:` settings,
 * tokens (words, "quoted strings", arrows), `|` fields, comma lists, tone words, the one error
 * type and soft warnings. A kind's parser (src/vis/kinds/<kind>/parse.ts) is built from these; it
 * throws VisError (via `fail`) on anything it does not understand, and `warn`s only where the intent
 * is plain and the figure can still draw it (overlong text is cut, a stray mark is dropped).
 * Pure, dependency-free.
 */

export const TONES = ["accent", "ok", "warn", "error", "info", "muted"] as const;
export type Tone = (typeof TONES)[number];
export const isTone = (w: string): w is Tone => (TONES as readonly string[]).includes(w);

/** Longest free text (a label, a note, a title) any kind draws whole; longer text is cut, with a warning. */
export const MAX_TEXT = 200;

/**
 * What every spec carries: the optional heading and one-line caption the figure shows, and the
 * resolved `mark` lines (core/emphasis.ts) — the shell lists their notes, the View highlights them.
 */
export interface VisBase {
  title?: string;
  caption?: string;
  emphasis?: Emphasis[];
  /** Present only when the parse warned (parse.ts sets it): the figure draws, with one muted line listing these. */
  warnings?: VisWarning[];
}

/** A soft problem: what the parser changed or dropped so the figure could still draw. Line 0: the fence as a whole. */
export interface VisWarning {
  line: number;
  message: string;
}

/**
 * One highlighted item. `key` is the kind's own key for it (a node id, a row index, a line number);
 * `n` numbers the ones with a note, 1…, in the order they were written — the badge on the item and
 * the entry in the figure's notes list share it.
 */
export interface Emphasis {
  key: string;
  tone: Tone;
  note?: string;
  n?: number;
}

export class VisError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}
/** Throw a parse error at a 1-based body line (0: the fence as a whole). */
export const fail = (line: number, message: string): never => {
  throw new VisError(line, message);
};

// Warnings go to the parse in progress (collectWarnings); parsing is synchronous, so one sink is enough.
let sink: VisWarning[] | null = null;
/** Record a soft problem at a 1-based body line (0: the fence as a whole). Outside collectWarnings it is dropped. */
export const warn = (line: number, message: string): void => {
  sink?.push({ line, message });
};
/** Run a parse, collecting what it `warn`s. */
export function collectWarnings<T>(parse: () => T): { value: T; warnings: VisWarning[] } {
  const prev = sink;
  const warnings: VisWarning[] = [];
  sink = warnings;
  try {
    return { value: parse(), warnings };
  } finally {
    sink = prev;
  }
}

/** `s` cut to `max` characters, the last one an ellipsis (never half a surrogate pair). */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

export interface Line {
  /** 1-based, within the fence body. */
  n: number;
  /** Raw text with trailing whitespace removed (indentation kept, for tree). */
  raw: string;
  text: string;
}

/** Non-blank, non-comment lines. */
export function lines(body: string): Line[] {
  const out: Line[] = [];
  body.split("\n").forEach((raw, i) => {
    const r = raw.replace(/\s+$/, "");
    const text = r.trim();
    if (text === "" || text.startsWith("#")) return;
    out.push({ n: i + 1, raw: r, text });
  });
  return out;
}

/** `key: value` when `key` is a lowercase word. `value` is unquoted when it is one quoted string; `raw` is as written (for lists). */
export function setting(line: Line): { key: string; value: string; raw: string } | null {
  const m = /^([a-z]+):(?:\s+(.*))?$/.exec(line.text);
  if (!m) return null;
  const raw = (m[2] ?? "").trim();
  // Unquote only a value that is ONE quoted string: `"A b", C, "D e"` is a list, left as written.
  const q = /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
  return { key: m[1]!, value: q ? unquote(q[1]!) : raw, raw };
}

export interface SettingsOptions {
  /** A known key in any case (`Title:`) is that setting. Off for a kind where such a line is content (tree). */
  caseless?: boolean;
  /** A `key: value` line the kind reads as content instead (chart's `jan: 1200`): left in `rest`. Asked only of a key that isn't a setting, or one written in capitals. */
  asRow?: (key: string, value: string) => boolean;
  /** Other spellings of a key: `{ direction: "dir" }`. */
  aliases?: Readonly<Record<string, string>>;
}

/**
 * Consume the settings a kind allows, in any order, wherever they appear. Returns the rest.
 * An unknown `word:` line is an error naming the ones that exist; `mark:` is passed on as a `mark` line.
 */
export function takeSettings(ls: Line[], allowed: readonly string[], base: VisBase, opts: SettingsOptions = {}): { rest: Line[]; values: Map<string, { value: string; raw: string; n: number }> } {
  const all = ["title", "caption", ...allowed];
  const known = (k: string) => all.includes(k) || Object.hasOwn(opts.aliases ?? {}, k);
  const values = new Map<string, { value: string; raw: string; n: number }>();
  const rest: Line[] = [];
  for (const line of ls) {
    let s = setting(line);
    // `Title: …`: a known key in capitals, unless the kind reads the line as content.
    const cap = !s && opts.caseless ? /^([A-Za-z]+):(?:\s+(.*))?$/.exec(line.text) : null;
    if (cap && known(cap[1]!.toLowerCase()) && !opts.asRow?.(cap[1]!, (cap[2] ?? "").trim())) s = setting({ ...line, text: `${cap[1]!.toLowerCase()}:${cap[2] !== undefined ? ` ${cap[2]}` : ""}` });
    if (!s || (!known(s.key) && s.key !== "mark" && opts.asRow?.(s.key, s.raw))) {
      rest.push(line);
      continue;
    }
    if (opts.aliases && Object.hasOwn(opts.aliases, s.key)) s = { ...s, key: opts.aliases[s.key]! };
    // `mark: 3 "note"` at column 0 is a mark line with a stray colon: left for takeMarks, without it.
    if (s.key === "mark" && line.raw.startsWith("mark:") && s.raw) {
      const t = `mark ${s.raw}`;
      rest.push({ ...line, raw: t, text: t });
      continue;
    }
    if (!all.includes(s.key)) fail(line.n, `unknown setting "${s.key}:" (this kind takes ${all.map((k) => `${k}:`).join(" ")})`);
    if (values.has(s.key)) fail(line.n, `"${s.key}:" is set twice`);
    if (s.value === "") fail(line.n, `"${s.key}:" needs a value`);
    values.set(s.key, { value: s.value, raw: s.raw, n: line.n });
  }
  const title = values.get("title");
  const caption = values.get("caption");
  if (title) base.title = text(title.value, title.n);
  if (caption) base.caption = text(caption.value, caption.n);
  return { rest, values };
}

/** Free text as drawn: over MAX_TEXT characters it is cut with an ellipsis (the whole text stays in Source). */
export function text(s: string, n: number): string {
  if (s.length <= MAX_TEXT) return s;
  warn(n, `text over ${MAX_TEXT} characters, shortened`);
  return clip(s, MAX_TEXT);
}

export const unquote = (s: string) => s.replace(/\\(["\\n|])/g, (_, c: string) => (c === "n" ? "\n" : c));

export type Token = { t: "word"; v: string } | { t: "str"; v: string } | { t: "arrow"; v: Arrow };
export type Arrow = "->" | "-->" | "<->" | "<-->";
export const ARROWS: Arrow[] = ["<-->", "<->", "-->", "->"];

/** Arrows as models also write them, outside quotes, in the kinds that draw arrows (tokenize's `wide`). */
const WIDE: [string, Arrow][] = [["==>", "->"], ["=>", "->"], ["→", "->"], ["⟶", "->"], ["➔", "->"], ["➜", "->"], ["↔", "<->"], ["⟷", "<->"]];

/**
 * Words, "quoted strings" (\" \\ \n escapes) and arrows; ` #` starts a trailing comment. `wide`:
 * `→ ⟶ ➔ ➜ => ==>` are `->` and `↔ ⟷` are `<->` (flow, state, sequence, steps).
 */
export function tokenize(line: Line, opts: { wide?: boolean } = {}): Token[] {
  const s = line.text;
  const out: Token[] = [];
  const wideAt = (j: number) => (opts.wide ? WIDE.find(([w]) => s.startsWith(w, j)) : undefined);
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]!))) break;
    if (c === '"') {
      let j = i + 1;
      let v = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length) {
          v += s[j + 1] === "n" ? "\n" : s[j + 1];
          j += 2;
        } else v += s[j++];
      }
      if (j >= s.length) fail(line.n, "unclosed quote");
      out.push({ t: "str", v: text(v, line.n) });
      i = j + 1;
      continue;
    }
    const arrow = ARROWS.find((a) => s.startsWith(a, i));
    if (arrow) {
      out.push({ t: "arrow", v: arrow });
      i += arrow.length;
      continue;
    }
    const wide = wideAt(i);
    if (wide) {
      out.push({ t: "arrow", v: wide[1] });
      i += wide[0].length;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]!) && s[j] !== '"' && !ARROWS.some((a) => s.startsWith(a, j)) && !wideAt(j)) j++;
    out.push({ t: "word", v: s.slice(i, j) });
    i = j;
  }
  return out;
}

/** An id: letters (any script), digits, `_ . - /`, not starting with `. - /`; never `@` or `:`, which keys use. */
export const ID = /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_.\/-]{0,39}$/u;

/** An id made from a label (a node or actor named only by its "label"): lowercase, runs of anything else as `-`. */
export function slug(label: string, taken: (id: string) => boolean): string {
  const base = label.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "n";
  let s = base;
  for (let i = 2; taken(s); i++) s = `${base}-${i}`;
  return s;
}

/**
 * A row as a Markdown table writes it: one leading `|` and one trailing `|` dropped (`| 2013 | React |`);
 * null for the `|---|---|` rule under a header. Used only where a row starting with `|` can't be read otherwise.
 */
export function tableRow(line: Line): Line | null {
  const t = line.text;
  if (!t.startsWith("|")) return line;
  if (/^[|\s:-]+$/.test(t) && t.includes("-")) return null;
  const inner = t.slice(1).replace(/(?<!\\)\|\s*$/, "").trim();
  return { ...line, raw: inner, text: inner };
}
export function id(tok: Token | undefined, n: number, what: string): string {
  if (!tok) return fail(n, `expected ${what}`);
  if (tok.t !== "word") return fail(n, `expected ${what}, found ${tok.t === "str" ? `"${tok.v}"` : tok.v}`);
  if (!ID.test(tok.v)) {
    if (/[[\](){}|]/.test(tok.v)) fail(n, `"${tok.v}" is not an id: declare labels with node <id> "Label", not brackets`);
    fail(n, `"${tok.v}" is not an id (letters, digits, _ . -; starts with a letter)`);
  }
  return tok.v;
}

/**
 * Trailing words after a declaration's strings: at most one tone, and at most one of `words`
 * (a kind's own vocabulary, e.g. flow's shapes). Anything else is an error listing both.
 */
export function modifiers<W extends string>(toks: Token[], n: number, words: readonly W[] = []): { word?: W; tone?: Tone } {
  const out: { word?: W; tone?: Tone } = {};
  for (const tok of toks) {
    if (tok.t !== "word") fail(n, `unexpected ${tok.t === "str" ? `"${tok.v}"` : tok.v}`);
    const w = tok.v;
    if (isTone(w)) {
      if (out.tone) fail(n, "two tones");
      out.tone = w;
    } else if ((words as readonly string[]).includes(w)) {
      if (out.word) fail(n, `two of: ${words.join(" ")}`);
      out.word = w as W;
    } else fail(n, `unknown word "${w}" (tones: ${TONES.join(" ")}${words.length ? `; also: ${words.join(" ")}` : ""})`);
  }
  return out;
}

/** `== Label ==` → "Label". */
export function divider(line: Line): string | null {
  const m = /^==+\s*(.*?)\s*==+$/.exec(line.text);
  return m ? text(m[1]!, line.n) : null;
}

/**
 * A row's `|` fields as written, untrimmed, `\|` read as `|`. A field that is one whole quoted string
 * keeps a `|` inside it (`2023 | "Quality | Speed"`: §chat.markdown/vis-lenience-content).
 */
export function bars(s: string): string[] {
  const parts: string[] = [];
  let cur = "";
  const whole = /\s*"(?:[^"\\]|\\.)*"\s*(?=\||$)/y;
  for (let i = 0; i < s.length; i++) {
    if (cur.trim() === "" && s[i] === '"') {
      whole.lastIndex = i;
      if (whole.exec(s) && s.slice(i, whole.lastIndex).includes("|")) {
        cur += s.slice(i, whole.lastIndex).replace(/\\\|/g, "|");
        i = whole.lastIndex - 1;
        continue;
      }
    }
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      parts.push(cur);
      cur = "";
    } else cur += s[i];
  }
  parts.push(cur);
  return parts;
}

/** Split on unescaped `|` (bars), trim each field; a field that is ONE quoted string loses its quotes. */
export function fields(line: Line): string[] {
  return bars(line.text).map((p) => {
    const t = p.trim();
    const q = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
    return text(q ? unquote(q[1]!) : t, line.n);
  });
}

/** Parentheses that open before they close and all close: only then does a comma inside them not split. */
const balanced = (s: string): boolean => {
  let depth = 0;
  for (const c of s) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return false;
  }
  return depth === 0;
};

/**
 * Split at commas outside balanced parentheses (`A (x, y), B` is two). A list whose parentheses
 * don't balance (`Happy :), Sad`) splits at every comma. The parts are raw, untrimmed.
 */
export function splitCommas(s: string, parens = balanced(s)): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const c of s) {
    if (parens && c === "(") depth++;
    else if (parens && c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * One reading of a comma list: its trimmed items, a whole-quoted item unquoted, or null on an empty
 * item. `parens`: a comma inside balanced parentheses doesn't split. `quotes`: "start" groups a
 * quoted item (`"a, b", c`); "any" also a balanced quoted stretch inside one (`The "a, b" plan`).
 */
function readList(s: string, parens: boolean, quotes: "start" | "any"): string[] | null {
  const out: string[] = [];
  if (s === "") return out;
  const q = /"(?:[^"\\]|\\.)*"/y;
  const whole = /^"((?:[^"\\]|\\.)*)"$/;
  const anyQuotes = quotes === "any" && (s.replace(/\\./g, "").match(/"/g)?.length ?? 0) % 2 === 0;
  let cur = "";
  let depth = 0;
  const push = () => {
    const t = cur.trim();
    const m = whole.exec(t);
    out.push(m ? unquote(m[1]!) : t);
    cur = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' && (anyQuotes || cur.trim() === "")) {
      q.lastIndex = i;
      const m = q.exec(s);
      // A quoted item groups only when it is the whole item (then a comma or the end), as it always has.
      if (m && (anyQuotes || /^\s*(,|$)/.test(s.slice(q.lastIndex)))) {
        cur += m[0];
        i = q.lastIndex - 1;
        continue;
      }
    }
    if (parens && c === "(") depth++;
    else if (parens && c === ")") depth--;
    if (c === "," && depth === 0) push();
    else cur += c;
  }
  // A trailing comma, right at the end, adds no item.
  if (cur !== "") push();
  return out.some((t) => t === "") ? null : out;
}

/** Comma list with optional quotes around items that contain commas; a comma inside balanced parentheses doesn't split. */
export function commaList(s: string, n: number): string[] {
  const items = readList(s, balanced(s), "start");
  if (!items) fail(n, "empty item in comma list");
  return items!.map((t) => text(t, n));
}

/**
 * A comma list whose length something else fixes (a matrix's columns by its rows' cells): `counts`
 * gives each row's. When every row agrees on a number the list doesn't read as, and exactly one
 * other reading gives it (splitting inside parentheses too, or keeping a quoted stretch inside an
 * item whole), that reading; otherwise the list as commaList reads it. `counts` runs only when the
 * readings differ, and what it warns or throws is dropped (the rows are read again after).
 */
export function commaListFor(s: string, n: number, counts: () => number[]): string[] {
  const first = readList(s, balanced(s), "start");
  const others = [readList(s, false, "start"), readList(s, balanced(s), "any")].filter((r): r is string[] => !!r && r.length !== first?.length);
  if (others.length > 0) {
    let cs: number[] = [];
    try {
      cs = collectWarnings(counts).value;
    } catch {
      /* a row that can't be read settles nothing */
    }
    const k = cs[0];
    const fits = others.filter((r) => r.length === k);
    if (cs.length > 0 && cs.every((c) => c === k) && new Set(fits.map((r) => JSON.stringify(r))).size === 1) return fits[0]!.map((t) => text(t, n));
  }
  return commaList(s, n);
}

/** A `|` outside quotes and not escaped: whether a row has one. */
export const hasBar = (t: string): boolean => /(?<!\\)\|/.test(t.replace(/"(?:[^"\\]|\\.)*"/g, '""'));

/**
 * A row one field too long whose last field isn't a tone: the message saying so, quoting the field
 * (`max`: the fields a row takes, its tone included; `shape`: the row as the kind writes it).
 */
export function notATone(fs: string[], max: number, shape: string): string | null {
  const last = fs[fs.length - 1];
  return fs.length === max && last !== undefined && /^[a-z]+$/i.test(last) && !isTone(last) ? `"${last}" is not a tone (${TONES.join(" ")}): ${shape}` : null;
}

/** The last field is a tone when it is exactly a tone word. */
/**
 * `a | b | warn | note` in a kind whose rows end `| note | tone` (`max` fields with the tone): a row
 * one field too long, its next-to-last field a tone and its last not, has the two swapped. Only a
 * row that couldn't be read otherwise is touched.
 */
export function swapToneNote(fs: string[], max: number): void {
  if (fs.length === max && isTone(fs[max - 2]!) && !isTone(fs[max - 1]!)) fs.splice(max - 2, 2, fs[max - 1]!, fs[max - 2]!);
}

export function popTone(fs: string[]): Tone | undefined {
  const last = fs[fs.length - 1];
  if (fs.length > 1 && last !== undefined && isTone(last)) {
    fs.pop();
    return last;
  }
  return undefined;
}
