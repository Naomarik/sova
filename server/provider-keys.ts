import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import type { Context, Hono } from "hono";
import type { ProviderKeyStore } from "../shared/harness";
import type { ModelPolicy, ProviderKeyCheck, ProviderKeyRow, ProviderKeysInfo, ProviderKeyTab, ProviderKeyWrite } from "../shared/protocol";
import { errMessage, fetchDeepSeek, fetchOllama, fetchZai } from "../pi-config/extensions/usage-status/fetch.ts";
import { defaultAuthPaths, readAuthStatus, readOpenAiSignIn } from "./auth-status";
import { fromTourRecorder } from "./auth";
import { isDirectLocal } from "./compression";
import { lastModelCheck, modelCheck, setModelCheckKey } from "./harness/pi/model-sync";
import { reapplyModelLevels } from "./harness/pi/open";
import { piProviderKeys } from "./harness/pi/sign-in";
import { localRequest } from "./mesh/proxy";
import { readModelPolicy } from "./model-policy";
import { defaultMeshSharesLogins } from "./openai-login";
import { notPage, pageOnlyRefusal } from "./page-only";
import { agentRoot, stateRoot } from "./state-root";

// Settings → Accounts' API keys (§app/provider-keys): one key per provider in pi's auth.json, stored and
// removed through the harness's ProviderKeyStore (pi's own api-key login and logout, under pi's lock), so
// login sync shares a save as a login and a removal as a logout (§mesh.sync/logins). A pasted key is
// checked with the provider before anything is written, by a call that spends nothing; a refused one is
// never written. The browser gets a key's last 4 characters, its source and its last check; the whole key
// only from the reveal route, which answers the page's own request from a browser on this computer, never
// cached and never logged. Nothing here logs a key, and no answer but the reveal's carries one.

/** The tabs' providers, in tab order: pi's provider id, its tab and the name the tab shows. */
export const TAB_PROVIDERS: { provider: string; tab: Exclude<ProviderKeyTab, "other">; name: string }[] = [
  { provider: "anthropic", tab: "claude", name: "Anthropic" },
  { provider: "openai", tab: "openai", name: "OpenAI" },
  { provider: "ollama-cloud", tab: "ollama-cloud", name: "Ollama Cloud" },
  { provider: "deepseek", tab: "deepseek", name: "DeepSeek" },
  { provider: "zai", tab: "zai", name: "Z.ai" },
];
const TAB_OF = new Map(TAB_PROVIDERS.map((t) => [t.provider, t]));

/** The environment variable whose key serves a provider when nothing is saved here (pi reads the same ones). */
export const ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  zai: "ZAI_API_KEY",
};

/** What one check of a key with its provider came to. `status` is the HTTP status of a refusal. */
export type KeyCheck = { result: "accepted" } | { result: "refused"; status?: number } | { result: "unreachable"; error: string };
export type KeyChecker = (key: string, request: typeof fetch) => Promise<KeyCheck>;

const MAX_KEY = 4096;
const TIMEOUT_MS = 10_000;

/** A model-list call: free, and it answers 401/403 to a key the provider refuses. */
function modelList(url: string, headers: (key: string) => Record<string, string>): KeyChecker {
  return async (key, request) => {
    let res: Response;
    try {
      res = await request(url, { headers: headers(key), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      return { result: "unreachable", error: errMessage(error) };
    }
    if (res.status === 401 || res.status === 403) return { result: "refused", status: res.status };
    if (!res.ok) return { result: "unreachable", error: `HTTP ${res.status}` };
    return { result: "accepted" };
  };
}

/** A usage fetcher's reading as a check: `badkey` is a refusal, any reading an acceptance, a throw unreachable. */
function usageCheck(fetcher: (o: { key: string; request: typeof fetch }) => Promise<{ state: string }>): KeyChecker {
  return async (key, request) => {
    try {
      const data = await fetcher({ key, request });
      return data.state === "badkey" ? { result: "refused" } : { result: "accepted" };
    } catch (error) {
      return { result: "unreachable", error: errMessage(error) };
    }
  };
}

/** The free check of each tab's provider (§app.provider-keys/check-before-save); other providers have none. */
export const CHECKERS: Record<string, KeyChecker> = {
  anthropic: modelList("https://api.anthropic.com/v1/models?limit=1", (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" })),
  openai: modelList("https://api.openai.com/v1/models", (key) => ({ Authorization: `Bearer ${key}` })),
  "ollama-cloud": usageCheck((o) => fetchOllama(o)),
  deepseek: usageCheck((o) => fetchDeepSeek(o)),
  zai: usageCheck((o) => fetchZai(o)),
};

/** A key's fingerprint: which key a check was of, never the key. */
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

/** Why a pasted key can't be a key at all, or null. A `!` key is a command pi would run: never taken from the page. */
export function keyProblem(key: unknown): string | null {
  if (typeof key !== "string" || !key.trim()) return "Paste a key first.";
  const k = key.trim();
  if (k.length > MAX_KEY) return "That's too long to be an API key.";
  if (/[\s\x00-\x1f\x7f]/.test(k)) return "An API key has no spaces or line breaks. Paste just the key.";
  if (k.startsWith("!")) return "An API key can't start with \"!\" here.";
  return null;
}

/** The reveal's test: the page's own request, on the main listener, from a browser on this computer (no proxy between). */
export function revealAllowed(c: Context): boolean {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  if (!incoming || !localRequest(c) || fromTourRecorder((n) => c.req.header(n))) return false;
  return isDirectLocal(incoming) && notPage(c) === null;
}

interface CheckRecord extends ProviderKeyCheck {
  fp: string;
}

export interface ProviderKeysOptions {
  keys?: ProviderKeyStore;
  checkers?: Record<string, KeyChecker>;
  request?: typeof fetch;
  env?: () => Record<string, string | undefined>;
  /** Where the last checks are kept (fingerprints and outcomes, never a key). */
  statePath?: () => string;
  now?: () => number;
  policy?: () => ModelPolicy;
  meshSharesLogins?: () => boolean;
  /** The subscription sign-ins' standing, for the Claude and OpenAI tabs' marks. */
  signIns?: () => Promise<{ claude: boolean; openai: boolean }>;
  /** After a save or a removal: the model menu and the usage reading follow it. Errors are ignored. */
  afterChange?: (provider: string) => void | Promise<void>;
}

/** The key's check as one round's record holds it: which key (`fp`), when, and what came of it. */
export interface SharedKeyReading {
  at: number;
  key?: { result: ProviderKeyCheck["result"]; reason?: string; fp: string };
}

/**
 * A provider whose key is checked as part of another reading: Ollama Cloud's, by Settings → Models' model list
 * check (§app.provider-keys/key-tab). Test runs that round; the tab shows that round's record.
 */
export interface SharedReading {
  provider: string;
  /** The last round's record. */
  last(): SharedKeyReading | undefined;
  /** Run a round now (joining one already running); false when such checks are off here. */
  run(): Promise<boolean>;
}

export type KeysResult<T> = { status: 200; body: T } | { status: 400 | 404 | 409; body: { error: string } };

export class ProviderKeysService {
  private readonly keys: ProviderKeyStore;
  private readonly checkers: Record<string, KeyChecker>;
  private readonly opts: ProviderKeysOptions;
  private chain: Promise<unknown> = Promise.resolve();
  private otherList: Promise<{ id: string; name: string }[]> | null = null;
  /** Set by linkOllamaReading: the provider whose check is another reading's round. */
  shared: SharedReading | null = null;

  constructor(opts: ProviderKeysOptions = {}) {
    this.opts = opts;
    this.keys = opts.keys ?? piProviderKeys(() => join(agentRoot(), "auth.json"), () => join(agentRoot(), "models.json"));
    this.checkers = opts.checkers ?? CHECKERS;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
  private request(): typeof fetch {
    return this.opts.request ?? fetch;
  }
  private statePath(): string {
    return (this.opts.statePath ?? (() => join(stateRoot(), "provider-keys.json")))();
  }

  // -- the checks kept ---------------------------------------------------------------------

  private readChecks(): Record<string, CheckRecord> {
    try {
      const v = JSON.parse(readFileSync(this.statePath(), "utf8"));
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  private writeCheck(provider: string, record: CheckRecord | null): void {
    const all = this.readChecks();
    if (record) all[provider] = record;
    else delete all[provider];
    const path = this.statePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }

  // -- reading -----------------------------------------------------------------------------

  /** The providers that take a key and have no tab of their own (the Other provider picker). */
  async otherProviders(): Promise<{ id: string; name: string }[]> {
    this.otherList ??= this.keys.apiKeyProviders().then(
      (all) => all.filter((p) => !TAB_OF.has(p.id)).sort((a, b) => a.name.localeCompare(b.name)),
      () => {
        this.otherList = null;
        return [];
      },
    );
    return this.otherList;
  }

  /** The key in use for `provider`: the one saved here wins, else the environment's. */
  private inUse(provider: string): { key: string; source: "saved" | "env" } | null {
    const stored = this.keys.storedKey(provider);
    if (stored.kind === "key") return { key: stored.key, source: "saved" };
    const envName = ENV_KEYS[provider];
    const value = envName ? (this.opts.env ?? (() => process.env))()[envName] : undefined;
    if (stored.kind === "none" && value) return { key: value, source: "env" };
    return null;
  }

  row(provider: string, name: string, tab: ProviderKeyTab): ProviderKeyRow {
    const stored = this.keys.storedKey(provider);
    const envName = ENV_KEYS[provider];
    const envSet = !!(envName && (this.opts.env ?? (() => process.env))()[envName]);
    const use = this.inUse(provider);
    const checkable = tab !== "other" && !!this.checkers[provider];
    const lastCheck = use ? this.lastCheckOf(provider, fingerprint(use.key)) : undefined;
    const saved = stored.kind === "key" || stored.kind === "command";
    const source = saved ? "saved" : use ? "env" : "none";
    const status: ProviderKeyRow["status"] =
      source === "none" ? "nokey"
      : !checkable || stored.kind === "command" ? "saved"
      : !lastCheck ? "unchecked"
      : lastCheck.result === "accepted" ? "connected"
      : lastCheck.result === "refused" ? "refused"
      : "unchecked";
    const policy = (this.opts.policy ?? readModelPolicy)();
    return {
      provider,
      name,
      tab,
      saved,
      ...(stored.kind === "key" ? { last4: stored.key.slice(-4) } : {}),
      ...(stored.kind === "command" ? { command: true as const } : {}),
      ...(stored.kind === "other" ? { otherSignIn: true as const } : {}),
      source,
      ...(envName ? { envName } : {}),
      envSet,
      status,
      ...(lastCheck ? { lastCheck } : {}),
      checkable,
      providerEnabled: !policy.disabledProviders.includes(provider),
    };
  }

  /**
   * The last check of the key `fp`: the shared round's record for a shared provider, else this file's (a
   * check-before-save while such rounds are off). The newer of the two that are of this key.
   */
  private lastCheckOf(provider: string, fp: string): ProviderKeyCheck | undefined {
    const own = this.readChecks()[provider];
    const mine = own && own.fp === fp ? { at: own.at, result: own.result, ...(own.reason ? { reason: own.reason } : {}) } : undefined;
    if (this.shared?.provider !== provider) return mine;
    let round: SharedKeyReading | undefined;
    try {
      round = this.shared.last();
    } catch {
      round = undefined;
    }
    const theirs = round?.key && round.key.fp === fp ? { at: round.at, result: round.key.result, ...(round.key.reason ? { reason: round.key.reason } : {}) } : undefined;
    if (!theirs) return mine;
    return mine && mine.at > theirs.at ? mine : theirs;
  }

  /** The key in use checked now, as a round records it; undefined with no key in use. */
  async keyReading(provider: string): Promise<SharedKeyReading["key"]> {
    const use = this.inUse(provider);
    if (!use || !this.checkers[provider]) return undefined;
    const { result, reason, fp } = await this.check(provider, use.key);
    return { result, ...(reason ? { reason } : {}), fp };
  }

  /** Run the shared round for `provider`; false when it has none or such rounds are off. */
  private async runShared(provider: string): Promise<boolean> {
    if (this.shared?.provider !== provider) return false;
    return this.shared.run().catch(() => false);
  }

  private async rowOf(provider: string): Promise<ProviderKeyRow | null> {
    const tab = TAB_OF.get(provider);
    if (tab) return this.row(provider, tab.name, tab.tab);
    const other = (await this.otherProviders()).find((p) => p.id === provider);
    return other ? this.row(other.id, other.name, "other") : null;
  }

  async info(reveal: boolean): Promise<ProviderKeysInfo> {
    const others = await this.otherProviders();
    const rows = TAB_PROVIDERS.map((t) => this.row(t.provider, t.name, t.tab));
    for (const o of others) if (this.keys.storedKey(o.id).kind !== "none") rows.push(this.row(o.id, o.name, "other"));
    const probe = (fn: (() => boolean) | undefined, fallback: () => boolean) => {
      try {
        return (fn ?? fallback)();
      } catch {
        return false;
      }
    };
    const signIns = await (this.opts.signIns ?? defaultSignIns)().catch(() => ({ claude: false, openai: false }));
    return { rows, others, revealAllowed: reveal, meshSharesLogins: probe(this.opts.meshSharesLogins, defaultMeshSharesLogins), signIns };
  }

  // -- acting ------------------------------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async check(provider: string, key: string): Promise<CheckRecord> {
    const checker = this.checkers[provider]!;
    const outcome = await checker(key, this.request()).catch((error): KeyCheck => ({ result: "unreachable", error: errMessage(error) }));
    const name = TAB_OF.get(provider)?.name ?? provider;
    const reason =
      outcome.result === "refused" ? `${name} refused this key${outcome.status ? ` (HTTP ${outcome.status})` : ""}.`
      : outcome.result === "unreachable" ? `Couldn't reach ${name}: ${outcome.error}.`
      : undefined;
    return { at: this.now(), result: outcome.result, ...(reason ? { reason } : {}), fp: fingerprint(key) };
  }

  private changed(provider: string): void {
    try {
      void Promise.resolve(this.opts.afterChange?.(provider)).catch(() => {});
    } catch {
      /* the model menu and usage catch up on their own */
    }
  }

  /** Save or replace a key: checked first; a refused key is never written (§app.provider-keys/check-before-save). */
  set(provider: string, body: unknown): Promise<KeysResult<ProviderKeyWrite>> {
    return this.serial(async () => {
      const raw = (body as { key?: unknown } | null | undefined)?.key;
      const problem = keyProblem(raw);
      if (problem) return { status: 400, body: { error: problem } };
      const key = (raw as string).trim();
      const before = await this.rowOf(provider);
      if (!before) return { status: 404, body: { error: "That provider takes no API key here." } };
      if (before.otherSignIn) return { status: 409, body: { error: `${before.name} holds a sign-in of another kind here. Sign it out first.` } };
      const record = before.checkable ? await this.check(provider, key) : null;
      if (record?.result === "refused") return { status: 200, body: { saved: false, refused: record.reason ?? "The provider refused this key.", row: before } };
      try {
        await this.keys.setApiKey(provider, key);
      } catch (error) {
        console.error(`[provider-keys] saving ${provider}'s key failed: ${redact(errMessage(error))}`);
        return { status: 409, body: { error: "Couldn't save the key. Try again." } };
      }
      if (record) this.writeCheck(provider, record);
      this.changed(provider);
      // A shared provider's tab shows its round: run one with the new key, so both places read it.
      if (record) await this.runShared(provider);
      return { status: 200, body: { saved: true, row: (await this.rowOf(provider))! } };
    });
  }

  /** Remove the saved key: a logout of it, which login sync spreads (§app.provider-keys/remove). */
  remove(provider: string): Promise<KeysResult<ProviderKeyWrite>> {
    return this.serial(async () => {
      const before = await this.rowOf(provider);
      if (!before) return { status: 404, body: { error: "That provider takes no API key here." } };
      if (!before.saved) return { status: 200, body: { saved: false, row: before } };
      try {
        await this.keys.removeApiKey(provider);
      } catch (error) {
        console.error(`[provider-keys] removing ${provider}'s key failed: ${redact(errMessage(error))}`);
        return { status: 409, body: { error: "Couldn't remove the key. Try again." } };
      }
      this.writeCheck(provider, null);
      this.changed(provider);
      return { status: 200, body: { saved: false, row: (await this.rowOf(provider))! } };
    });
  }

  /** Check the key in use again (saved, else the environment's); changes nothing but the status. */
  async test(provider: string): Promise<KeysResult<ProviderKeyRow>> {
    const before = await this.rowOf(provider);
    if (!before) return { status: 404, body: { error: "That provider takes no API key here." } };
    if (!before.checkable) return { status: 409, body: { error: `Sova can't check ${before.name}'s key.` } };
    // A shared provider's Test is that round (Settings → Models' Check Now for Ollama Cloud): one record, one time.
    if (await this.runShared(provider)) return { status: 200, body: (await this.rowOf(provider))! };
    const use = this.inUse(provider);
    if (use) {
      const record = await this.check(provider, use.key);
      // Kept only while it's still the key in use: a save or a removal meanwhile wins.
      await this.serial(async () => {
        if (this.inUse(provider)?.key === use.key) this.writeCheck(provider, record);
      });
    }
    return { status: 200, body: (await this.rowOf(provider))! };
  }

  /** The saved key itself, for the reveal route only. The environment's key is never sent. */
  async reveal(provider: string): Promise<KeysResult<{ key: string }>> {
    if (!(await this.rowOf(provider))) return { status: 404, body: { error: "That provider takes no API key here." } };
    const stored = this.keys.storedKey(provider);
    if (stored.kind !== "key") return { status: 404, body: { error: "No key is saved here for this provider." } };
    return { status: 200, body: { key: stored.key } };
  }
}

/**
 * Ollama Cloud's key check is a part of the server's model list check (§app.provider-keys/key-tab,
 * §app.model-levels/server-check): every round (the daily one, Check Now, the tab's Test, a save) checks the key
 * in use too and writes one record, which Settings → Models' line and the tab both read.
 */
export function linkOllamaReading(service: ProviderKeysService): ProviderKeysService {
  service.shared = {
    provider: "ollama-cloud",
    last: () => lastModelCheck(),
    async run() {
      const record = await modelCheck().checkNow();
      if (!record) return false;
      await reapplyModelLevels();
      return true;
    },
  };
  setModelCheckKey(() => service.keyReading("ollama-cloud"));
  return service;
}

/** Long token-like runs out of a message before it is logged. */
const redact = (text: string) => text.replace(/[A-Za-z0-9_\-.+/=]{16,}/g, "…").slice(0, 300);

async function defaultSignIns(): Promise<{ claude: boolean; openai: boolean }> {
  const paths = defaultAuthPaths();
  const [auth, openai] = await Promise.all([readAuthStatus(paths), readOpenAiSignIn(paths)]);
  return { claude: auth.claude !== undefined, openai: openai.signedIn };
}

const PAGE_ONLY = {
  overseer: "The Overseer can't change an API key. Ask the user to do it in Settings → Accounts. Nothing changed.",
  local: "API keys are changed only on the page of the computer they're on. Nothing changed.",
  chat: "A chat can't change an API key. Ask the user to do it in Settings → Accounts. Nothing changed.",
  script: "A script can't change an API key. Ask the user to do it in Settings → Accounts. Nothing changed.",
  extension: "An extension can't change an API key. Ask the user to do it in Settings → Accounts. Nothing changed.",
};
const READ_BACK = "Keys can only be read back on this computer.";

async function json(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** The routes, under Settings (an area left out of the command catalogue). Every answer is no-store. */
export function registerProviderKeyRoutes(app: Hono, service = new ProviderKeysService()): ProviderKeysService {
  const NO_STORE = { "Cache-Control": "no-store" };
  const send = (c: Context, r: KeysResult<unknown>) => c.json(r.body as object, r.status, NO_STORE);
  const refused = (c: Context) => {
    const why = pageOnlyRefusal(c, PAGE_ONLY);
    return why ? c.json({ error: why, yourClick: true }, 403, NO_STORE) : null;
  };
  app.get("/api/settings/accounts/keys", async (c) => c.json(await service.info(revealAllowed(c)), 200, NO_STORE));
  app.put("/api/settings/accounts/keys/:provider", async (c) => refused(c) ?? send(c, await service.set(c.req.param("provider"), await json(c))));
  app.delete("/api/settings/accounts/keys/:provider", async (c) => refused(c) ?? send(c, await service.remove(c.req.param("provider"))));
  app.post("/api/settings/accounts/keys/:provider/test", async (c) => send(c, await service.test(c.req.param("provider"))));
  // The one answer that carries a key: the page's own request from a browser on this computer. Never logged.
  app.post("/api/settings/accounts/keys/:provider/reveal", async (c) => {
    if (!revealAllowed(c)) return c.json({ error: READ_BACK }, 403, NO_STORE);
    return send(c, await service.reveal(c.req.param("provider")));
  });
  return service;
}
