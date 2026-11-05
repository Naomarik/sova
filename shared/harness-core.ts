// The harness contract, core identities (§app/harness). Types only: imports nothing, emits nothing.
// Sova code outside server/harness/<harness>/ speaks these shapes, never a harness's own. pi is the
// one harness today; its adapter is server/harness/pi/.

/** Which harness produced a value. Provenance only: nothing outside server/harness/<id>/ branches on it. */
export type HarnessId = "pi" | (string & {});

/** A session's key on the wire and in every Sova store. Opaque: only the adapter parses it.
    pi: the session file's absolute path, byte-identical to today's `path` (server/paths.ts resolveSessionPath). */
export type SessionKey = string;

/** An entry's id inside its session (pi: the JSONL entry id). */
export type EntryId = string;

/** "<provider>/<id>" for pi, as SessionSummary.model and ModelInfo.ref carry it today. */
export type ModelRef = string;

/** Detail only one harness has, namespaced by it (pi: a context_edit's target and replacement, a usage's
    per-kind cost, a stop reason Sova has no word for). Read only under server/harness/<harness>/. */
export interface HarnessExt {
  readonly harness: HarnessId;
  readonly [key: string]: unknown;
}

// -- Provider sign-in (§app.openai-login): signing a model provider's subscription in and out through the
// harness's own login code, which stores the credential where its chats read it. pi's: server/harness/pi/sign-in.ts.

/** How the user proves who they are: a short code entered on the provider's page, or the browser
    route (open a link, sign in, paste back the address the page ends on). */
export type SignInMethod = "code" | "browser";

/** What the sign-in has to show, in Sova's own words; never the harness's text. */
export type SignInEvent =
  /** Enter `userCode` at `url`, on any device; the harness waits for the provider by itself. */
  | { type: "code"; userCode: string; url: string; expiresInMs?: number }
  /** Open `url` and sign in; the harness then asks for the address the page ends on (`askAddress`). */
  | { type: "url"; url: string }
  /** The provider answered: the credential is being fetched and stored. */
  | { type: "finishing" };

export interface SignInHandlers {
  onEvent(event: SignInEvent): void;
  /**
   * The browser route waits for the address the page ended on. Resolve with it; reject to end the
   * sign-in. `signal` aborts when the harness no longer needs it (the provider called back by itself).
   */
  askAddress(signal: AbortSignal): Promise<string>;
}

export type SignInOutcome =
  | { ok: true }
  /** `refused`: the provider does not offer this method here (nothing was shown); try the other. */
  | { ok: false; error: string; refused?: true; cancelled?: true };

/** A harness's sign-in for its model providers. Stores and removes under the harness's own lock. */
export interface ProviderSignIn {
  /** Sign `provider` in by `method`; `signal` aborts it, freeing whatever it holds (a local port). */
  signIn(provider: string, method: SignInMethod, handlers: SignInHandlers, signal: AbortSignal): Promise<SignInOutcome>;
  /** Remove `provider`'s stored sign-in. */
  signOut(provider: string): Promise<void>;
}

/** What a harness's store holds for one provider, as far as an API key goes. The key itself only for `key`. */
export type StoredProviderKey =
  | { kind: "none" }
  | { kind: "key"; key: string }
  /** A key the store resolves by running a command (device config): never read back, checked or sent. */
  | { kind: "command" }
  /** A sign-in of another kind (a subscription's OAuth) under the provider's id. */
  | { kind: "other" };

/** A harness's pay-as-you-go API keys, stored where its chats read them, under its own lock (§app/provider-keys). */
export interface ProviderKeyStore {
  /** Store `key` as `provider`'s API key, replacing a stored key (never a sign-in of another kind). */
  setApiKey(provider: string, key: string): Promise<void>;
  /** Remove `provider`'s stored API key: a logout of it in the store. */
  removeApiKey(provider: string): Promise<void>;
  /** What the store holds for `provider` now. */
  storedKey(provider: string): StoredProviderKey;
  /** Every provider that takes an API key, by id and display name. */
  apiKeyProviders(): Promise<{ id: string; name: string }[]>;
}
