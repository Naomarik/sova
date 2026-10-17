// What this browser tab last saw of a page's reads (§app.organizations/project-page, "Reopening a
// project"): reopening shows it at once, then each read updates it in place. Memory only: nothing is
// written, and it is gone when the tab closes or reloads. Pure: no Solid, no DOM.

/** At most this many reads kept: a tab that walks every project keeps the most recent ones. */
export const PAGE_CACHE_MAX = 200;

const seen = new Map<string, unknown>();

/** The last value a read answered under `key`, or undefined. */
export function recall<T>(key: string): T | undefined {
  return seen.get(key) as T | undefined;
}

/** Keep `value` as the last answer under `key` (the newest last, the oldest dropped past PAGE_CACHE_MAX). */
export function remember(key: string, value: unknown): void {
  seen.delete(key);
  seen.set(key, value);
  if (seen.size > PAGE_CACHE_MAX) seen.delete(seen.keys().next().value!);
}

/** Tests: forget everything. */
export function forgetAll(): void {
  seen.clear();
}

/** Where this tab keeps a project's summary: its page draws from it at once, and New Session's prefill reads its root. */
export const projectSummaryKey = (projectId: string): string => `project:${projectId}:summary`;
