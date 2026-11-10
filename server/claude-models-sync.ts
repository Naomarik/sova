// The learned Claude model list in this process (§app.claude-code-provider/catalog): read at start,
// then whenever claude-models.json changes, whichever process wrote it. Runs in the server and in each
// chat process (warmChatRuntime). Harness-neutral: the runtime re-read comes in as `reapply`.
import { catalogDataOf, claudeTableStatus, claudeStateRoot, loadClaudeModels, readClaudeModelsFile, watchClaudeModelsFile } from "../pi-config/extensions/claude-code/catalog-store.ts";
import type { ClaudeCatalogInfo } from "../shared/protocol";

const listeners = new Set<() => void>();
let stopWatch: (() => void) | null = null;

/** Hear each change of the file, after the list and this process's runtime have taken it. */
export function onClaudeModelsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Load the list now and follow the file. `reapply` runs on every change, not only one this module
 * merged: the claude-code extension has its own watch in this process, and whichever loads first
 * leaves the other's load with nothing new, while the runtime still has to re-read.
 */
export function startClaudeModelsSync(reapply: () => Promise<unknown>, root: string = claudeStateRoot()): () => void {
  if (stopWatch) return stopWatch;
  loadClaudeModels(root);
  const stop = watchClaudeModelsFile(root, () => {
    loadClaudeModels(root);
    void Promise.resolve()
      .then(reapply)
      .catch((err) => console.warn("[claude-models] re-apply failed:", err instanceof Error ? err.message : String(err)))
      .finally(() => {
        for (const fn of listeners) fn();
      });
  });
  stopWatch = () => {
    stop();
    stopWatch = null;
  };
  return stopWatch;
}

/** GET /api/claude/catalog. */
export function claudeCatalogInfo(root: string = claudeStateRoot()): ClaudeCatalogInfo {
  const data = catalogDataOf(readClaudeModelsFile(root));
  return {
    data: {
      models: data.models.map((m) => ({ ...m, ...(m.efforts ? { efforts: [...m.efforts] } : {}), ...(m.apiIds ? { apiIds: [...m.apiIds] } : {}) })) as ClaudeCatalogInfo["data"]["models"],
      ...(data.dropped ? { dropped: [...data.dropped] } : {}),
      ...(data.tested ? { tested: [...data.tested] } : {}),
    },
    lastKnown: !claudeTableStatus(root).readable,
  };
}
