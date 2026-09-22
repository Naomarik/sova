// The browser-storage half of the pi-web → Sova rename (the runtime half is staged out-of-tree).
//
// Every key the app persists moved from the `pi-web:` prefix to `sova:`. While the rename bridge is
// open the rule is DUAL: reads prefer the new key and fall back to the legacy one; writes go to
// BOTH. Old keys are never deleted — a browser that goes back to a pre-rebrand build (a rollback is
// an explicitly supported path) sees its preferences exactly as current as the new build does,
// because nothing is ever written to only one side.
//
// "Never absent by falsiness": a stored "0", "" or "false" is a real preference (a closed folder, a
// cleared field). Every lookup here compares against null, so falsy-but-present values survive the
// bridge exactly. Storage access is wrapped the way the rest of the app wraps it: a blocked or full
// store degrades to in-memory behavior, never a broken render.

/** The stored string under `key`, else under `legacyKey`, else null. The NEW key wins when both exist. */
export function dualGet(store: Storage, key: string, legacyKey: string): string | null {
  try {
    const v = store.getItem(key);
    if (v !== null) return v;
    return store.getItem(legacyKey);
  } catch {
    return null;
  }
}

/** Writes BOTH keys, each attempt independent: a full/blocked store may take one and not the other. */
export function dualSet(store: Storage, key: string, legacyKey: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    // Persistence is a convenience; the in-memory choice still holds.
  }
  try {
    store.setItem(legacyKey, value);
  } catch {
    // Same for the legacy mirror.
  }
}

/** Removes BOTH spellings. A clear that left the legacy key behind would resurrect on the next read. */
export function dualRemove(store: Storage, key: string, legacyKey: string): void {
  try {
    store.removeItem(key);
  } catch {
    // Nothing to undo.
  }
  try {
    store.removeItem(legacyKey);
  } catch {
    // Same for the legacy mirror.
  }
}
