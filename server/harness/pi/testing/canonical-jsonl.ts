// A pi session file with its randomness taken out, byte for byte otherwise (§app/harness, M4's state
// goldens; M5's behaviour goldens reuse it). The canonical text is made by string substitution on the
// raw lines, never JSON.parse → stringify, so key order, spacing and escaping stay exactly as pi wrote
// them, and a reordered key or a changed value is a byte difference.
//
// What is replaced, walking the lines in order:
// - every entry id (an `"id":"<8 hex>"` of a line) becomes 00000001, 00000002, … by first appearance,
//   wherever it appears quoted: id, parentId, data.targetId, data.fromLeafId, firstKeptEntryId, …;
// - every uuid (session ids, org/person/offer ids) becomes 00000000-0000-7000-8000-00000000000N;
// - every ISO timestamp (entry `timestamp`, data `at`, the header's) becomes 2000-01-01T00:00:00.000Z;
// - every numeric `"timestamp":<ms>` (message timestamps) becomes the same count of digits, 1000…;
// - each `paths` prefix (the test's temp dirs) becomes its placeholder, longest first;
// - each `literals` value becomes its placeholder (ids a scenario mints that match none of the above);
// - the bodies `elide` names become placeholders, the line's envelope (type, id, parentId, timestamp,
//   customType, display, details) and its place in the file kept:
//   - "system" (the default): a pi 0.87 system-prompt message → `{"role":"system","elided":true}`. It is
//     pi's prompt (tool texts, the repo's paths, the loaded extensions), not session state;
//   - "notes": a custom_message's `content` → "<elided>" (hook notes carry the wall clock and prompt prose),
//     and an overseer run note's `details.opening` and `details.told` (the prompt's values and fingerprints);
//   - "tool-results": a toolResult message's `content` → "<elided>" (a tool's prose; its details stay).
// Ids, uuids, ISO times and message timestamps keep their length; paths, literals and elided bodies need
// not, since a temp dir's length is fixed by its mkdtemp pattern only on one machine.
//
// A Canonicalizer keeps its id and uuid numbering across files, for a scenario whose files name each
// other's entries (a /clear's carried rule names the old file's click).

export type Elide = "system" | "notes" | "tool-results";

export interface CanonicalOptions {
  /** Absolute path prefixes → placeholder, e.g. { [agentDir]: "<DIR>" }. Longest prefix first. */
  paths?: Record<string, string>;
  /** Exact strings → placeholder, applied after paths and before ids. */
  literals?: Record<string, string>;
  /** Bodies to elide (default ["system"]). */
  elide?: readonly Elide[];
  /** Also replace a known entry id where it is not a whole quoted string (a row's block id
      `<id>:0`, a trace's free text), bounded by non-hex characters. Off by default. */
  idsAnywhere?: boolean;
}

const ENTRY_ID = /"id":"([0-9a-f]{8})"/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const MS = /"timestamp":(\d+)/g;
export const CANON_ISO = "2000-01-01T00:00:00.000Z";
const SYSTEM_BODY = '"message":{"role":"system"';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `"content":<value>` in `line` with the value replaced, found by its own serialization (pi writes with
    JSON.stringify, so the value's text appears verbatim); the line as is when it isn't there. */
function elideContent(line: string, value: unknown, to: string): string {
  if (value === undefined) return line;
  const from = `"content":${JSON.stringify(value)}`;
  const at = line.indexOf(from);
  return at < 0 ? line : `${line.slice(0, at)}"content":${to}${line.slice(at + from.length)}`;
}

/** One line with the bodies `elide` names replaced. */
function elideLine(line: string, elide: ReadonlySet<Elide>): string {
  if (elide.has("system") && line.startsWith('{"type":"message"') && line.endsWith("}}")) {
    // The message is the line's last key (pi writes type, id, parentId, timestamp, message).
    const at = line.indexOf(SYSTEM_BODY);
    if (at >= 0) return `${line.slice(0, at)}"message":{"role":"system","elided":true}}`;
  }
  if (!elide.has("notes") && !elide.has("tool-results")) return line;
  let e: { type?: string; content?: unknown; message?: { role?: string; content?: unknown } };
  try {
    e = JSON.parse(line);
  } catch {
    return line;
  }
  if (elide.has("notes") && e.type === "custom_message") {
    // An overseer's run note also records the prompt's opening values and fingerprints of what it told
    // (server/overseer-opening.ts): prompt prose and the wall clock, like the content.
    let out = elideContent(line, e.content, '"<elided>"');
    const d = (e as { details?: { opening?: unknown; told?: unknown } }).details;
    for (const key of ["opening", "told"] as const) {
      if (d?.[key] === undefined) continue;
      const from = `"${key}":${JSON.stringify(d[key])}`;
      out = out.split(from).join(`"${key}":"<elided>"`);
    }
    return out;
  }
  if (elide.has("tool-results") && e.type === "message" && e.message?.role === "toolResult") return elideContent(line, e.message.content, '"<elided>"');
  return line;
}

export class Canonicalizer {
  private readonly ids = new Map<string, string>();
  private readonly uuids = new Map<string, string>();
  private readonly elide: ReadonlySet<Elide>;

  constructor(private readonly opts: CanonicalOptions = {}) {
    this.elide = new Set(opts.elide ?? ["system"]);
  }

  /** The canonical form of a JSONL text (a whole session file). Numbering continues from earlier calls. */
  jsonl(text: string): string {
    let out = text
      .split("\n")
      .map((l) => elideLine(l, this.elide))
      .join("\n");
    const paths = Object.entries(this.opts.paths ?? {}).sort((a, b) => b[0].length - a[0].length);
    for (const [from, to] of paths) out = out.split(from).join(to);
    for (const [from, to] of Object.entries(this.opts.literals ?? {})) out = out.split(from).join(to);

    // Uuids before entry ids: a uuid's first group is 8 hex too, though never quoted alone.
    out = out.replace(UUID, (u) => {
      let t = this.uuids.get(u);
      if (!t) this.uuids.set(u, (t = `00000000-0000-7000-8000-${String(this.uuids.size + 1).padStart(12, "0")}`));
      return t;
    });

    // Entry ids: collected from each line's own "id", in file order, then replaced wherever quoted.
    for (const m of out.matchAll(ENTRY_ID)) if (!this.ids.has(m[1]!)) this.ids.set(m[1]!, String(this.ids.size + 1).padStart(8, "0"));
    if (this.ids.size) {
      const alt = [...this.ids.keys()].map(escapeRe).join("|");
      const any = this.opts.idsAnywhere ? new RegExp(`(?<![0-9a-f])(${alt})(?![0-9a-f])`, "g") : new RegExp(`"(${alt})"`, "g");
      out = out.replace(any, (_: string, id: string) => (this.opts.idsAnywhere ? this.ids.get(id)! : `"${this.ids.get(id)}"`));
    }

    out = out.replace(ISO, CANON_ISO);
    out = out.replace(MS, (_, ms: string) => `"timestamp":${"1".padEnd(ms.length, "0")}`);
    return out;
  }
}

/** The canonical form of one JSONL text, numbered on its own. */
export function canonicalJsonl(text: string, opts: CanonicalOptions = {}): string {
  return new Canonicalizer(opts).jsonl(text);
}

/** The first line where two canonical texts differ, for a failure message: 1-based, with both lines. */
export function firstDifference(want: string, got: string): { line: number; want: string; got: string } | null {
  if (want === got) return null;
  const a = want.split("\n");
  const b = got.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) return { line: i + 1, want: a[i] ?? "<end of file>", got: b[i] ?? "<end of file>" };
  return { line: a.length, want: "", got: "" };
}
