import { createSignal } from "solid-js";
import { mergeClaudeCatalog } from "../../pi-config/extensions/claude-code/catalog.ts";
import { getClaudeCatalog } from "./api";
import { loadModels, modelList } from "./models";

/**
 * The Claude models this page knows beyond the built-in list (GET /api/claude/catalog), merged into
 * the same catalog the server reads, so lookups stay synchronous. Loaded when the session feed opens
 * and each time the server says the list changed (session-feed.ts).
 */
const [changes, setChanges] = createSignal(0);
const [lastKnown, setLastKnown] = createSignal(false);

/** Counts changes to the list, starting at 0: a resource keyed on it re-reads when a model arrives. */
export const claudeCatalogChanges = changes;
/** Whether Claude Code's table couldn't be read, so the list is the last one known. */
export const claudeListIsLastKnown = lastKnown;
export const LAST_KNOWN_LIST_LINE = "Showing the last known Claude models: Sova couldn't read Claude Code's model table.";

/** Best-effort: without an answer the page keeps the list it has. */
export async function loadClaudeCatalog(): Promise<void> {
  const info = await getClaudeCatalog().catch(() => null);
  if (!info) return;
  setLastKnown(info.lastKnown);
  if (!mergeClaudeCatalog(info.data)) return;
  setChanges((n) => n + 1);
  if (modelList()) void loadModels().catch(() => undefined);
}
