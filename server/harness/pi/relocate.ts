// A conversation file pointed at another device's folders (§app.transport/arrival, "Paths rebuilt"):
// pi's header names the chat's folder (`cwd`) and the file it was forked from (`parentSession`), and
// extensions keep their state in `custom` entries (the worktrees a chat tracks, each worker's record
// and session file). Those are rewritten through a path map; what was said (messages, tool calls and
// results) is kept verbatim. A line that changes nothing keeps its bytes; a changed one is written as
// pi writes every line (JSON.stringify). A Copy also gives each conversation a new id (`ids`).

/** [from, to] folder pairs: a path equal to `from`, or under it, is moved under `to`. */
export type PathMap = readonly (readonly [string, string])[];

/** `p` through the map (the longest `from` that holds it), or `p` unchanged. */
export function mapPath(p: string, map: PathMap): string {
  let best: readonly [string, string] | null = null;
  for (const pair of map) {
    const [from] = pair;
    if (!from || from === pair[1]) continue;
    if ((p === from || p.startsWith(from.endsWith("/") ? from : `${from}/`)) && (!best || from.length > best[0].length)) best = pair;
  }
  return best ? best[1] + p.slice(best[0].length) : p;
}

const PI_CONFIG = "/pi-config/";

/** A path into some Sova tree's `pi-config/` (an extension a worker loads) re-rooted at this device's `code`. */
export function mapCode(p: string, code: string | undefined): string {
  if (!code || !p.startsWith("/")) return p;
  const at = p.lastIndexOf(PI_CONFIG);
  return at < 0 || p.startsWith(code + PI_CONFIG) ? p : code + p.slice(at);
}

/** Every string in `v` that is a path the map moves, and every old id (in any string), replaced. A path into a
    Sova tree's `pi-config/` that the map leaves goes to this device's `code` root; only then do the `broad` pairs
    (the agent dir, the home folder) apply, so a worker's extension in a generation copy lands in this device's code. */
export function mapDeep<T>(v: T, map: PathMap, ids: Readonly<Record<string, string>> = {}, code?: string, broad: PathMap = []): T {
  const idKeys = Object.keys(ids);
  const str = (s: string): string => {
    let out = s;
    // A value that is itself JSON (a team member's identity in its environment names its mailbox folder): mapped inside.
    if ((s.startsWith("{") || s.startsWith("[")) && s.includes("/")) {
      try {
        const inner = JSON.parse(s) as unknown;
        if (inner && typeof inner === "object") {
          const next = JSON.stringify(walk(inner));
          if (next !== JSON.stringify(inner)) return next;
        }
      } catch {
        // not JSON: a plain string
      }
    }
    if (s.startsWith("/")) {
      out = mapPath(s, map);
      if (out === s) out = mapCode(s, code);
      if (out === s) out = mapPath(s, broad);
    }
    for (const k of idKeys) if (out.includes(k)) out = out.split(k).join(ids[k]!);
    return out;
  };
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return str(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) o[str(k)] = walk(val);
      return o;
    }
    return x;
  };
  return walk(v) as T;
}

/**
 * One conversation's text, its header and extension state pointed through `map` (and its ids through
 * `ids`); null when nothing changes. A last line without its newline (a torn tail) is kept as it is.
 */
export function relocateConversation(text: string, map: PathMap, ids: Readonly<Record<string, string>> = {}, code?: string, broad: PathMap = []): string | null {
  const lines = text.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line || (i === lines.length - 1 && !text.endsWith("\n"))) continue;
    if (!line.includes('"type":"session"') && !line.includes('"type":"custom"')) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    let next: Record<string, unknown> | null = null;
    if (e.type === "session") {
      next = { ...e };
      if (typeof e.cwd === "string") next.cwd = mapDeep(e.cwd, map, {}, undefined, broad);
      if (typeof e.parentSession === "string") next.parentSession = mapDeep(e.parentSession, map, ids, code, broad);
      if (typeof e.id === "string" && ids[e.id]) next.id = ids[e.id];
    } else if (e.type === "custom" && "data" in e) next = { ...e, data: mapDeep(e.data, map, ids, code, broad) };
    if (!next) continue;
    const out = JSON.stringify(next);
    if (out !== JSON.stringify(e)) {
      lines[i] = out;
      changed = true;
    }
  }
  return changed ? lines.join("\n") : null;
}
