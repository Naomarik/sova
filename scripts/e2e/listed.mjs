// The rows of sessions a walkthrough wrote from outside the server, from GET /api/sessions.
//
// A change made outside the server reaches a listing up to 1 s later
// (§app.session-list/listing-reuse: a listing started before the write is shared for a second), so a
// first ask right after the write can miss the file. Asks again every 100 ms, for up to 5 s (the
// 1 s, plus a listing's own build on a cold server). A session created through the server itself is
// in the very next listing and needs no wait.

const POLL_MS = 100;
const BOUND_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until every key in `keys` is listed, matched on the row's `field` (`id` or `path`), and
 * returns a Map of key to row. `api(path)` is the walkthrough's own authenticated GET, returning JSON.
 */
export async function whenListed(api, keys, field = "id") {
  const until = Date.now() + BOUND_MS;
  for (;;) {
    const list = await api("/api/sessions");
    const rows = new Map();
    for (const s of Array.isArray(list) ? list : (list.sessions ?? [])) if (keys.includes(s[field])) rows.set(s[field], s);
    const missing = keys.filter((k) => !rows.has(k));
    if (!missing.length) return rows;
    if (Date.now() >= until) throw new Error(`the fixture ${missing.join(", ")} isn't listed by the server ${BOUND_MS / 1000} s after it was written`);
    await sleep(POLL_MS);
  }
}
