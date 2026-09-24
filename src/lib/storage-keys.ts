// Browser storage access for every key the app persists (`sova:*`). Storage access is wrapped the
// way the rest of the app wraps it: a blocked or full store degrades to in-memory behavior, never a
// broken render.
//
// "Never absent by falsiness": a stored "0", "" or "false" is a real preference (a closed folder, a
// cleared field). Every lookup here compares against null, so falsy-but-present values survive.

/** The stored string under `key`, else null. */
export function readKey(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

/** Writes `key`; a full or blocked store keeps the in-memory choice only. */
export function writeKey(store: Storage, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    // Persistence is a convenience; the in-memory choice still holds.
  }
}

/** Removes `key`. */
export function removeKey(store: Storage, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    // Nothing to undo.
  }
}
