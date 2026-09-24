import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelFavoriteResult } from "../shared/protocol";
// The command-palette extension's own store (node builtins only), so the TUI's Ctrl+F and the
// picker's star read and write one file through one implementation: the palette's lock, re-read
// and atomic rename, and its refusal to overwrite a file it can't parse. See CLAUDE.md.
import { ModelFavorites } from "../pi-config/extensions/command-palette/favorites.ts";

/** `~/.pi/agent/model-favorites.json`, or under PI_CODING_AGENT_DIR (read per call, for tests). */
export const favoritesFile = () => join(getAgentDir(), "model-favorites.json");

/**
 * Whether a model is a favorite, for GET /api/models. A missing file is no favorites. A file the
 * palette can't read (malformed, or not a file) is ALSO no favorites here, so the picker still
 * lists every model — but only the listing is lenient: a write goes through `ModelFavorites.set`,
 * which re-reads and refuses, so the bad file is reported rather than overwritten.
 */
export function readFavorites(path = favoritesFile()): (provider: string, id: string) => boolean {
  let store: ModelFavorites;
  try {
    store = new ModelFavorites(path);
  } catch (error) {
    console.warn(`[models] favorites unreadable, listing none: ${(error as Error).message}`);
    return () => false;
  }
  return (provider, id) => store.has({ provider, id });
}

/** "provider/id" split at the FIRST slash (a provider has none, a model id may); null if either half is empty. */
export function parseModelRef(ref: string): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export type FavoriteOutcome =
  | { status: 200; body: ModelFavoriteResult }
  | { status: 400 | 409 | 500; body: { error: string } };

/**
 * PUT /api/models/favorite. The ref is not checked against the available models: the palette
 * keys favorites by provider/id pair alone, and keeps ones it isn't currently listing.
 * 409 is the palette's lock (another writer mid-save); 500 is anything else the store refused,
 * a malformed file included, with the store's message.
 */
export function setFavorite(body: unknown, path = favoritesFile()): FavoriteOutcome {
  const b = body as { ref?: unknown; favorite?: unknown } | null;
  if (!b || typeof b !== "object" || typeof b.ref !== "string" || typeof b.favorite !== "boolean") {
    return { status: 400, body: { error: 'Expected { ref: "provider/id", favorite: boolean }' } };
  }
  const model = parseModelRef(b.ref);
  if (!model) return { status: 400, body: { error: `Not a provider/id model ref: ${b.ref}` } };
  try {
    // The constructor reads the file too, so a malformed one throws here, before any lock.
    new ModelFavorites(path).set(model, b.favorite);
  } catch (error) {
    // Invalid JSON reaches us as the parser's own SyntaxError, which doesn't name the file.
    const message = error instanceof SyntaxError ? `Invalid model favorites file: ${path}` : (error as Error).message;
    return { status: message.startsWith("Favorites are locked") ? 409 : 500, body: { error: message } };
  }
  return { status: 200, body: { ref: b.ref, favorite: b.favorite } };
}
