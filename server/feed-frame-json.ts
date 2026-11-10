/**
 * The session feed's frame as text, made once per broadcast: the feed hands one message object to every socket in one
 * synchronous loop (SessionFeed.publish), so each socket after the first reuses the first one's text. The cache is
 * dropped at the end of the tick, so the same object sent again later (after a change) is serialized afresh.
 */
let last: { msg: object; json: string } | null = null;

export function feedFrameJson(msg: object): string {
  if (last?.msg === msg) return last.json;
  const json = JSON.stringify(msg);
  if (!last) queueMicrotask(() => (last = null));
  last = { msg, json };
  return json;
}
