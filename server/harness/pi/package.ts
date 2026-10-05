// The pi package itself, for the server code that needs it beyond a session (§app.harness/session): its
// version (the mesh hello, server/mesh/hello.ts), a module resolved from inside it, and an auth read through
// pi's own model runtime (login sync, server/sync/logins-stores.ts). Nothing here holds state.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";

/** The pinned pi's version. */
export const PI_VERSION: string = VERSION;

/** A module as pi resolves it from its own entry (a dependency it shares with Sova, e.g. proper-lockfile). */
export function requireFromPi(name: string): unknown {
  const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return createRequire(piEntry)(name);
}

/** Ask pi for `provider`'s auth from the store at `authPath`, through a throwaway model runtime with no models
    file and no network, so pi refreshes (and stores) the credential under its own lock when it must. */
export async function piGetAuth(authPath: string, provider: string, overrides: { minOAuthValidityMs?: number }): Promise<void> {
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  await runtime.getAuth(provider, overrides);
}
