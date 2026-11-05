// A model provider's sign-in through pi's own login code (§app.openai-login): pi signs in, stores the
// credential in its auth.json under its own lock (the store chats and pi /login read) and signs out.
// Sova answers pi's questions itself: the method menu by the method asked for, the browser route's
// paste-back from the dialog; pi's own text never reaches the user (quirk P37).
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderSignIn, SignInHandlers, SignInMethod, SignInOutcome } from "../../../shared/harness";

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
