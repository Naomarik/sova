// Normalization for the parity suite. The rule: normalize ONLY what differs between two runs of the
// SAME code (per-side paths and ports, run-time timestamps, runtime-generated ids, and — for the
// live chat only — what the model itself chose to say), and nothing a code change could produce.
//
// Each rule is written so it cannot swallow a real difference:
//  - paths/ports are exact-string substitutions of values this run chose;
//  - a timestamp is replaced only if it falls inside this run's own time window, so the fixture
//    sessions' fixed 2025 timestamps are compared exactly;
//  - runtime ids are RENUMBERED in order of first appearance, never erased: two sides agree only
//    if the same id appears in the same places;
//  - fixture ids (known in advance) are never renumbered.

/** A file path with its run-generated parts made generic (not numbered): uuids, run timestamps,
 *  and the pid + random suffix of a live-registry record. Files that collapse onto one key are
 *  compared as a multiset of contents. */
export function genericPath(rel, window) {
  return rel
    .replace(UUID_RE, "<uuid>")
    .replace(ISO_RE, (t) => (Date.parse(t.replace(/T(\d\d)-(\d\d)-(\d\d)(?:-(\d{1,3}))?Z/, (_m, h, mi, se, f) => `T${h}:${mi}:${se}${f ? "." + f : ""}Z`)) >= window[0] ? "<now-iso>" : t))
    .replace(/(^|\/)p\d+-[0-9a-f]+\.json$/, "$1p<pid>-<hex>.json");
}

/** Substitutions of per-side literals, longest first so a prefix never pre-empts its extension. */
export function literalReplacer(pairs) {
  const list = pairs.filter(([from]) => from && from.length > 0).sort((a, b) => b[0].length - a[0].length);
  return (s) => {
    for (const [from, to] of list) s = s.split(from).join(to);
    return s;
  };
}

// Bounded by "not alphanumeric" rather than \b: pi's file names glue them with "_" (a word char),
// as in 2026-09-25T04-18-20-673Z_01a0d6c9-2181-....jsonl.
const UUID_RE = /(?<![0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z])/g;
const ISO_RE = /(?<![0-9A-Za-z])\d{4}-\d\d-\d\dT\d\d[:-]\d\d[:-]\d\d(?:[.-]\d{1,3})?Z(?![0-9A-Za-z])/g;
/** A live-registry session id: p<pid>-<8 hex>. */
const LIVE_ID_RE = /(?<![0-9A-Za-z])p\d+-[0-9a-f]{8}(?![0-9A-Za-z])/g;
const MS_RE = /(?<![0-9A-Za-z])1\d{12}(?![0-9A-Za-z])/g;
/** Keys whose string value is an entry/tool/response id pi or the server generated. */
const ID_KEYS = new Set(["id", "parentId", "entryId", "targetId", "fromLeafId", "fromId", "firstKeptEntryId", "toolCallId", "responseId", "clientId", "itemId", "userEntryId", "leafId", "sessionId", "groupId"]);
/** pi's 8-hex entry ids, and the transcript's block ids built on them (`<entryId>:<n>`). */
const SHORT_ID_RE = /^([0-9a-f]{8})(:(?:\d+|<block>))?$/;

/**
 * A normalizer bound to one side of one run.
 *  window: [fromMs, toMs] — timestamps inside it are "now" and get replaced
 *  keepIds: ids known in advance (fixtures); never renumbered
 *  literals: [[from, to]] per-side path/port substitutions
 */
export function makeNormalizer({ window, keepIds = new Set(), literals = [] }) {
  const lit = literalReplacer(literals);
  const ids = new Map();
  const idFor = (raw, kind) => {
    if (keepIds.has(raw)) return raw;
    let v = ids.get(raw);
    if (!v) {
      v = `<${kind}${ids.size + 1}>`;
      ids.set(raw, v);
    }
    return v;
  };
  const inWindow = (t) => Number.isFinite(t) && t >= window[0] && t <= window[1];
  const isoMs = (s) => Date.parse(s.replace(/T(\d\d)-(\d\d)-(\d\d)(?:-(\d{1,3}))?Z/, (_m, h, mi, se, f) => `T${h}:${mi}:${se}${f ? "." + f : ""}Z`));

  const str = (s, key) => {
    s = lit(s);
    s = s.replace(UUID_RE, (u) => idFor(u, "uuid"));
    s = s.replace(LIVE_ID_RE, (u) => idFor(u, "live"));
    s = s.replace(ISO_RE, (t) => (inWindow(isoMs(t)) ? "<now-iso>" : t));
    s = s.replace(MS_RE, (t) => (inWindow(Number(t)) ? "<now-ms>" : t));
    if (key && ID_KEYS.has(key)) {
      const short = SHORT_ID_RE.exec(s);
      if (short) s = idFor(short[1], "id") + (short[2] ?? "");
      else if (/^call_[0-9a-zA-Z_]+$/.test(s) || /^[0-9a-f]{20,}$/.test(s)) s = idFor(s, "id");
    }
    return s;
  };

  const walk = (v, key) => {
    if (typeof v === "string") return str(v, key);
    if (typeof v === "number") return key === "pid" ? "<pid>" : inWindow(v) ? "<now-ms>" : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        let nk = str(k, null);
        // Two keys that normalize alike must not overwrite each other: that would hide one of them.
        while (nk in out) nk += "#dup";
        out[nk] = walk(x, k);
      }
      return out;
    }
    return v;
  };
  return { value: (v) => walk(v, null), text: (s) => str(s, null) };
}

/**
 * What the MODEL decided, for the live chat only: generated text, thinking, tool-call arguments,
 * token counts and cost. Two runs of the same code differ here (measured: an A/A run of the
 * baseline against itself), so these leaves become their type; keys, roles, block types, stop
 * reasons and every message Sova itself composes stay exact.
 */
export function maskModelOutput(v) {
  if (Array.isArray(v)) return v.map(maskModelOutput);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    // `args` is a tool call's arguments as the tool_execution_* events carry them: the model's choice.
    if (k === "usage" || k === "cost" || k === "context" || k === "args") out[k] = maskLeaves(x);
    else if ((k === "text" || k === "thinking" || k === "delta" || k === "partialJson" || k === "thinkingSignature" || k === "textSignature") && typeof x === "string") out[k] = "<model-text>";
    else if (k === "arguments" && x && typeof x === "object") out[k] = maskLeaves(x);
    else out[k] = maskModelOutput(x);
  }
  return out;
}
const maskLeaves = (v) =>
  Array.isArray(v) ? v.map(maskLeaves) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskLeaves(x)])) : typeof v === "number" ? "<n>" : typeof v === "string" ? "<s>" : v;

/** Structural diff: a list of "path: a !== b" lines, capped. */
export function jsonDiff(a, b, path = "$", out = [], cap = 40) {
  if (out.length >= cap) return out;
  if (a === b) return out;
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb || (ta !== "object" && ta !== "array")) {
    out.push(`${path}: ${short(a)} !== ${short(b)}`);
    return out;
  }
  if (ta === "array") {
    if (a.length !== b.length) out.push(`${path}.length: ${a.length} !== ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) jsonDiff(a[i], b[i], `${path}[${i}]`, out, cap);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) out.push(`${path}.${k}: <absent> !== ${short(b[k])}`);
    else if (!(k in b)) out.push(`${path}.${k}: ${short(a[k])} !== <absent>`);
    else jsonDiff(a[k], b[k], `${path}.${k}`, out, cap);
    if (out.length >= cap) break;
  }
  return out;
}
const short = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > 160 ? s.slice(0, 157) + "..." : s;
};

/** Canonical JSON (sorted keys) for hashing and multiset comparison. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/**
 * Whether glm-5.3 thinks is the model's choice: its ladder has no "off" (the chat asks for off and
 * is clamped to "low"), and at "low" A/A runs saw a thinking block in one run and none in the next.
 * For the live chat only, thinking blocks, thinking stream events, thinking transcript rows and
 * the `reasoning` token count are removed before anything is compared. Apply BEFORE normalizing,
 * so a removed row does not consume an id number.
 */
export function stripThinking(v) {
  if (Array.isArray(v))
    return v
      .filter((x) => !(x && typeof x === "object" && (x.type === "thinking" || x.kind === "thinking" || /^thinking_/.test(x.event?.assistantMessageEvent?.type ?? ""))))
      .map(stripThinking);
  // A removed thinking block shifts every later block's index: `contentIndex` in stream events and
  // the `<entryId>:<n>` block ids of transcript rows.
  if (typeof v === "string") return v.replace(/^([0-9a-f]{8}):\d+$/, "$1:<block>");
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (k !== "reasoning" && k !== "contentIndex") out[k] = stripThinking(x);
  return out;
}
