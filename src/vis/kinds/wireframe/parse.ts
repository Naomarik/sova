/**
 * `vis wireframe`: low-fi screens. One block per line, `<word> ["text"]… [words] [-> "Screen"]`; a
 * line indented more than the one above sits inside it (the nearest less-indented line, so any
 * indent width works). `screen "Name" [phone|desktop]` starts a screen (optional for one); `== Name
 * ==` does too, and a `screen` line right after it names the same screen. Settings: `title:`,
 * `caption:`, `device: phone|desktop`. No ids: an arrow names a screen, a mark names a block by its
 * first text (first in the screen it is written under, then anywhere), a screen by its name, or a
 * block word (the first block of that kind).
 *
 * Lenient everywhere a reading is plain: synonyms map silently, an unknown word draws as a tagged
 * plain box, and limits cut with a warning. The only hard errors: a line that starts with neither a
 * word nor a "text" (ASCII art, HTML), an unclosed quote, and nothing to draw.
 * Pure and DOM-free: server/vis-check.ts reaches it through parse.ts.
 */

import { applyMarks, takeMarks, type MarkTarget } from "../../core/emphasis";
import { fail, isTone, lines, splitCommas, text, tokenize, warn, type Line, type Token, type Tone, type VisBase } from "../../core/grammar";

/** Blocks that hold blocks. */
export const CONTAINERS = ["header", "sidebar", "footer", "row", "col", "grid", "card", "list", "item", "table", "modal", "sheet", "heading", "empty"] as const;
export const LEAVES = ["tabs", "tabbar", "text", "image", "avatar", "icon", "badge", "stat", "chart", "progress", "button", "link", "input", "search", "select", "checkbox", "toggle", "radio", "loading", "alert", "toast", "divider"] as const;
export const BLOCKS: readonly string[] = [...CONTAINERS, ...LEAVES];
/** The words the guide teaches; `divider` is lenient-only. */
export const TAUGHT: readonly string[] = BLOCKS.filter((b) => b !== "divider");
/** Leaf words that start another block when written after a line's texts, with a text of their own. */
const INLINE: readonly string[] = LEAVES.filter((b) => b !== "tabs" && b !== "tabbar" && b !== "divider");

/** Words a model reaches for, mapped silently to the block that draws them. */
export const SYNONYMS: Readonly<Record<string, string>> = {
  navbar: "header", appbar: "header", topbar: "header", toolbar: "header", titlebar: "header", topnav: "header",
  nav: "tabs", navigation: "tabs", menu: "tabs", segmented: "tabs", segment: "tabs", breadcrumbs: "tabs", breadcrumb: "tabs",
  bottomnav: "tabbar", bottombar: "tabbar", "bottom-nav": "tabbar", "tab-bar": "tabbar", navbarbottom: "tabbar",
  aside: "sidebar", drawer: "sidebar", sidenav: "sidebar", rail: "sidebar",
  hstack: "row", columns: "row", split: "row", inline: "row",
  stack: "col", vstack: "col", column: "col", group: "col", box: "col", container: "col", div: "col", section: "col", form: "col", fieldset: "col", body: "col", main: "col", content: "col", page: "col",
  gallery: "grid", tiles: "grid",
  panel: "card", tile: "card", hero: "card", widget: "card",
  li: "item", entry: "item", listitem: "item", option: "item", tr: "item", cell: "item",
  dialog: "modal", popup: "modal", popover: "modal", overlay: "modal",
  bottomsheet: "sheet", actionsheet: "sheet",
  h1: "heading", h2: "heading", h3: "heading", title: "heading", subheading: "heading", headline: "heading",
  p: "text", para: "text", paragraph: "text", label: "text", caption: "text", subtitle: "text", copy: "text", body_text: "text", description: "text", note: "text", span: "text",
  img: "image", photo: "image", picture: "image", thumbnail: "image", video: "image", map: "image", illustration: "image", logo: "image", banner_image: "image", media: "image",
  chip: "badge", tag: "badge", pill: "badge", pills: "badge", status: "badge",
  metric: "stat", kpi: "stat", number: "stat",
  graph: "chart", sparkline: "chart", plot: "chart",
  progressbar: "progress", meter: "progress",
  btn: "button", cta: "button", fab: "button",
  a: "link", url: "link",
  field: "input", textfield: "input", textbox: "input", textarea: "input", password: "input", email: "input", date: "input", number_input: "input",
  searchbar: "search", searchbox: "search",
  dropdown: "select", combobox: "select", picker: "select",
  switch: "toggle",
  check: "checkbox",
  spinner: "loading", skeleton: "loading", placeholder: "loading",
  banner: "alert", notice: "alert", callout: "alert", message: "alert", error: "alert", warning: "alert",
  snackbar: "toast", notification: "toast",
  separator: "divider", hr: "divider", line: "divider", spacer: "divider",
};
const TONE_SYN: Record<string, Tone> = { primary: "accent", danger: "error", destructive: "error", success: "ok", warning: "warn", disabled: "muted" };
const ON = new Set(["on", "checked", "selected", "active", "current", "enabled", "open", "yes"]);
export const CHARTS = ["bar", "line", "pie"] as const;
export type ChartType = (typeof CHARTS)[number];
const CHART_SYN: Record<string, ChartType> = { area: "line", lines: "line", trend: "line", donut: "pie", doughnut: "pie", parts: "pie", column: "bar", columns: "bar", bars: "bar", stacked: "bar", grouped: "bar" };
const DEVICES: Record<string, Device> = { phone: "phone", mobile: "phone", ios: "phone", android: "phone", desktop: "desktop", web: "desktop", wide: "desktop", browser: "desktop", laptop: "desktop", tablet: "desktop" };
/** Words with a plain meaning that a lo-fi drawing doesn't draw: dropped without a warning. */
const IGNORED = new Set(["secondary", "ghost", "outline", "outlined", "small", "large", "full", "centered", "center", "left", "sticky", "scroll", "fixed", "bold", "off", "no", "unchecked"]);
/** Placement words (§chat.markdown/vis-wireframe, Rows): `right` and `grow` on any block, the rest on a row. */
const RIGHT = new Set(["right", "end", "trailing"]);
const GROW = new Set(["grow", "fill", "expand", "stretch", "flex"]);
const ALIGN = new Set(["middle", "bottom"]);
/** A row's shares, `1:3:2`: each from 1 to MAX_SHARE. */
const SHARES = /^\d+(?::\d+)+$/;
export const MAX_SHARE = 6;
/** Outside a row, `right` puts a block at the right edge in these (and on the page). */
const RIGHT_IN = new Set(["col", "card", "modal", "sheet", "sidebar", "box"]);
/** Blocks the page places itself: `right` on them, at the page's top level, means nothing. */
const PLACED = new Set(["header", "tabbar", "footer", "sidebar", "modal", "sheet", "toast"]);
const DEVICE_KEYS = ["device", "screen", "frame", "size", "platform", "viewport"];

export const MAX_SCREENS = 6;
export const MAX_BLOCKS = 80;
export const MAX_DEPTH = 6;
/** Tabs, tab bar items and table columns. */
export const MAX_ITEMS = 6;
export const MAX_ROWS = 12;

export type Device = "phone" | "desktop";

export interface WBlock {
  type: string;
  /** A plain box (a word that isn't a block): the word as written. */
  tag?: string;
  texts: string[];
  tone?: Tone;
  on?: boolean;
  wide?: boolean;
  /** In a row: it and the blocks after it sit at the row's right end; on the page, in a card, col, modal, sheet or sidebar: at the right edge. */
  right?: boolean;
  /** In a row that lays out by content: takes the room the others leave. */
  grow?: boolean;
  /** A row: `row right`, its blocks packed at its right end. */
  end?: boolean;
  /** A row that lays out by content: a block in it is `right` or `grow`, or it is `row right`. */
  content?: boolean;
  /** A row: how its blocks line up across it (without it, stretched to its height). */
  align?: "middle" | "bottom";
  /** A row: each block's share of its width (`row 1:3:2`), one per block. */
  shares?: number[];
  /** A block of a row with shares: its own. */
  share?: number;
  chart?: ChartType;
  /** tabs / tabbar items, table columns. */
  items?: string[];
  /** The selected tab. */
  current?: number;
  /** progress, 0–100. */
  value?: number;
  /** The screen a tap opens (an index into `screens`). */
  to?: number;
  /** A screen named but not drawn: shown as a "→ Name" chip, no arrow. */
  toName?: string;
  children: WBlock[];
  /** `s<screen>.<i>.<j>…`: the emphasis key. */
  key: string;
  line: number;
}

export interface WScreen {
  name?: string;
  device: Device;
  blocks: WBlock[];
  /** `s<i>`: the emphasis key. */
  key: string;
  line: number;
  to?: number;
  toName?: string;
}

export interface WireframeSpec extends VisBase {
  kind: "wireframe";
  /** The default for screens that don't name one. */
  device: Device;
  screens: WScreen[];
}

/** A plain box (an unknown word) holds blocks too: `carousel` holding images means what it says. */
export const isContainer = (t: string) => t === "box" || (CONTAINERS as readonly string[]).includes(t);

function blockWord(w: string): { type: string; tag?: string; known: boolean } {
  const low = w.toLowerCase().replace(/:$/, "");
  if (BLOCKS.includes(low)) return { type: low, known: true };
  const syn = Object.hasOwn(SYNONYMS, low) ? SYNONYMS[low] : undefined;
  if (syn) return { type: syn, known: true };
  return { type: "box", tag: low, known: false };
}

const toneOf = (w: string): Tone | undefined => (isTone(w) ? w : Object.hasOwn(TONE_SYN, w) ? TONE_SYN[w] : undefined);
const chartOf = (w: string): ChartType | undefined => ((CHARTS as readonly string[]).includes(w) ? (w as ChartType) : Object.hasOwn(CHART_SYN, w) ? CHART_SYN[w] : undefined);
/** A word that only modifies its block: a tone, `on`, `wide`, `right`, `grow`, and a row's `middle` or `bottom`. */
const isFlagWord = (w: string) => {
  const l = w.toLowerCase();
  return !!toneOf(l) || ON.has(l) || l === "wide" || RIGHT.has(l) || GROW.has(l) || ALIGN.has(l);
};
/** What may follow a block's texts, for a warning about a word that can't. */
const flagHint = (type: string) => `a tone, on, wide, right, grow${type === "row" ? ", middle, bottom, shares like 1:2" : ""}${type === "chart" ? ", bar line pie" : ""}`;
/** A word on a block: true when it is one of its modifiers (set on it), false for a stray word. */
function setFlag(b: WBlock, w: string): boolean {
  const l = w.toLowerCase();
  const tone = toneOf(l);
  if (tone) return !!(b.tone = tone);
  if (ON.has(l)) return (b.on = true);
  if (l === "wide") return (b.wide = true);
  if (RIGHT.has(l)) {
    // `row right`: its own blocks at its end, and, in a row, the start of that row's right group.
    if (b.type === "row") b.end = true;
    return (b.right = true);
  }
  if (GROW.has(l)) return (b.grow = true);
  if (b.type === "row" && ALIGN.has(l)) return !!(b.align = l as "middle" | "bottom");
  if (b.type === "row" && SHARES.test(l)) {
    const shares = l.split(":").map(Number);
    if (shares.every((n) => n >= 1 && n <= MAX_SHARE)) b.shares = shares;
    else warn(b.line, `row ${l}: each share is a whole number from 1 to ${MAX_SHARE}; drew the row without them`);
    return true;
  }
  return false;
}
/** Case- and quote-insensitive comparison form of a name. */
const norm = (s: string) => s.toLowerCase().replace(/["'“”]/g, "").replace(/\s+/g, " ").trim();

/** Whether a line ends inside a quote (as core tokenize reads it: backslash escapes, `#` comments outside quotes). */
function endsOpen(s: string): boolean {
  let open = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (open && c === "\\") i++;
    else if (c === '"') open = !open;
    else if (!open && c === "#" && (i === 0 || /\s/.test(s[i - 1]!))) return false;
  }
  return open;
}

/** A quoted text may run over up to this many lines (a message body with its line breaks). */
export const MAX_QUOTE_LINES = 12;

/**
 * A quote left open at the end of a line and closed on a later one (within MAX_QUOTE_LINES) is one
 * text: the lines are joined with spaces, with a warning. It runs on the raw lines, before blank and
 * `#` lines are dropped, so a line of the text that starts with # stays text. The joined lines leave
 * blanks, so later line numbers hold. One never closed stays the hard error.
 */
function joinQuotes(body: string): string {
  const raw = body.split("\n");
  for (let i = 0; i < raw.length; i++) {
    if (!endsOpen(raw[i]!)) continue;
    let joined = raw[i]!.replace(/\s+$/, "");
    let j = i + 1;
    for (; j < raw.length && j - i < MAX_QUOTE_LINES; j++) {
      const t = raw[j]!.trim();
      if (t) joined += ` ${t}`;
      if (!endsOpen(joined)) break;
    }
    if (j >= raw.length || j - i >= MAX_QUOTE_LINES) continue;
    warn(i + 1, `a quoted text ran over ${j - i + 1} lines; joined into one`);
    raw[i] = joined;
    for (let k = i + 1; k <= j; k++) raw[k] = "";
    i = j;
  }
  return raw.join("\n");
}

export function parseWireframe(body: string): WireframeSpec {
  const spec: WireframeSpec = { kind: "wireframe", device: "phone", screens: [] };
  const all = lines(joinQuotes(body.replace(/\t/g, "  ")));

  // Settings: column-0 `key: value` lines. A block word with a colon (`text: Welcome`) is that block.
  const blockLines: Line[] = [];
  const seen = new Set<string>();
  for (const l of all) {
    const m = /^([a-z]+):(?:\s+(.*))?$/.exec(l.raw);
    if (!m) {
      blockLines.push(l);
      continue;
    }
    const key = m[1]!;
    const raw = (m[2] ?? "").trim();
    const value = raw.replace(/^"(.*)"$/, "$1");
    if (key === "title" || key === "caption") {
      if (seen.has(key)) warn(l.n, `"${key}:" is set twice; the first is kept`);
      else if (value) spec[key] = text(value, l.n);
      seen.add(key);
    } else if (DEVICE_KEYS.includes(key)) {
      const d = Object.hasOwn(DEVICES, value.toLowerCase()) ? DEVICES[value.toLowerCase()] : undefined;
      if (d) spec.device = d;
      else warn(l.n, "device: is phone or desktop; drew phone");
    } else if (blockWord(key).known) {
      const line = `${key} ${raw.startsWith('"') ? raw : JSON.stringify(raw)}`;
      blockLines.push({ ...l, raw: line, text: line });
    } else warn(l.n, `unknown setting "${key}:", ignored (this kind takes title: caption: device:)`);
  }

  // Marks at any indentation; `mark item "Label" "note"` (a block word before the label) drops the
  // word, and so does `mark button "Save", "Cancel"` (the word before a list of targets).
  const { rest, marks } = takeMarks(
    blockLines.map((l) => {
      if (!/^\s*mark(\s|$)/.test(l.raw)) return l;
      const m = /^mark\s+([A-Za-z]+)\s+("(?:[^"\\]|\\.)*"(?:(?:\s+\w+)*\s+".*|\s*,.*))$/.exec(l.text);
      const t = m && blockWord(m[1]!).known ? `mark ${m[2]}` : l.text;
      return { ...l, raw: t, text: t };
    }),
  );

  type Frame = { indent: number; block: WBlock | null; depth: number };
  let screen: WScreen | null = null;
  let stack: Frame[] = [];
  const top = (): Frame[] => [{ indent: -1, block: null, depth: 0 }];
  const newScreen = (n: number, name?: string, device?: Device): WScreen => {
    const s: WScreen = { name, device: device ?? spec.device, blocks: [], key: `s${spec.screens.length}`, line: n };
    spec.screens.push(s);
    return s;
  };
  /** Past MAX_SCREENS: blocks go to a screen that is never drawn. */
  const sink = (n: number, name?: string): WScreen => {
    warn(n, `at most ${MAX_SCREENS} screens; the rest dropped`);
    return { name, device: spec.device, blocks: [], key: "x", line: n };
  };
  let count = 0;
  let cutBlocks = false;
  const pendingArrows: { from: WBlock | WScreen; target: string; n: number; home?: number }[] = [];
  const screenArrows: { a: string; b: string; n: number }[] = [];
  /** The screen a `== Name ==` line started, until a block or another screen line. */
  let sectionOpen: WScreen | null = null;
  /** Rows whose next block follows a `spacer`. */
  const spaced = new Set<WBlock>();

  for (const line of rest) {
    const indent = /^ */.exec(line.raw)![0].length;
    const sec = /^==+\s*(.*?)\s*==+$/.exec(line.text);
    if (sec) {
      screen = spec.screens.length >= MAX_SCREENS ? sink(line.n, sec[1]) : newScreen(line.n, text(sec[1]!, line.n) || undefined);
      sectionOpen = screen.key === "x" ? null : screen;
      stack = top();
      continue;
    }
    const toks = tokenize(line);
    if (toks.length === 0) continue;
    const head = toks[0]!;
    // `"A" -> "B"` on its own: screen to screen.
    if (head.t === "str" && toks[1]?.t === "arrow" && toks[2]) {
      screenArrows.push({ a: head.v, b: String(toks[2].v), n: line.n });
      continue;
    }
    // `-> "B"` on its own: the preceding block at this indent or less opens B; before any block, the screen does.
    if (head.t === "arrow") {
      const t = toks.slice(1).filter((x) => x.t !== "arrow");
      const name = (t.find((x) => x.t === "str")?.v ?? t.map((x) => x.v).join(" ")).toString();
      if (!name || !screen) {
        warn(line.n, "-> needs a block or screen before it and a screen name after it, ignored");
        continue;
      }
      while (stack.length > 1 && stack[stack.length - 1]!.indent > indent) stack.pop();
      const owner = stack[stack.length - 1]!.block;
      const from = owner && !pendingArrows.some((a) => a.from === owner) ? owner : screen;
      pendingArrows.push({ from, target: name, n: line.n, home: spec.screens.indexOf(screen) });
      continue;
    }
    let word: string;
    let body = toks.slice(1);
    if (head.t === "str") {
      word = "text";
      body = toks;
    } else if (head.t === "word" && /^[A-Za-z][A-Za-z0-9_-]*:?$/.test(head.v)) word = head.v;
    else return fail(line.n, `each line is one block: a word (row, card, text, button, …) then its "text"; found "${String(head.v).slice(0, 12)}"`);

    // Split at the first arrow: what follows names the screen a tap opens.
    const ai = body.findIndex((t) => t.t === "arrow");
    const main = ai < 0 ? body : body.slice(0, ai);
    const after = ai < 0 ? [] : body.slice(ai + 1);
    let target: string | undefined;
    if (ai >= 0) {
      const tt = after.filter((t) => t.t !== "arrow");
      if (after.some((t) => t.t === "arrow")) warn(line.n, "one -> per line; the rest ignored");
      const firstStr = tt.find((t) => t.t === "str");
      target = firstStr ? String(firstStr.v) : tt.map((t) => t.v).join(" ");
      if (!target) warn(line.n, "-> needs a screen name, ignored");
    }

    if (word.toLowerCase().replace(/:$/, "") === "screen") {
      const strs = main.filter((t) => t.t === "str").map((t) => String(t.v));
      let dev: Device | undefined;
      const unknown: string[] = [];
      for (const t of main) {
        if (t.t !== "word") continue;
        const w = t.v.toLowerCase();
        if (Object.hasOwn(DEVICES, w)) dev = DEVICES[w];
        else unknown.push(t.v);
      }
      const name = strs[0] ?? (unknown.length ? unknown.join(" ") : undefined);
      if (sectionOpen && sectionOpen === screen && screen.blocks.length === 0) {
        // `== Before ==` then `screen "Orders"`: one screen, "Before · Orders".
        if (name && name !== screen.name) screen.name = screen.name ? `${screen.name} · ${name}` : name;
        if (dev) screen.device = dev;
        if (target) pendingArrows.push({ from: screen, target, n: line.n });
        sectionOpen = null;
        continue;
      }
      sectionOpen = null;
      stack = top();
      if (spec.screens.length >= MAX_SCREENS) {
        screen = sink(line.n, name);
        continue;
      }
      screen = newScreen(line.n, name, dev);
      if (target) pendingArrows.push({ from: screen, target, n: line.n });
      continue;
    }
    sectionOpen = null;
    if (!screen) {
      screen = newScreen(line.n);
      stack = top();
    }
    // A line of only modifier words (`wide`, `accent`, `on`) under a block belongs to that block.
    // Checked before the block words, so an indented `error` or `warning` tones its block rather than drawing an alert.
    if (toks.every((t) => t.t === "word" && isFlagWord(t.v))) {
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const owner = stack[stack.length - 1]!.block;
      if (owner) {
        const stray = toks.map((t) => String(t.v)).filter((w) => !setFlag(owner, w));
        if (stray.length) warn(line.n, `ignored ${stray.map((s) => `"${s}"`).join(", ")} (after the texts: ${flagHint(owner.type)})`);
        continue;
      }
    }
    const build = (word: string, main: Token[]): WBlock => {
      const bw = blockWord(word);
      const b: WBlock = { type: bw.type, texts: [], children: [], key: "", line: line.n };
      if (!bw.known) {
        b.tag = bw.tag;
        warn(line.n, `"${word}" isn't a wireframe block; drawn as a plain box`);
      }
      const strs = main.filter((t) => t.t === "str").map((t) => String(t.v));
      const words = main.filter((t) => t.t === "word").map((t) => String(t.v));
      const flag = (w: string): boolean => {
        const l = w.toLowerCase();
        if (setFlag(b, l)) return true;
        if (b.type === "chart" && chartOf(l)) return !!(b.chart = chartOf(l));
        return IGNORED.has(l) || Object.hasOwn(DEVICES, l);
      };
      const isModifier = (w: string) => {
        const l = w.toLowerCase();
        return (isFlagWord(l) && (b.type === "row" || !ALIGN.has(l))) || IGNORED.has(l) || (b.type === "chart" && !!chartOf(l)) || (b.type === "row" && SHARES.test(l));
      };
      if (strs.length === 0 && words.length > 0) {
        // Unquoted: the whole rest of the line is the text (`|` splits it), unless every word is a modifier.
        if (words.every(isModifier)) words.forEach(flag);
        else {
          const joined = words.join(" ");
          b.texts = (joined.includes("|") ? joined.split("|").map((s) => s.trim()).filter(Boolean) : [joined]).map((s) => text(s, line.n));
        }
      } else {
        b.texts = strs;
        const stray = words.filter((w) => !flag(w));
        if (stray.length && !["tabs", "tabbar", "table"].includes(b.type)) warn(line.n, `ignored ${stray.map((s) => `"${s}"`).join(", ")} (after the texts: ${flagHint(b.type)})`);
      }
      if (b.type === "tabs" || b.type === "tabbar" || b.type === "table") {
        // Every string and stray word, in order, so a mis-quoted `"A, "B", C"` keeps B.
        // Modifiers (`wide`, `on`, a tone) are applied above, never items.
        const parts = main.filter((t) => t.t === "str" || (t.t === "word" && !isModifier(t.v) && !Object.hasOwn(DEVICES, t.v.toLowerCase()))).map((t) => String(t.v));
        let items = parts.flatMap((s) => splitCommas(s)).map((s) => s.trim()).filter(Boolean);
        const star = items.findIndex((s) => s.startsWith("*"));
        items = items.map((s) => s.replace(/^\*\s*/, ""));
        if (items.length > MAX_ITEMS) {
          warn(line.n, `drew ${MAX_ITEMS} of ${items.length} ${b.type === "table" ? "columns" : "tabs"}`);
          items = items.slice(0, MAX_ITEMS);
        }
        b.items = items;
        b.texts = [];
        if (b.type !== "table") b.current = star >= 0 && star < items.length ? star : 0;
      }
      if (b.type === "chart") b.chart ??= "bar";
      if (b.type === "progress") {
        const m = /(\d+(?:\.\d+)?)\s*%/.exec(b.texts.join(" "));
        b.value = m ? Math.min(100, Number(m[1])) : 50;
      }
      return b;
    };
    // More blocks on this line (§chat.markdown/vis-lenience-content): a leaf block's word after the
    // texts, followed by its own text (`item "#1042" badge "Delivered" ok`, `button "A" | button "B"`).
    const segs: { word: string; toks: Token[] }[] = [];
    let from = 0;
    let segWord = word;
    if (!["tabs", "tabbar", "table"].includes(blockWord(word).type)) {
      main.forEach((t, i) => {
        if (i <= from || t.t !== "word" || !INLINE.includes(t.v) || main[i + 1]?.t !== "str" || !main.slice(from, i).some((x) => x.t === "str")) return;
        const seg = main.slice(from, i);
        if (seg[seg.length - 1]?.t === "word" && seg[seg.length - 1]!.v === "|") seg.pop();
        segs.push({ word: segWord, toks: seg });
        segWord = t.v;
        from = i + 1;
      });
    }
    segs.push({ word: segWord, toks: segs.length ? main.slice(from) : main });
    const b = build(word, segs[0]!.toks);

    // Place it: the parent is the nearest line above with a smaller indent.
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    let parent = stack[stack.length - 1]!;
    if (parent.block && !isContainer(parent.block.type)) {
      warn(line.n, `a ${parent.block.type} holds no blocks; drawn after it`);
      while (stack.length > 1 && stack[stack.length - 1]!.block && !isContainer(stack[stack.length - 1]!.block!.type)) stack.pop();
      parent = stack[stack.length - 1]!;
    }
    if (parent.depth >= MAX_DEPTH) {
      warn(line.n, `at most ${MAX_DEPTH} levels; drawn one level up`);
      stack.pop();
      parent = stack[stack.length - 1]!;
    }
    // A `spacer` among a row's blocks draws nothing: the block after it starts the row's right group.
    if (word.toLowerCase() === "spacer" && parent.block?.type === "row" && target === undefined) {
      spaced.add(parent.block);
      continue;
    }
    if (count >= MAX_BLOCKS) {
      if (!cutBlocks) warn(line.n, `at most ${MAX_BLOCKS} blocks; the rest dropped`);
      cutBlocks = true;
      continue;
    }
    if (parent.block?.type === "table") {
      // A table's children are its rows.
      if (b.type === "row" || b.type === "box" || b.type === "col") b.type = "item";
      if (parent.block.children.length >= MAX_ROWS) {
        warn(line.n, `a table draws ${MAX_ROWS} rows; the rest dropped`);
        continue;
      }
      if (b.texts.length === 1 && (parent.block.items?.length ?? 0) > 1 && b.texts[0]!.includes(",")) {
        // Commas inside parentheses don't split, unless splitting them too is what gives the table's column count.
        const cols = parent.block.items!.length;
        const cells = splitCommas(b.texts[0]!);
        b.texts = (cells.length !== cols && b.texts[0]!.split(",").length === cols ? b.texts[0]!.split(",") : cells).map((s) => s.trim());
      }
    }
    count++;
    const siblings = parent.block ? parent.block.children : screen.blocks;
    if (parent.block && spaced.delete(parent.block)) b.right = true;
    siblings.push(b);
    // The line's other blocks: inside it when it holds blocks (and may go a level deeper), else after it.
    const inside = isContainer(b.type) && parent.depth + 1 < MAX_DEPTH;
    let last = b;
    for (const seg of segs.slice(1)) {
      if (count >= MAX_BLOCKS) {
        if (!cutBlocks) warn(line.n, `at most ${MAX_BLOCKS} blocks; the rest dropped`);
        cutBlocks = true;
        break;
      }
      last = build(seg.word, seg.toks);
      (inside ? b.children : siblings).push(last);
      count++;
    }
    // A tap on the line opens the screen: the block holding the others, else the last one.
    if (target) pendingArrows.push({ from: inside ? b : last, target, n: line.n, home: spec.screens.indexOf(screen) });
    stack.push({ indent, block: b, depth: parent.depth + 1 });
  }

  const screens = spec.screens;
  if (screens.every((s) => s.blocks.length === 0)) fail(0, 'nothing to draw: one block per line, like header "Title" or button "Save"');

  screens.forEach((s) => settleRows(s.blocks));

  screens.forEach((s, si) => {
    const walk = (bs: WBlock[], p: string) =>
      bs.forEach((b, i) => {
        b.key = `${p}${i}`;
        walk(b.children, `${b.key}.`);
      });
    walk(s.blocks, `s${si}.`);
  });

  // Arrows: a screen by its name (exact, then a prefix either way when only one other screen has it, then its
  // number). A prefix of the arrow's own screen ("Invoice" from "Invoices") is a screen not drawn; one shared by
  // several screens is ambiguous. Both become a "→ Name" chip. -1: not found; -2: ambiguous.
  const findScreen = (t: string, home?: number): number => {
    const n = norm(t);
    const i = screens.findIndex((s) => s.name !== undefined && norm(s.name) === n);
    if (i >= 0 || !n) return i;
    const pre = screens.flatMap((s, j) => (j !== home && s.name !== undefined && norm(s.name) !== "" && (norm(s.name).startsWith(n) || n.startsWith(norm(s.name))) ? [j] : []));
    if (pre.length === 1) return pre[0]!;
    if (pre.length > 1) return -2;
    return /^\d+$/.test(n) && Number(n) >= 1 && Number(n) <= screens.length ? Number(n) - 1 : -1;
  };
  for (const a of pendingArrows) {
    const home = a.home ?? (screens.indexOf(a.from as WScreen) >= 0 ? screens.indexOf(a.from as WScreen) : undefined);
    const i = findScreen(a.target, home);
    if (i === -2) warn(a.n, `-> "${a.target}" matches several screens; drawn as a chip (use the full name)`);
    if (i < 0) a.from.toName = text(a.target, a.n);
    else if (home === i) warn(a.n, `-> "${a.target}" points at its own screen, dropped`);
    else a.from.to = i;
  }
  for (const a of screenArrows) {
    const i = findScreen(a.a);
    const j = findScreen(a.b, i >= 0 ? i : undefined);
    if (i < 0 || j < 0) warn(a.n, `no screen "${i < 0 ? a.a : a.b}", arrow dropped`);
    else if (i !== j) screens[i]!.to = j;
  }

  // Marks: first in the screen the mark is written under (the last screen line above it), then anywhere.
  const flatOf = (bs: WBlock[]): WBlock[] => bs.flatMap((b) => [b, ...flatOf(b.children)]);
  const screenFlat = screens.map((s) => flatOf(s.blocks));
  const flat = screenFlat.flat();
  const find = (pool: WBlock[], t: MarkTarget, x: string) =>
    pool.find((b) => b.texts[0] === t.text) ?? pool.find((b) => b.texts.some((s) => norm(s) === x)) ?? pool.find((b) => b.items?.some((s) => norm(s) === x));
  const resolve = (t: MarkTarget, ln: number): string | null => {
    if (t.t !== "id" && t.t !== "label") return null;
    const x = norm(t.text);
    const here = screens.reduce((acc, s, i) => (s.line < ln ? i : acc), -1);
    const byText = (here >= 0 ? find(screenFlat[here]!, t, x) : undefined) ?? find(flat, t, x);
    if (byText) return byText.key;
    const sc = screens.find((s) => s.name !== undefined && norm(s.name) === x);
    if (sc) return sc.key;
    if (t.t === "id") {
      // A block word: the first block of that kind, in the mark's screen first.
      const bw = blockWord(t.text);
      const byType = bw.known ? ((here >= 0 ? screenFlat[here]!.find((b) => b.type === bw.type) : undefined) ?? flat.find((b) => b.type === bw.type)) : undefined;
      if (byType) return byType.key;
    }
    return null;
  };
  applyMarks(spec, marks, resolve, "block or screen");
  return spec;
}

/**
 * Which placement words count where (§chat.markdown/vis-wireframe, Rows). First each row's own words: shares
 * that don't match its blocks are dropped with a warning, and shares win over the row's own `right`; an item's
 * blocks (and a row among them, at any depth) keep the item's own layout, so the row words mean nothing there.
 * Then each block's `right` and `grow` against its parent: in a row with shares both are dropped (with a
 * warning; a `row right` among them keeps its own blocks at its end); in any other row either makes the row lay
 * out by content, where only the first `right` counts and `wide` is `grow`; outside a row `grow` means nothing,
 * and `right` counts only on the page or in a card, col, modal, sheet, sidebar or plain box.
 */
function settleRows(top: WBlock[]): void {
  const own = (bs: WBlock[], inItem: boolean) => {
    for (const b of bs) {
      if (b.type !== "row" || inItem) {
        delete b.end;
        delete b.align;
        delete b.shares;
      }
      if (b.shares && b.shares.length !== b.children.length) {
        warn(b.line, `row ${b.shares.join(":")}: ${b.shares.length} shares for ${b.children.length} block${b.children.length === 1 ? "" : "s"}; drew the row without them`);
        delete b.shares;
      }
      if (b.shares && b.end) {
        warn(b.line, `row ${b.shares.join(":")}: its shares win; "right" ignored`);
        delete b.end;
        delete b.right;
      }
      own(b.children, b.type === "item" || (inItem && b.type === "row"));
    }
  };
  own(top, false);
  const place = (bs: WBlock[], parent: WBlock | null, inItem: boolean) => {
    if (parent?.type === "row" && !inItem) {
      const shares = parent.shares;
      if (shares) {
        const words = [bs.some((c) => c.right && !c.end) ? '"right"' : "", bs.some((c) => c.grow) ? '"grow"' : ""].filter(Boolean);
        if (words.length) warn(parent.line, `row ${shares.join(":")}: its shares win; ${words.join(" and ")} ignored`);
        bs.forEach((c, i) => {
          delete c.grow;
          delete c.right;
          delete c.wide;
          c.share = shares[i];
        });
      } else if (parent.end || bs.some((c) => c.right || c.grow)) {
        parent.content = true;
        let first = true;
        for (const c of bs) {
          if (c.wide) c.grow = true;
          delete c.wide;
          if (c.right && !first) delete c.right;
          if (c.right) first = false;
        }
      }
    } else {
      for (const c of bs) {
        delete c.grow;
        if (inItem || (parent ? !RIGHT_IN.has(parent.type) : PLACED.has(c.type))) delete c.right;
      }
    }
    for (const c of bs) place(c.children, c, c.type === "item" || (inItem && c.type === "row"));
  };
  place(top, null, false);
}
