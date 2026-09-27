// Ask the app to read the session list now, instead of at its next poll: for a view whose action
// changed a row's fields (a baton hand-off moves the sidebar's " · <holder>"). App listens.

export const LIST_REFRESH_EVENT = "sova:list-refresh";

export const requestListRefresh = (): void => void window.dispatchEvent(new Event(LIST_REFRESH_EVENT));

/**
 * App's side: the list AND the attention digest, both at once. The same actions move Needs you (Get
 * Link clears "Send <name> their link", a hand-off to you adds one), and the digest otherwise waits
 * for its own 10-second read. Returns the unsubscribe.
 */
export function onListRefresh(target: Pick<EventTarget, "addEventListener" | "removeEventListener">, reads: { list(): void; attention(): void }): () => void {
  const run = () => {
    reads.list();
    reads.attention();
  };
  target.addEventListener(LIST_REFRESH_EVENT, run);
  return () => target.removeEventListener(LIST_REFRESH_EVENT, run);
}
