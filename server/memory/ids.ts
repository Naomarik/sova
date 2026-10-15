// Ids shown whole (§chat.memory/full-ids): a summary line's shortened UUID shown whole when the line's own
// messages make that certain.
// Pure and self-contained (no imports, no state): an evaluation harness may import this file by path.

/** A whole UUID, any version, either case. */
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const WHOLE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** A token that may be a shortened id: 8+ hex digits, optionally continued by hyphenated hex groups,
    with no letter, digit, `_` or `-` right before or after it. */
const TOKEN = /(?<![0-9A-Za-z_-])[0-9a-fA-F]{8,}(?:-[0-9a-fA-F]+)*(?![0-9A-Za-z_-])/g;

/** The distinct UUIDs in `text`, lower-cased, in order of first appearance. */
export function uuidsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(UUID)) out.add(m[0].toLowerCase());
  return [...out];
}

/** The one UUID of `ids` (lower-cased) that `token` begins, or undefined for none or several. */
function soleMatch(token: string, ids: readonly string[]): string | undefined {
  if (WHOLE.test(token) || token.length >= 36) return undefined;
  const t = token.toLowerCase();
  let hit: string | undefined;
  for (const id of ids) {
    if (!id.startsWith(t)) continue;
    if (hit !== undefined && hit !== id) return undefined;
    hit = id;
  }
  return hit;
}

function distinct(uuids: Iterable<string>): string[] {
  return [...new Set([...uuids].map((u) => u.toLowerCase()).filter((u) => WHOLE.test(u)))];
}

/**
 * `line` with each standalone token of 8+ hex digits (optionally continued by hyphenated hex groups, such
 * as `0190f3a2-1b2c`) that is not itself a whole UUID and begins exactly one of `uuids` replaced by that
 * UUID (lower-cased); a token that begins none, or several, stays as written. Deterministic: the result
 * depends only on `line` and the set of `uuids`, never their order.
 */
export function expandIds(line: string, uuids: Iterable<string>): string {
  const ids = distinct(uuids);
  if (!ids.length) return line;
  return line.replace(TOKEN, (token) => soleMatch(token, ids) ?? token);
}
