// Whether a page counts as landed. Real breakage only, each item precise enough for a model to fix it in one
// go (`script 2, line 14: ...`); style never sends a page back. Nothing here runs a page's code: scripts
// are only compiled. Works on Bun and Node, module scripts and event-handler attributes included.
import { Script } from "node:vm";
import { DESIGN_PAGE_CSP } from "../../src/lib/design-frame";

const words = (s: string) => new Set(s.split(" "));
const VOID = words("area base br col embed hr img input link meta param source track wbr");
/** The end tag is optional in HTML, so leaving it out is no breakage. */
const OPTIONAL_END = words("html head body p li dt dd tr td th thead tbody tfoot option optgroup colgroup caption rt rp");
/** Their contents are text, not tags. */
const RAW_TEXT = words("script style textarea title xmp iframe noembed noframes");
const FOREIGN = words("svg math");
const JS_TYPES = words("text/javascript application/javascript text/ecmascript application/ecmascript application/x-javascript");

/** Past this many a model has plenty to fix, and the list has to fit a card. */
const MOST = 12;

interface Tag {
  name: string;
  attrs: Map<string, string>;
  line: number;
  selfClosing: boolean;
  /** A raw-text element's contents. */
  text?: string;
  /** The line its contents start on. */
  textLine?: number;
}
type Token = Tag | { close: string; line: number };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (v: string): string =>
  v.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (whole, dec, hex, name) => {
    if (name) return ENTITIES[String(name).toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : parseInt(String(hex), 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

const isLetter = (c: string | undefined) => c !== undefined && /[a-z]/i.test(c);
const isSpace = (c: string) => c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";

function lineFinder(text: string): (at: number) => number {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** The page's tags in order, comments and raw text skipped over as a browser does. */
function tokens(html: string, problems: string[]): Token[] {
  const out: Token[] = [];
  const lineAt = lineFinder(html);
  let foreign = 0;
  let i = 0;
  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt === -1 || lt === html.length - 1) return out;
    const line = lineAt(lt);
    const next = html[lt + 1];
    const skipTo = (end: string, from: number, what: string): boolean => {
      const at = html.indexOf(end, from);
      if (at === -1) problems.push(`line ${line}: a ${what} never ends`);
      else i = at + end.length;
      return at !== -1;
    };
    if (html.startsWith("<!--", lt)) {
      if (!skipTo("-->", lt + 4, "comment")) return out;
    } else if (html.startsWith("<![CDATA[", lt)) {
      if (!skipTo("]]>", lt + 9, "CDATA section")) return out;
    } else if (next === "!" || next === "?") {
      if (!skipTo(">", lt + 2, "declaration")) return out;
    } else if (next === "/" && isLetter(html[lt + 2])) {
      let j = lt + 2;
      while (j < html.length && !isSpace(html[j]!) && html[j] !== ">") j++;
      const close = html.slice(lt + 2, j).toLowerCase();
      if (!skipTo(">", j, `</${close}> tag`)) return out;
      if (FOREIGN.has(close) && foreign > 0) foreign--;
      out.push({ close, line });
    } else if (isLetter(next)) {
      const tag = readTag(html, lt, line, foreign, lineAt, problems);
      if (!tag) return out;
      i = tag.end;
      if (FOREIGN.has(tag.tag.name) && !tag.tag.selfClosing) foreign++;
      out.push(tag.tag);
      if (tag.stop) return out;
    } else i = lt + 1;
  }
}

function readTag(html: string, lt: number, line: number, foreign: number, lineAt: (at: number) => number, problems: string[]): { tag: Tag; end: number; stop?: true } | null {
  let j = lt + 1;
  while (j < html.length && !isSpace(html[j]!) && html[j] !== ">" && html[j] !== "/") j++;
  const name = html.slice(lt + 1, j).toLowerCase();
  const attrs = new Map<string, string>();
  let selfClosing = false;
  const unended = () => (problems.push(`line ${line}: the <${name}> tag never ends`), null);
  for (;;) {
    while (j < html.length && isSpace(html[j]!)) j++;
    if (j >= html.length) return unended();
    if (html[j] === ">") break;
    if (html[j] === "/") {
      selfClosing = html[j + 1] === ">";
      j++;
      continue;
    }
    const from = j;
    while (j < html.length && !isSpace(html[j]!) && html[j] !== "=" && html[j] !== ">" && html[j] !== "/") j++;
    // A stray "=" where a name should be: step over it as a browser does.
    if (j === from) j++;
    const key = html.slice(from, j).toLowerCase();
    while (j < html.length && isSpace(html[j]!)) j++;
    let value = "";
    if (html[j] === "=") {
      j++;
      while (j < html.length && isSpace(html[j]!)) j++;
      const quote = html[j];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, j + 1);
        if (end === -1) return unended();
        value = html.slice(j + 1, end);
        j = end + 1;
      } else {
        const start = j;
        while (j < html.length && !isSpace(html[j]!) && html[j] !== ">") j++;
        value = html.slice(start, j);
      }
    }
    if (key && !attrs.has(key)) attrs.set(key, decode(value));
  }
  const tag: Tag = { name, attrs, line, selfClosing };
  const open = j + 1;
  if (!RAW_TEXT.has(name) || (selfClosing && foreign > 0)) return { tag, end: open };
  const close = new RegExp(`</${name}[\\s/>]`, "ig");
  close.lastIndex = open;
  const found = close.exec(html);
  if (!found) {
    problems.push(`line ${line}: <${name}> is never closed`);
    return { tag, end: html.length, stop: true };
  }
  tag.text = html.slice(open, found.index);
  tag.textLine = lineAt(open);
  // The close tag itself is read next, so the balance check sees it.
  return { tag, end: found.index };
}

function checkBalance(list: Token[], problems: string[]): void {
  const open: Tag[] = [];
  const foreign = () => open.some((t) => FOREIGN.has(t.name));
  for (const t of list) {
    if ("close" in t) {
      let at = open.length - 1;
      while (at >= 0 && open[at]!.name !== t.close) at--;
      if (at < 0) {
        if (!OPTIONAL_END.has(t.close) && !VOID.has(t.close)) problems.push(`line ${t.line}: </${t.close}> closes nothing`);
        continue;
      }
      for (const left of open.splice(at).slice(1).reverse()) if (!OPTIONAL_END.has(left.name)) problems.push(`line ${t.line}: <${left.name}> from line ${left.line} isn't closed before </${t.close}>`);
    } else if (!VOID.has(t.name) && !(t.selfClosing && (foreign() || FOREIGN.has(t.name)))) open.push(t);
  }
  for (const left of open.reverse()) if (!OPTIONAL_END.has(left.name)) problems.push(`line ${left.line}: <${left.name}> is never closed`);
}

const FILE = "page-script";
/** A syntax error in `source`, or null. `lead` is how many lines the wrapper put before the author's. */
function syntaxError(source: string, lead: number): { line: number | null; message: string } | null {
  try {
    new Script(source, { filename: FILE });
    return null;
  } catch (err) {
    const e = err as { name?: string; message?: string; stack?: string };
    if (e?.name !== "SyntaxError") return null;
    const at = new RegExp(`^${FILE}:(\\d+)`, "m").exec(e.stack ?? "");
    return { line: at ? Math.max(1, Number(at[1]) - lead) : null, message: e.message ?? "syntax error" };
  }
}

const IMPORT_LINE = /^[ \t]*import\s+(?:[\w$*{][^;'"]*?from\s*)?["']([^"']+)["']/gm;

function checkScript(tag: Tag, nth: number, problems: string[]): void {
  const type = (tag.attrs.get("type") ?? "").trim().toLowerCase();
  const isModule = type === "module";
  if (tag.attrs.has("src") || (type && !isModule && !JS_TYPES.has(type))) return;
  const src = tag.text ?? "";
  const where = (line: number | null) => `script ${nth}${line === null ? "" : `, line ${line}`}`;
  const report = (e: { line: number | null; message: string } | null) => e && problems.push(`${where(e.line)}: ${e.message}`);
  if (!isModule) return void report(syntaxError(src, 0));
  // A script can't hold an import statement, and nothing a page imports can load: its frame allows no script from anywhere.
  const imports = [...src.matchAll(IMPORT_LINE)];
  for (const m of imports) problems.push(`${where(src.slice(0, m.index).split("\n").length)}: imports ${short(m[1]!)}, which this page's frame blocks`);
  if (imports.length || /^[ \t]*export\s/m.test(src) || /\bimport\.meta\b/.test(src)) return;
  // Compiled as a function so top-level await parses, and strict as a module is.
  report(syntaxError(`(async function(){"use strict";\n${src}\n})`, 1));
}

function checkHandlers(tag: Tag, problems: string[]): void {
  for (const [key, value] of tag.attrs) {
    if (!/^on[a-z]+$/.test(key)) continue;
    const e = syntaxError(`(function(event){\n${value}\n})`, 1);
    if (e) problems.push(`line ${tag.line}: the ${key} of <${tag.name}>: ${e.message}`);
  }
}

// ---- what the page's frame refuses to load -------------------------------------------------------

/** The frame's own policy, read here so this can't drift from what the frame enforces. */
const POLICY = new Map(
  DESIGN_PAGE_CSP.split(";").map((part) => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name!, sources] as const;
  }),
);

function allowed(directive: string, url: string): boolean {
  const u = url.trim();
  if (!u || u.startsWith("#") || u === "about:blank") return true;
  const sources = POLICY.get(directive) ?? POLICY.get("default-src") ?? [];
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u)?.[1]?.toLowerCase();
  if (scheme === "data" || scheme === "blob") return sources.includes(`${scheme}:`);
  // A chat's own image by its short name: Sova puts the picture in when it shows the finished page.
  if (scheme === "sova-asset") return directive === "img-src";
  try {
    return sources.includes(new URL(u.startsWith("//") ? `https:${u}` : u).origin);
  } catch {
    // Relative: the frame's policy has no 'self' for it to come from.
    return false;
  }
}

const short = (url: string) => (url.length > 80 ? `${url.slice(0, 77)}...` : url);

function checkCss(css: string, line: number, what: string, problems: string[]): void {
  const blocked = (directive: string, url: string) => {
    if (!allowed(directive, url)) problems.push(`line ${line}: ${what} loads ${short(url)}, which this page's frame blocks`);
  };
  const urls = (text: string) => [...text.matchAll(/url\(\s*(["']?)([\s\S]*?)\1\s*\)/gi)].map((m) => m[2]!);
  let rest = css.replace(/\/\*[\s\S]*?\*\//g, "");
  rest = rest.replace(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;?/gi, (_, url: string) => (blocked("style-src", url), ""));
  rest = rest.replace(/@font-face\s*\{[^}]*\}/gi, (block) => {
    for (const url of urls(block)) blocked("font-src", url);
    return "";
  });
  for (const url of urls(rest)) blocked("img-src", url);
}

/** A srcset's URLs. A data: URL has commas of its own, so one stands alone. */
const srcsetUrls = (v: string): string[] => (v.trim().toLowerCase().startsWith("data:") ? [v.trim().split(/\s+/)[0]!] : v.split(",").map((part) => part.trim().split(/\s+/)[0] ?? "").filter(Boolean));

const LOADS: Record<string, [attr: string, directive: string][]> = {
  script: [["src", "script-src"]],
  img: [["src", "img-src"]],
  image: [["href", "img-src"], ["xlink:href", "img-src"]],
  video: [["src", "media-src"], ["poster", "img-src"]],
  audio: [["src", "media-src"]],
  source: [["src", "media-src"]],
  track: [["src", "media-src"]],
  iframe: [["src", "frame-src"]],
  embed: [["src", "default-src"]],
  object: [["data", "default-src"]],
};

function checkLoads(tag: Tag, problems: string[]): void {
  const blocked = (directive: string, url: string) => {
    if (!allowed(directive, url)) problems.push(`line ${tag.line}: <${tag.name}> loads ${short(url.trim())}, which this page's frame blocks`);
  };
  for (const [attr, directive] of LOADS[tag.name] ?? []) {
    const v = tag.attrs.get(attr);
    if (v) blocked(directive, v);
  }
  const srcset = tag.attrs.get("srcset");
  if (srcset) for (const url of srcsetUrls(srcset)) blocked("img-src", url);
  if (tag.name === "link") {
    const rel = (tag.attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    const href = tag.attrs.get("href");
    if (href && rel.includes("stylesheet")) blocked("style-src", href);
    if (href && rel.includes("icon")) blocked("img-src", href);
  }
  const style = tag.attrs.get("style");
  if (style) checkCss(style, tag.line, `the style of <${tag.name}>`, problems);
  if (tag.name === "style" && tag.text) checkCss(tag.text, tag.textLine ?? tag.line, "a <style>", problems);
}

/** What is really broken in a whole page, in plain and precise words; empty when nothing is. */
export function lintPage(html: string): string[] {
  const problems: string[] = [];
  const list = tokens(html, problems);
  checkBalance(list, problems);
  let scripts = 0;
  for (const t of list) {
    if ("close" in t) continue;
    if (t.name === "script") checkScript(t, ++scripts, problems);
    checkHandlers(t, problems);
    checkLoads(t, problems);
  }
  return [...new Set(problems)];
}

/** Whether `html` is a page that counts: truncated, empty or broken output never does. */
export function pageProblem(html: string): string | null {
  const t = html.trim();
  if (!t) return "The page is empty.";
  if (!/^<!doctype html|^<html[\s>]/i.test(t)) return "The page must start with <!DOCTYPE html>.";
  if (!/<\/html>\s*$/i.test(t)) return "The page was cut off: it must end with </html>.";
  const problems = lintPage(t);
  if (!problems.length) return null;
  const more = problems.length - MOST;
  return problems.slice(0, MOST).join("; ") + (more > 0 ? `; and ${more} more` : "");
}
