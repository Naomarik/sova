// A model provider's sign-in through pi's own login code (§app.openai-login): pi signs in, stores the
// credential in its auth.json under its own lock (the store chats and pi /login read) and signs out.
// Sova answers pi's questions itself: the method menu by the method asked for, the browser route's
// paste-back from the dialog; pi's own text never reaches the user (quirk P37).
import { CredentialSynchronizationError, ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { ProviderKeyStore, ProviderSignIn, SignInHandlers, SignInMethod, SignInOutcome, StoredProviderKey } from "../../../shared/harness";

/** The ids of pi's method menu (openai-codex's `select` prompt), by Sova's method (quirk P37). */
export const PI_METHOD_IDS: Record<SignInMethod, string> = { code: "device_code", browser: "browser" };

/** What pi's AuthInteraction asks and tells, as far as this file reads it (pi-ai's AuthPrompt and AuthEvent). */
type PiPrompt = { type: string; message?: string; options?: readonly { id: string }[]; signal?: AbortSignal };
type PiEvent =
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: "auth_url"; url: string }
  | { type: "progress" | "info"; message: string };

/** pi's error when OpenAI answers the code request with 404: the code route isn't offered (quirk P37). */
export const PI_CODE_REFUSED = /device code login is not enabled/i;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A throwaway model runtime on the store at `authPath`: no models file, no network, nothing refreshed at start. */
function runtimeFor(authPath: string): Promise<ModelRuntime> {
  return ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
}

/**
 * pi's AuthInteraction for one sign-in. `shown` turns true once the user has something to act on
 * (a code or a link); a code route that fails before that with pi's 404 text was refused by the provider.
 */
export function piInteraction(method: SignInMethod, handlers: SignInHandlers, signal: AbortSignal, shown: { value: boolean }) {
  return {
    signal,
    async prompt(prompt: PiPrompt): Promise<string> {
      if (prompt.type === "select") {
        const want = PI_METHOD_IDS[method];
        if (!prompt.options?.some((o) => o.id === want)) throw new Error(`This provider has no ${method === "code" ? "code" : "browser"} sign-in`);
        return want;
      }
      if (prompt.type === "manual_code") {
        const signals = [signal, ...(prompt.signal ? [prompt.signal] : [])];
        return handlers.askAddress(AbortSignal.any(signals));
      }
      throw new Error("The sign-in asked for something Sova can't answer");
    },
    notify(event: PiEvent): void {
      if (event.type === "device_code") {
        shown.value = true;
        handlers.onEvent({
          type: "code",
          userCode: event.userCode,
          url: event.verificationUri,
          ...(typeof event.expiresInSeconds === "number" ? { expiresInMs: event.expiresInSeconds * 1000 } : {}),
        });
      } else if (event.type === "auth_url") {
        shown.value = true;
        handlers.onEvent({ type: "url", url: event.url });
      } else if (event.type === "progress") {
        handlers.onEvent({ type: "finishing" });
      }
      // `info` and pi's instructions are pi's wording for its terminal: never shown.
    },
  };
}

/** pi's sign-in over the auth.json at `authPath()` (the agent directory's, read at each call). */
export function piProviderSignIn(authPath: () => string): ProviderSignIn {
  return {
    async signIn(provider, method, handlers, signal): Promise<SignInOutcome> {
      const shown = { value: false };
      try {
        const runtime = await runtimeFor(authPath());
        await runtime.login(provider, "oauth", piInteraction(method, handlers, signal, shown) as never);
        return { ok: true };
      } catch (error) {
        // Stored, but this throwaway runtime's own model list failed to follow: the sign-in is saved.
        if (error instanceof CredentialSynchronizationError) return { ok: true };
        if (signal.aborted) return { ok: false, error: "Cancelled", cancelled: true };
        if (method === "code" && !shown.value && PI_CODE_REFUSED.test(message(error))) return { ok: false, error: message(error), refused: true };
        return { ok: false, error: message(error) };
      }
    },
    async signOut(provider): Promise<void> {
      const runtime = await runtimeFor(authPath());
      try {
        await runtime.logout(provider);
      } catch (error) {
        if (!(error instanceof CredentialSynchronizationError)) throw error;
      }
    },
  };
}

/** What pi's api-key login asks for the key, as far as this file reads it (pi-ai's `envApiKeyAuth`, quirk P38). */
const PI_KEY_PROMPT = "secret";

/** What pi's auth.json holds for `provider`, read without resolving a key (a `!command` key is never run). */
export function storedKeyOf(provider: string, authPath: string): StoredProviderKey {
  let credential: { type?: unknown; key?: unknown } | undefined;
  try {
    credential = readStoredCredential(provider, authPath) as typeof credential;
  } catch {
    return { kind: "none" };
  }
  if (!credential) return { kind: "none" };
  if (credential.type !== "api_key") return { kind: "other" };
  if (typeof credential.key !== "string" || !credential.key) return { kind: "none" };
  return credential.key.startsWith("!") ? { kind: "command" } : { kind: "key", key: credential.key };
}

/**
 * Pay-as-you-go API keys in pi's auth.json at `authPath()` (§app/provider-keys, quirk P38): stored by pi's own
 * api-key login (`ModelRuntime.login(provider, "api_key")`, its key prompt answered with the key) and removed by
 * its logout, each a modify or delete under pi's lock, so login sync reads a save as a login and a removal as a
 * logout. The runtime is a throwaway one on the agent dir's models.json (`modelsPath()`), so a provider
 * models.json defines (ollama-cloud) is known too; it fetches nothing.
 */
export function piProviderKeys(authPath: () => string, modelsPath: () => string): ProviderKeyStore {
  const runtime = () => ModelRuntime.create({ authPath: authPath(), modelsPath: modelsPath(), allowModelNetwork: false, refreshOnCreate: false });
  /** Stored, but the throwaway runtime's own model list didn't follow: the change is saved all the same. */
  const saved = (error: unknown) => {
    if (!(error instanceof CredentialSynchronizationError)) throw error;
  };
  return {
    async setApiKey(provider, key) {
      if (storedKeyOf(provider, authPath()).kind === "other") throw new Error("This provider holds a sign-in of another kind here; sign it out first");
      const rt = await runtime();
      const interaction = {
        async prompt(prompt: PiPrompt): Promise<string> {
          if (prompt.type !== PI_KEY_PROMPT) throw new Error("The key login asked for something Sova can't answer");
          return key;
        },
        notify() {},
      };
      await rt.login(provider, "api_key", interaction as never).then(() => undefined, saved);
    },
    async removeApiKey(provider) {
      const held = storedKeyOf(provider, authPath()).kind;
      if (held === "none") return;
      if (held === "other") throw new Error("This provider holds a sign-in of another kind here, not an API key");
      const rt = await runtime();
      await rt.logout(provider).then(() => undefined, saved);
    },
    storedKey: (provider) => storedKeyOf(provider, authPath()),
    async apiKeyProviders() {
      const rt = await runtime();
      return rt
        .getProviders()
        .filter((p) => typeof (p as { auth?: { apiKey?: { login?: unknown } } }).auth?.apiKey?.login === "function")
        .map((p) => ({ id: p.id, name: p.name || p.id }));
    },
  };
}
