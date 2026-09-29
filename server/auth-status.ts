import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultClaudeDir } from "../pi-config/extensions/claude-code/accounts.ts";
import type { UsageAuth, UsageProvider } from "../shared/protocol";

// What each usage provider's sign-in says, for the Usage page: expiry times and when it was last
// renewed. Reads the same credential files the usage-status fetch does
// (pi-config/extensions/usage-status/fetch.ts), and only reads them: Sova never writes a
// credential file and never refreshes a token. Each file is re-parsed only when its (mtime, size)
// changes, and a parse keeps numbers and flags only, so no token string outlives the read and
// none can reach the wire.

/** The credential files fetch.ts reads: Claude Code's own directory ($CLAUDE_CONFIG_DIR, else ~/.claude), pi's and the Codex CLI's. */
export interface AuthStatusPaths {
  claudeCreds: string;
  piAuth: string;
  codexAuth: string;
}

export function defaultAuthPaths(home = homedir(), claudeDir = defaultClaudeDir()): AuthStatusPaths {
  return {
    claudeCreds: join(claudeDir, ".credentials.json"),
    piAuth: join(home, ".pi/agent/auth.json"),
    codexAuth: join(home, ".codex/auth.json"),
  };
}

/** Claude Code's access tokens live 8h, so a file written at a renewal has mtime = expiresAt − 8h. */
const CLAUDE_TOKEN_LIFETIME_MS = 8 * 3_600_000;
/** How far mtime may sit from expiresAt − 8h and still count as the renewal time. */
const RENEWAL_AGREEMENT_MS = 10 * 60_000;

type Rec = Record<string, any>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** A secret's presence, never its value. */
const has = (v: unknown): boolean => typeof v === "string" && v.length > 0;

interface ClaudeFacts { expiresAt?: number; refreshExpiresAt?: number; mtimeMs: number }
interface PiFacts { openai?: { expiresAt?: number }; apiKeys: UsageProvider["id"][] }
interface CodexFacts { refreshedAt?: number }

function claudeFacts(v: unknown, mtimeMs: number): ClaudeFacts | undefined {
  const o = isRec(v) ? v.claudeAiOauth : undefined;
  if (!isRec(o) || !has(o.accessToken)) return undefined; // fetch.ts reads this as "nologin"
  return { expiresAt: num(o.expiresAt), refreshExpiresAt: num(o.refreshTokenExpiresAt), mtimeMs };
}

/** auth.json keys fetch.ts reads an API key from, by usage provider. */
const API_KEY_ENTRIES: [string, UsageProvider["id"]][] = [["ollama-cloud", "ollama"], ["zai", "zai"], ["deepseek", "deepseek"]];

function piFacts(v: unknown): PiFacts | undefined {
  if (!isRec(v)) return undefined;
  const codex = v["openai-codex"];
  return {
    ...(isRec(codex) && has(codex.access) ? { openai: { expiresAt: num(codex.expires) } } : {}),
    apiKeys: API_KEY_ENTRIES.filter(([key]) => isRec(v[key]) && has(v[key].key)).map(([, id]) => id),
  };
}

function codexFacts(v: unknown): CodexFacts | undefined {
  if (!isRec(v) || !isRec(v.tokens) || !has(v.tokens.access_token)) return undefined;
  const at = typeof v.last_refresh === "string" ? Date.parse(v.last_refresh) : NaN;
  return Number.isFinite(at) ? { refreshedAt: at } : {};
}

const memo = new Map<string, { mtimeMs: number; size: number; facts: unknown }>();

/** A file's facts, re-read only when its (mtime, size) changed. Missing or unreadable → undefined. */
async function factsOf<T>(path: string, parse: (v: unknown, mtimeMs: number) => T | undefined): Promise<T | undefined> {
  let st;
  try {
    st = await stat(path);
  } catch {
    memo.delete(path);
    return undefined;
  }
  const hit = memo.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.facts as T | undefined;
  let facts: T | undefined;
  try {
    facts = parse(JSON.parse(await readFile(path, "utf8")), st.mtimeMs);
  } catch {
    facts = undefined;
  }
  memo.set(path, { mtimeMs: st.mtimeMs, size: st.size, facts });
  return facts;
}

/** Only the defined fields, so the payload never carries `undefined` keys. */
function oauth(source: NonNullable<UsageAuth["source"]>, t: { expiresAt?: number; refreshExpiresAt?: number; refreshedAt?: number }, now: number): UsageAuth {
  const a: UsageAuth = { kind: "oauth", source };
  if (t.expiresAt !== undefined) {
    a.expiresAt = t.expiresAt;
    a.expired = t.expiresAt <= now;
  }
  if (t.refreshExpiresAt !== undefined) {
    a.refreshExpiresAt = t.refreshExpiresAt;
    a.refreshExpired = t.refreshExpiresAt <= now;
  }
  if (t.refreshedAt !== undefined) a.refreshedAt = t.refreshedAt;
  return a;
}

/**
 * Each provider's sign-in, keyed by usage provider id; a provider whose credentials say nothing
 * (no file, no token, unreadable) is absent. OpenAI prefers pi's own entry, as fetch.ts does.
 */
export async function readAuthStatus(paths: AuthStatusPaths = defaultAuthPaths(), now = Date.now()): Promise<Partial<Record<UsageProvider["id"], UsageAuth>>> {
  const [claude, pi, codex] = await Promise.all([
    factsOf(paths.claudeCreds, claudeFacts),
    factsOf(paths.piAuth, piFacts),
    factsOf(paths.codexAuth, codexFacts),
  ]);
  const out: Partial<Record<UsageProvider["id"], UsageAuth>> = {};
  if (claude) out.claude = claudeAuth(claude, now);
  if (pi?.openai) out.openai = oauth("pi", pi.openai, now);
  else if (codex) out.openai = oauth("codex-cli", codex, now);
  for (const id of pi?.apiKeys ?? []) out[id] = { kind: "apiKey" };
  return out;
}

function claudeAuth(claude: ClaudeFacts, now: number): UsageAuth {
  // The mtime is the renewal time only while it agrees with an 8h lifetime ending at expiresAt;
  // a CLI that changed the lifetime, or a file touched for another reason, gets no renewal time.
  const agrees = claude.expiresAt !== undefined && Math.abs(claude.mtimeMs - (claude.expiresAt - CLAUDE_TOKEN_LIFETIME_MS)) <= RENEWAL_AGREEMENT_MS;
  return oauth("claude-cli", { ...claude, refreshedAt: agrees ? Math.round(claude.mtimeMs) : undefined }, now);
}

/** One Claude login's sign-in, from `<dir>/.credentials.json` (an added login's directory), read the same way as Claude Code's own. */
export async function readClaudeLoginAuth(dir: string, now = Date.now()): Promise<UsageAuth | undefined> {
  const facts = await factsOf(join(dir, ".credentials.json"), claudeFacts);
  return facts ? claudeAuth(facts, now) : undefined;
}

/** Tests: forget every memoized file. */
export function resetAuthStatusCache(): void {
  memo.clear();
}
