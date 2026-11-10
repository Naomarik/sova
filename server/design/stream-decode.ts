// Turning a design session's stream into the page as it is written. Pure: the
// process running the session feeds these from the harness's deltas; no I/O, no timers.
//
// Two ways a page arrives. Through a tool's argument: `{"label":"A","html":"<!doctype…`, cut at any
// byte, the html field's value decoded as it comes. Through the reply: the document between two
// marker lines, for a model whose provider delivers a tool's argument whole at the end (q15, t31).

/** Incrementally decodes the top-level `html` string of a JSON object, across chunks cut anywhere.
    Everything else in the object is skipped, so no parse of the whole argument is ever made. */
export class HtmlArgDecoder {
  private state: "before" | "key" | "key-esc" | "colon" | "value" | "html" | "esc" | "uni" | "skip-string" | "skip-esc" | "skip-number" | "skip-nest" | "skip-nest-string" | "skip-nest-esc" | "after" | "done" = "before";
  private key = "";
  private unicode = "";
  private depth = 0;

  /** Feed one chunk of raw argument JSON; returns the decoded html characters it completed. */
  feed(chunk: string): string {
    let out = "";
    let i = 0;
    while (i < chunk.length && this.state !== "done") {
      const c = chunk[i]!;
      switch (this.state) {
        case "before":
          if (c === '"') {
            this.key = "";
            this.state = "key";
          } else if (c === "}") this.state = "done";
          i++;
          break;
        case "key":
          if (c === '"') this.state = "colon";
          else if (c === "\\") this.state = "key-esc";
          else this.key += c;
          i++;
          break;
        case "key-esc":
          this.key += c;
          this.state = "key";
          i++;
          break;
        case "colon":
          if (c === ":") this.state = "value";
          i++;
          break;
        case "value":
          if (c === " " || c === "\n" || c === "\t" || c === "\r") i++;
          else if (c === '"') {
            this.state = this.key === "html" ? "html" : "skip-string";
            i++;
          } else if (c === "{" || c === "[") {
            this.depth = 1;
            this.state = "skip-nest";
            i++;
          } else this.state = "skip-number";
          break;
        case "html": {
          // Runs of plain characters in one slice: a page is tens of thousands of characters.
          const stop = nextSpecial(chunk, i);
          if (stop > i) {
            out += chunk.slice(i, stop);
            i = stop;
            break;
          }
          if (c === '"') this.state = "after";
          else this.state = "esc";
          i++;
          break;
        }
        case "esc":
          i++;
          if (c === "u") {
            this.unicode = "";
            this.state = "uni";
          } else {
            out += ESCAPES[c] ?? c;
            this.state = "html";
          }
          break;
        case "uni":
          this.unicode += c;
          i++;
          if (this.unicode.length === 4) {
            out += String.fromCharCode(Number.parseInt(this.unicode, 16));
            this.state = "html";
          }
          break;
        case "skip-string":
          if (c === '"') this.state = "after";
          else if (c === "\\") this.state = "skip-esc";
          i++;
          break;
        case "skip-esc":
          this.state = "skip-string";
          i++;
          break;
        case "skip-number":
          if (c === ",") this.state = "before";
          else if (c === "}") this.state = "done";
          i++;
          break;
        case "skip-nest":
          if (c === '"') this.state = "skip-nest-string";
          else if (c === "{" || c === "[") this.depth++;
          else if ((c === "}" || c === "]") && --this.depth === 0) this.state = "after";
          i++;
          break;
        case "skip-nest-string":
          if (c === '"') this.state = "skip-nest";
          else if (c === "\\") this.state = "skip-nest-esc";
          i++;
          break;
        case "skip-nest-esc":
          this.state = "skip-nest-string";
          i++;
          break;
        case "after":
          if (c === ",") this.state = "before";
          else if (c === "}") this.state = "done";
          i++;
          break;
      }
    }
    return out;
  }
}

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function nextSpecial(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 92) return i;
  }
  return s.length;
}

/** Decodes the page written between `open` and `close` lines of a reply, across chunks cut anywhere.
    Text before the opening line and after the closing line is dropped. */
export class ReplyPageDecoder {
  private state: "before" | "page" | "done" = "before";
  private held = "";

  constructor(
    private readonly open: string,
    private readonly close: string,
  ) {}

  /** A chunk of reply text; returns the page characters it completed. A marker cut across two chunks
      is held back until it can be told apart from the page. */
  feed(chunk: string): string {
    if (this.state === "done") return "";
    this.held += chunk;
    if (this.state === "before") {
      // Only with its line ending seen: a CR or LF still to come belongs to the marker, not the page.
      const at = lineMarker(this.held, this.open, false);
      if (at === null) {
        this.held = this.held.slice(Math.max(0, this.held.length - this.open.length - 1));
        return "";
      }
      this.held = this.held.slice(at.end);
      this.state = "page";
    }
    const end = lineMarker(this.held, this.close);
    if (end !== null) {
      this.state = "done";
      const out = this.held.slice(0, end.start);
      this.held = "";
      return out;
    }
    // Hold back what could still become the closing line.
    const keep = Math.min(this.held.length, this.close.length + 2);
    const out = this.held.slice(0, this.held.length - keep);
    this.held = this.held.slice(this.held.length - keep);
    return out;
  }

  /** Whether the opening marker has been seen. */
  get started(): boolean {
    return this.state !== "before";
  }
}

/** Where `marker` stands alone on a line in `text`, its line ending included. */
function lineMarker(text: string, marker: string, endOfTextEndsLine = true): { start: number; end: number } | null {
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
    const before = at === 0 || text[at - 1] === "\n";
    const after = at + marker.length;
    const cr = text[after] === "\r" ? 1 : 0;
    if (before && (text[after + cr] === "\n" || (endOfTextEndsLine && after + cr === text.length))) {
      const start = at > 0 && text[at - 1] === "\n" ? (at > 1 && text[at - 2] === "\r" ? at - 2 : at - 1) : at;
      return { start, end: after + cr + (text[after + cr] === "\n" ? 1 : 0) };
    }
  }
  return null;
}

/** The page written between the markers of a finished reply, or null when they aren't both there. */
export function pageInReply(text: string, open: string, close: string): string | null {
  const start = lineMarker(text, open);
  if (!start) return null;
  const rest = text.slice(start.end);
  const end = lineMarker(rest, close);
  return end ? rest.slice(0, end.start) : null;
}

/** `text` with each page between the markers replaced by a short note, for showing a reply. */
export function withoutPages(text: string, open: string, close: string, note: string): string {
  let out = "";
  let rest = text;
  for (;;) {
    const start = lineMarker(rest, open);
    if (!start) return out + rest;
    const body = rest.slice(start.end);
    const end = lineMarker(body, close);
    if (!end) return `${out}${rest.slice(0, start.start)}${note}`;
    out += `${rest.slice(0, start.start)}${note}`;
    rest = body.slice(end.end);
  }
}
