import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/** What a secret value becomes in anything the Overseer reads or writes. */
export const REDACTED = "[redacted]";

/** Shorter values are never treated as secrets (too likely to be ordinary words). */
export const MIN_SECRET_LENGTH = 12;

/** A secret cut short (a truncated line, `abc…`) is caught from this many of its first or last characters. */
export const MIN_FRAGMENT_LENGTH = 16;

export type SecretSource = { path: string; pick: (json: unknown) => string[] };

/**
 * Where the secret values come from: the credential files the deny list (overseer-deny.ts) names,
 * read by the server itself and parsed as JSON. `pick` takes the values out of one file. Nothing is
 * ever executed: a `models.json` `!command` is skipped, not run.
 */
export function secretSources(home = homedir(), agentDir = getAgentDir()): SecretSource[] {
  const all = (json: unknown) => stringLeaves(json);
  return [
    // pi's stored provider keys, in the user's agent dir and the active one: every value in them.
    { path: join(home, ".pi", "agent", "auth.json"), pick: all },
    { path: join(agentDir, "auth.json"), pick: all },
    // pi's model registry: literal `apiKey` and header values only.
    { path: join(home, ".pi", "agent", "models.json"), pick: modelsJsonValues },
    { path: join(agentDir, "models.json"), pick: modelsJsonValues },
    // Claude Code's OAuth tokens, and the account record's API key (the rest of that file is not secret).
    { path: join(home, ".claude", ".credentials.json"), pick: all },
    { path: join(home, ".claude.json"), pick: (j: unknown) => stringLeaves((j as { primaryApiKey?: unknown } | null)?.primaryApiKey) },
  ].filter((s, i, list) => list.findIndex((o) => o.path === s.path) === i);
}

/** Keys whose values describe a credential rather than being one (pi's `type`, Claude Code's `scopes`, `rateLimitTier`…). */
const NOT_SECRET_KEYS = new Set(["type", "provider", "scopes", "subscriptionType", "rateLimitTier", "baseUrl", "api"]);

/** Every string leaf of `json` that could be a secret (see `plausibleSecret`); numbers and booleans are skipped. */
export function stringLeaves(json: unknown, key = ""): string[] {
  if (NOT_SECRET_KEYS.has(key)) return [];
  if (typeof json === "string") return plausibleSecret(json) ? [json] : [];
  if (Array.isArray(json)) return json.flatMap((v) => stringLeaves(v, key));
  if (json && typeof json === "object") return Object.entries(json).flatMap(([k, v]) => stringLeaves(v, k));
  return [];
}

/**
 * `models.json`: each provider's (and model's) `apiKey` and header values, literal parts only. pi
 * reads such a value as a `!command` (run at request time: skipped here, never run), or a template
 * whose `$NAME`/`${NAME}` parts are environment variables (their values are caught by the env rule
 * when the server has them) around literal text.
 */
export function modelsJsonValues(json: unknown): string[] {
  const out: string[] = [];
  const literal = (v: unknown) => {
    if (typeof v !== "string" || v.startsWith("!")) return;
    for (const part of v.split(/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/)) if (plausibleSecret(part)) out.push(part);
  };
  const entry = (e: unknown) => {
    if (!e || typeof e !== "object") return;
    const o = e as { apiKey?: unknown; headers?: unknown; models?: unknown };
    literal(o.apiKey);
    if (o.headers && typeof o.headers === "object") for (const v of Object.values(o.headers)) literal(v);
    if (Array.isArray(o.models)) o.models.forEach(entry);
  };
  const providers = (json as { providers?: unknown } | null)?.providers;
  if (providers && typeof providers === "object") Object.values(providers).forEach(entry);
  return out;
}

/** An environment variable whose value the server treats as secret, by its name: *KEY*, *TOKEN*,
    *SECRET*, *PASSWORD*, *AUTH* (but not AUTHOR or AUTHORITY: `GIT_AUTHOR_EMAIL`, `XAUTHORITY`). */
export function isSecretEnvName(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD|AUTH(?!OR)/i.test(name);
}

/** The values of the secret-named variables in `env`. */
export function envSecretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([k, v]) => (v !== undefined && isSecretEnvName(k) && plausibleSecret(v) ? [v] : []));
}

/** Long enough, and not obviously something else: a boolean, a number, a path, a URL without credentials. */
export function plausibleSecret(v: string): boolean {
  const t = v.trim();
  if (t.length < MIN_SECRET_LENGTH) return false;
  if (/^(true|false|null|undefined)$/i.test(t)) return false;
  if (/^[\d.:+\-TZ ]+$/.test(t)) return false; // numbers, timestamps
  if (t.startsWith("/") || t.startsWith("~/")) return false; // paths (SSH_AUTH_SOCK)
  if (/^[a-z][a-z0-9+.-]*:\/\/[^\s@/]*(\/\S*)?$/i.test(t) && !t.includes("@")) return false; // a URL with no user:pass@
  return true;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Knows the secret values and replaces each occurrence with REDACTED. The values are read from the
 * credential files and the server's environment, cached, and read again only when a file's mtime,
 * size or inode (or the environment's secret values) change. They are never logged or sent anywhere.
 */
export class Redactor {
  private signature: string | null = null;
  private values: string[] = [];
  /** Any whole value. */
  private matcher: RegExp | null = null;
  /** The first or last MIN_FRAGMENT_LENGTH characters of any value: where a cut-off secret shows. */
  private fragments: RegExp | null = null;
  constructor(
    private readonly sources: SecretSource[] = secretSources(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Re-read the sources if any changed since the last call (a few stats; the files only when needed). */
  refresh(): this {
    const stats = this.sources.map((s) => {
      try {
        const st = statSync(s.path, { throwIfNoEntry: false });
        return st ? `${st.mtimeMs}:${st.size}:${st.ino}` : "-";
      } catch {
        return "?";
      }
    });
    const envValues = envSecretValues(this.env);
    const signature = `${stats.join("|")}#${envValues.length}:${hash(envValues.join("\0"))}`;
    if (signature === this.signature) return this;
    this.signature = signature;
    const found = new Set<string>(envValues.map((v) => v.trim()));
    for (const s of this.sources) {
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(s.path, "utf8"));
      } catch {
        continue;
      }
      for (const v of s.pick(json)) found.add(v.trim());
    }
    // Longest first, so a secret that contains another is replaced whole.
    this.values = [...found].filter((v) => v.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
    this.matcher = this.values.length ? new RegExp(this.values.map(escape).join("|"), "g") : null;
    const ends = new Set(this.values.filter((v) => v.length > MIN_FRAGMENT_LENGTH).flatMap((v) => [v.slice(0, MIN_FRAGMENT_LENGTH), v.slice(-MIN_FRAGMENT_LENGTH)]));
    this.fragments = ends.size ? new RegExp([...ends].map(escape).join("|"), "g") : null;
    return this;
  }

  /** `text` with every secret value replaced, and a secret cut short at either end (a truncated line,
      `sk-abc…`) too, from its first or last MIN_FRAGMENT_LENGTH characters on. */
  redact(text: string): string {
    if (!this.matcher || !text) return text;
    let out = text.replace(this.matcher, REDACTED);
    if (this.fragments) {
      this.fragments.lastIndex = 0;
      if (this.fragments.test(out)) out = this.redactFragments(out);
    }
    return out;
  }

  /** Replace each run of text that is a secret's start (running to wherever the text stops matching
      it) or a secret's end (from wherever it starts matching). */
  private redactFragments(text: string): string {
    const cuts: [number, number][] = [];
    for (const v of this.values) {
      if (v.length <= MIN_FRAGMENT_LENGTH) continue;
      const head = v.slice(0, MIN_FRAGMENT_LENGTH);
      for (let i = text.indexOf(head); i >= 0; i = text.indexOf(head, i + 1)) {
        let k = MIN_FRAGMENT_LENGTH;
        while (k < v.length && text[i + k] === v[k]) k++;
        cuts.push([i, i + k]);
      }
      const tail = v.slice(-MIN_FRAGMENT_LENGTH);
      for (let i = text.indexOf(tail); i >= 0; i = text.indexOf(tail, i + 1)) {
        let k = MIN_FRAGMENT_LENGTH;
        while (k < v.length && i - (k - MIN_FRAGMENT_LENGTH) - 1 >= 0 && text[i - (k - MIN_FRAGMENT_LENGTH) - 1] === v[v.length - k - 1]) k++;
        cuts.push([i - (k - MIN_FRAGMENT_LENGTH), i + MIN_FRAGMENT_LENGTH]);
      }
    }
    if (!cuts.length) return text;
    cuts.sort((a, b) => a[0] - b[0]);
    let out = "";
    let at = 0;
    for (const [s, e] of cuts) {
      if (e <= at) continue;
      out += text.slice(at, Math.max(at, s)) + (s >= at ? REDACTED : "");
      at = e;
    }
    return out + text.slice(at);
  }

  /** Every string in `value` (arrays and plain objects, deeply) redacted; the same object when nothing changed. */
  redactDeep<T>(value: T): T {
    if (!this.matcher) return value;
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) {
      const next = value.map((v) => this.redactDeep(v));
      return (next.some((v, i) => v !== value[i]) ? next : value) as T;
    }
    if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        next[k] = this.redactDeep(v);
        if (next[k] !== v) changed = true;
      }
      return (changed ? next : value) as T;
    }
    return value;
  }
}

/** A cheap, stable fingerprint (FNV-1a) so the cache key doesn't hold the env values themselves. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

let shared: Redactor | null = null;
/** The server's one Redactor (the real credential files and process.env), refreshed on each use. */
export function serverRedactor(): Redactor {
  shared ??= new Redactor();
  return shared.refresh();
}

/** Marks a tool that went through `redactingTool` (the test that every Overseer tool is covered). */
export const REDACTING = Symbol.for("sova.overseer.redacting");

type Content = { type: string; text?: string }[];

/**
 * The Overseer's tool wrapper. Every Overseer tool goes through it (overseerTools and
 * overseerFileTools both return wrapped tools), so a new tool is covered by default:
 * - the arguments are redacted before the tool sees them, so notes, cards, messages it sends and the
 *   action log never hold a secret (`args: false` opts out, for a tool that stores nothing and whose
 *   argument is a pattern: grep's `[redacted]` would be a character class, a different search);
 * - its result after: text blocks and details (an image's bytes are left alone), partial updates,
 *   and the message of an error it throws.
 */
export function redactingTool<T extends ToolDefinition<any, any>>(tool: T, redactor: () => Redactor = serverRedactor, opts: { args?: boolean } = {}): T {
  if ((tool as { [REDACTING]?: boolean })[REDACTING]) return tool;
  const clean = <R extends { content?: unknown; details?: unknown }>(r: Redactor, result: R): R => {
    if (!result || typeof result !== "object") return result;
    const content = Array.isArray(result.content)
      ? (result.content as Content).map((b) => (b?.type === "text" && typeof b.text === "string" ? { ...b, text: r.redact(b.text) } : b))
      : result.content;
    return { ...result, content, details: r.redactDeep(result.details) };
  };
  return {
    ...tool,
    [REDACTING]: true,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const r = redactor();
      try {
        const result = await tool.execute(toolCallId, opts.args === false ? params : r.redactDeep(params), signal, onUpdate && ((partial) => onUpdate(clean(r, partial))), ctx);
        return clean(r, result);
      } catch (err) {
        if (err instanceof Error) {
          err.message = r.redact(err.message);
          throw err;
        }
        throw new Error(r.redact(String(err)));
      }
    },
  } as T;
}
