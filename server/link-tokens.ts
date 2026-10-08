import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";

/**
 * Kept link tokens (§app.session-share/link, Kept tokens): `<stateRoot>/link-tokens.json`, one file
 * for every kind of link this host mints — session shares `/s/`, hand-offs `/h/`, owner links `/i/`
 * — so the operator can copy a live link again. The link stores keep only each token's SHA-256 and
 * never change shape (session-shares.json is parsed strictly by every Sova, so a new key there would
 * serve no link after a rollback); the token sits here, keyed by that hash.
 *
 * 0600, written atomically, host-local, never synced or committed. Read tolerantly: a file that
 * can't be read keeps no token and every link still opens; an entry counts only when its token is
 * well formed and hashes to its key. A token is kept from its mint and dropped when its link is
 * turned off, never when it merely expires. Never logged: no warning quotes the file.
 */

export const LINK_TOKENS_FILE = "link-tokens.json";

export type LinkTokenKind = "s" | "h" | "i";

export interface KeptToken {
  hash: string;
  kind: LinkTokenKind;
  token: string;
}

interface TokensFile {
  version: 1;
  tokens: Record<string, { kind: LinkTokenKind; token: string }>;
}

export const linkTokensFile = (): string => join(stateRoot(), LINK_TOKENS_FILE);

// The link stores' own rules (server/baton-links.ts), restated so this module imports none of them.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
const KINDS: readonly string[] = ["s", "h", "i"];
const sha256 = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

let cached: { path: string; stamp: string; file: TokensFile } | null = null;
const stampOf = (path: string): string => {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "missing";
  }
};

let warned = "";
const warnOnce = (why: string, what: string) => {
  if (why === warned) return;
  warned = why;
  console.warn(`[links] ${LINK_TOKENS_FILE} ${what} (${why}); links still open, but they can't be copied again until it is fixed or removed`);
};

function read(): TokensFile {
  const path = linkTokensFile();
  const stamp = stampOf(path);
  if (cached?.path === path && cached.stamp === stamp) return cached.file;
  const out: TokensFile = { version: 1, tokens: {} };
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isObj(raw) || raw.version !== 1 || !isObj(raw.tokens)) throw new Error("document shape");
      for (const [hash, v] of Object.entries(raw.tokens)) {
        // Each entry on its own: a broken or tampered one is left out alone.
        if (!HASH.test(hash) || !isObj(v) || typeof v.kind !== "string" || !KINDS.includes(v.kind) || typeof v.token !== "string") continue;
        if (!TOKEN.test(v.token) || sha256(v.token) !== hash) continue;
        out.tokens[hash] = { kind: v.kind as LinkTokenKind, token: v.token };
      }
    } catch (err) {
      warnOnce(err instanceof SyntaxError ? "not JSON" : err instanceof Error ? err.message : "unreadable", "is unreadable");
    }
  }
  cached = { path, stamp, file: out };
  return out;
}

function write(file: TokensFile): void {
  cached = null;
  const path = linkTokensFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600); // an existing tmp keeps its old mode through writeFileSync
  renameSync(tmp, path);
}

/** Keep the tokens just minted (after their store's own write). Never throws: a token not kept
    only means its link can't be copied again. */
export function keepTokens(kind: LinkTokenKind, tokens: readonly string[]): void {
  const good = tokens.filter((t) => TOKEN.test(t));
  if (!good.length) return;
  try {
    const file = read();
    const next = { ...file.tokens };
    for (const t of good) next[sha256(t)] = { kind, token: t };
    write({ version: 1, tokens: next });
  } catch (err) {
    warnOnce(err instanceof Error ? err.name : "error", "can't be written");
  }
}

/** Drop the tokens of links just turned off, by hash. Writes only when one is kept. Never throws. */
export function dropTokens(hashes: Iterable<string>): void {
  try {
    const file = read();
    const gone = [...new Set(hashes)].filter((h) => h in file.tokens);
    if (!gone.length) return;
    const next = { ...file.tokens };
    for (const h of gone) delete next[h];
    write({ version: 1, tokens: next });
  } catch (err) {
    warnOnce(err instanceof Error ? err.name : "error", "can't be written");
  }
}

/** The kept token of a link, by its hash; null when none is kept (a link made before tokens were
    kept, one turned off, or a broken file). `kind` must match when given. */
export function tokenFor(hash: string, kind?: LinkTokenKind): string | null {
  const e = read().tokens[hash];
  return e && (!kind || e.kind === kind) ? e.token : null;
}

/** Every kept token. */
export function keptTokens(): KeptToken[] {
  return Object.entries(read().tokens).map(([hash, e]) => ({ hash, kind: e.kind, token: e.token }));
}

// ---- the share views' filter (§app.session-share/never) ---------------------------------------------

/** What stands in for a kept link in a session share. */
export const SHARE_LINK_REDACTED = "[share link]";

/** A token as it stands in text, with the link around it when there is one (`https://host/s/`, or
    the path alone when no address was set). Never part of a longer run of token characters. */
const IN_TEXT = /(?:(?:https?:\/\/[A-Za-z0-9.:[\]-]+)?\/[shi]\/)?(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;

/** The kept tokens, for a run of the filter. */
export const keptTokenSet = (): ReadonlySet<string> => new Set(Object.values(read().tokens).map((e) => e.token));

/** `text` with every kept link (and every bare kept token) replaced. Pure over `tokens`. */
export function redactShareLinks(text: string, tokens: ReadonlySet<string> = keptTokenSet()): string {
  if (!tokens.size || text.length < 43) return text;
  return text.replace(IN_TEXT, (whole, token: string) => (tokens.has(token) ? SHARE_LINK_REDACTED : whole));
}

/** Whether `text` holds a kept token. Pure over `tokens`. */
export function holdsShareLink(text: string, tokens: ReadonlySet<string> = keptTokenSet()): boolean {
  if (!tokens.size) return false;
  for (const t of tokens) if (text.includes(t)) return true;
  return false;
}

/** `v` with every kept link in any of its strings replaced (a copy only when one is there). Pure over `tokens`. */
export function redactShareLinksDeep<T>(v: T, tokens: ReadonlySet<string> = keptTokenSet()): T {
  if (!tokens.size) return v;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return holdsShareLink(x, tokens) ? redactShareLinks(x, tokens) : x;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return holdsShareLink(JSON.stringify(v) ?? "", tokens) ? (walk(v) as T) : v;
}
