import { createEffect, createResource, createSignal, on, type ResourceReturn } from "solid-js";
import type { DelegateOptions } from "../../shared/protocol";
import { mergeClaudeCatalog } from "../../pi-config/extensions/claude-code/catalog.ts";
import { getClaudeCatalog, getDelegateOptions } from "./api";
import { loadModels, modelList } from "./models";

/**
 * The Claude models this page knows beyond the built-in list (GET /api/claude/catalog), merged into
 * the same catalog the server reads, so lookups stay synchronous. Loaded when the session feed opens
 * and each time the server says the list changed (session-feed.ts).
 */
const [changes, setChanges] = createSignal(0);
const [lastKnown, setLastKnown] = createSignal(false);

/** Whether Claude Code's table couldn't be read, so the list is the last one known. */
export const claudeListIsLastKnown = lastKnown;
export const LAST_KNOWN_LIST_LINE = "Showing the last known Claude models: Sova couldn't read Claude Code's model table.";

/**
 * What a Settings tab's model rows are built from (GET /api/settings/delegate/options), kept current
 * while the tab is open: when the Claude list changes it's read again and the rows take it in place,
 * never reading "Checking…" meanwhile, and a read that fails leaves the rows as they are. Call it in
 * a component's setup.
 */
export function liveDelegateOptions(): ResourceReturn<DelegateOptions> {
  const resource = createResource(getDelegateOptions);
  const { mutate } = resource[1];
  createEffect(on(changes, () => void getDelegateOptions().then((next) => mutate(() => next), () => undefined), { defer: true }));
  return resource;
}

/** Best-effort: without an answer the page keeps the list it has. */
export async function loadClaudeCatalog(): Promise<void> {
  const info = await getClaudeCatalog().catch(() => null);
  if (!info) return;
  setLastKnown(info.lastKnown);
  if (!mergeClaudeCatalog(info.data)) return;
  setChanges((n) => n + 1);
  if (modelList()) void loadModels().catch(() => undefined);
}
