/**
 * The shared grammar of every `vis` kind: lines, `#` comment lines, `title:` / `caption:` settings,
 * tokens (words, "quoted strings", arrows), `|` fields, comma lists, tone words and the one error
 * type. A kind's parser (src/vis/kinds/<kind>/parse.ts) is built from these; it throws VisError
 * (via `fail`) and never ignores anything it does not understand. Pure, dependency-free.
 */

export const TONES = ["accent", "ok", "warn", "error", "info", "muted"] as const;
export type Tone = (typeof TONES)[number];
export const isTone = (w: string): w is Tone => (TONES as readonly string[]).includes(w);

/** Longest free text (a label, a note, a title) any kind accepts. */
export const MAX_TEXT = 200;

/**
 * What every spec carries: the optional heading and one-line caption the figure shows, and the
 * resolved `mark` lines (core/emphasis.ts) — the shell lists their notes, the View highlights them.
 */
export interface VisBase {
  title?: string;
  caption?: string;
  emphasis?: Emphasis[];
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

/** `key: value` when `key` is a lowercase word; the value loses one pair of surrounding quotes. */
export function setting(line: Line): { key: string; value: string } | null {
  const m = /^([a-z]+):(?:\s+(.*))?$/.exec(line.text);
  if (!m) return null;
  let value = (m[2] ?? "").trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = unquote(value.slice(1, -1));
  return { key: m[1]!, value };
}

/**
 * Consume the settings a kind allows, in any order, wherever they appear. Returns the rest.
 * An unknown `word:` line is an error naming the ones that exist.
 */
export function takeSettings(ls: Line[], allowed: readonly string[], base: VisBase): { rest: Line[]; values: Map<string, { value: string; n: number }> } {
  const all = ["title", "caption", ...allowed];
  const values = new Map<string, { value: string; n: number }>();
  const rest: Line[] = [];
  for (const line of ls) {
    const s = setting(line);
    if (!s) {
      rest.push(line);
      continue;
    }
    if (!all.includes(s.key)) fail(line.n, `unknown setting "${s.key}:" (this kind takes ${all.map((k) => `${k}:`).join(" ")})`);
    if (values.has(s.key)) fail(line.n, `"${s.key}:" is set twice`);
    if (s.value === "") fail(line.n, `"${s.key}:" needs a value`);
    values.set(s.key, { value: s.value, n: line.n });
  }
  const title = values.get("title");
  const caption = values.get("caption");
  if (title) base.title = text(title.value, title.n);
  if (caption) base.caption = text(caption.value, caption.n);
  return { rest, values };
}

export function text(s: string, n: number): string {
  if (s.length > MAX_TEXT) fail(n, `text longer than ${MAX_TEXT} characters`);
  return s;
}

export const unquote = (s: string) => s.replace(/\\(["\\n|])/g, (_, c: string) => (c === "n" ? "\n" : c));

export type Token = { t: "word"; v: string } | { t: "str"; v: string } | { t: "arrow"; v: Arrow };
export type Arrow = "->" | "-->" | "<->" | "<-->";
export const ARROWS: Arrow[] = ["<-->", "<->", "-->", "->"];

/** Words, "quoted strings" (\" \\ \n escapes) and arrows; ` #` starts a trailing comment. */
export function tokenize(line: Line): Token[] {
  const s = line.text;
  const out: Token[] = [];
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
    let j = i;
    while (j < s.length && !/\s/.test(s[j]!) && s[j] !== '"' && !ARROWS.some((a) => s.startsWith(a, j))) j++;
    out.push({ t: "word", v: s.slice(i, j) });
    i = j;
  }
  return out;
}

export const ID = /^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/;
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

/** Split on unescaped `|`, trim each field, drop one pair of surrounding quotes. */
export function fields(line: Line): string[] {
  const parts: string[] = [];
  let cur = "";
  const s = line.text;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      parts.push(cur);
      cur = "";
    } else cur += s[i];
  }
  parts.push(cur);
  return parts.map((p) => {
    const t = p.trim();
    return text(t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? unquote(t.slice(1, -1)) : t, line.n);
  });
}

/** Comma list with optional quotes around items that contain commas. */
export function commaList(s: string, n: number): string[] {
  const out: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|([^,]*?))\s*(?:,|$)/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m || m[0] === "") fail(n, "malformed comma list");
    const item = m![1] !== undefined ? unquote(m![1]) : m![2]!.trim();
    if (item === "") fail(n, "empty item in comma list");
    out.push(text(item, n));
    i = re.lastIndex;
  }
  return out;
}

/** The last field is a tone when it is exactly a tone word. */
export function popTone(fs: string[]): Tone | undefined {
  const last = fs[fs.length - 1];
  if (fs.length > 1 && last !== undefined && isTone(last)) {
    fs.pop();
    return last;
  }
  return undefined;
}
