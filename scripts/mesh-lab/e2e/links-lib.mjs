// Shared helpers for the linked-sessions harnesses (e2e/m6-links*.test.mjs, §mesh/links). Every
// call drives a host's own main listener through its laptop port (lib.mjs `laptopFetch`), so it
// acts as that host's local user: the local acts under /api/mesh/links/* answer there and only there.
//
//   import { newSession, link, send, waitInbox, … } from "./links-lib.mjs";
//
// Model turns use zai/glm-5.3 only (the one key the lab carries).

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laptopFetch, readAgentFile, STATE, waitFor, writeAgentFile } from "./lib.mjs";

export const MODEL = "zai/glm-5.3";
const LINKS_FILE = "sova/mesh-links.json";

/** `init` as JSON → `{ status, json }`; never throws on an HTTP status (a network error does throw). */
export async function api(host, path, { method = "GET", body, timeoutMs = 20000 } = {}) {
  const res = await laptopFetch(host, path, {
    method,
    timeoutMs,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

/** Throws unless the answer is 2xx; returns its JSON. */
function ok(r, what) {
  if (r.status < 200 || r.status > 299) throw new Error(`${what}: HTTP ${r.status} ${r.text.slice(0, 400)}`);
  return r.json;
}

/**
 * A new web session on `host` in `cwd`, set to `model` (and `mode`/`minorModes`) through
 * /api/sessions/configure, which also opens its runtime there (a link sender must be held).
 * Returns its SessionSummary.
 */
export async function newSession(host, { model = MODEL, cwd = "/root/work", mode, minorModes, thinking } = {}) {
  const s = ok(await api(host, "/api/sessions", { method: "POST", body: { cwd } }), `${host}: create session`);
  ok(
    await api(host, "/api/sessions/configure", {
      method: "POST",
      body: { path: s.path, model, ...(thinking ? { thinking } : {}), ...(mode ? { mode } : {}), ...(minorModes ? { minorModes } : {}) },
      timeoutMs: 60000,
    }),
    `${host}: configure ${s.id}`,
  );
  return s;
}

/** One prompt to a session, as the page sends it (POST /api/sessions/prompt). → { status, json } */
export const prompt = (host, path, text, delivery) => api(host, "/api/sessions/prompt", { method: "POST", body: { path, text, ...(delivery ? { delivery } : {}) } });

/** POST /api/mesh/links on `from`: members [{host?, session}] (host = a peer id on `from`). → { status, json } */
export const link = (from, members) => api(from, "/api/mesh/links", { method: "POST", body: { members }, timeoutMs: 30000 });

/** End a link from `host`. → { status, json } */
export const unlink = (host, linkId) => api(host, `/api/mesh/links/${linkId}/end`, { method: "POST" });

/** link_send as the extension calls it: `sessionId` must be held on `host`. → { status, json: LinkSendResult | LinkError } */
export const send = (host, sessionId, text, to, linkId) =>
  api(host, "/api/mesh/links/send", { method: "POST", body: { session: sessionId, text, ...(to !== undefined ? { to } : {}), ...(linkId ? { link: linkId } : {}) }, timeoutMs: 30000 });

/** link_members (brief: no peer hop) or every link on the host (no session). → LinkView[] */
export async function members(host, sessionId, { brief = false } = {}) {
  const q = sessionId ? `?session=${encodeURIComponent(sessionId)}${brief ? "&brief=1" : ""}` : "";
  return ok(await api(host, `/api/mesh/links${q}`), `${host}: links`).links;
}

/** link_inbox records, oldest first. */
export async function inbox(host, sessionId, limit) {
  return ok(await api(host, `/api/mesh/links/inbox?session=${encodeURIComponent(sessionId)}${limit ? `&limit=${limit}` : ""}`), `${host}: inbox ${sessionId}`).records;
}

/** GET /api/links/:id/thread → { status, json: LinkThread } */
export const thread = (host, linkId) => api(host, `/api/links/${linkId}/thread`);

/** GET /api/sessions/by-id/:id → SessionSummary or null (404). */
export async function byId(host, id) {
  const r = await api(host, `/api/sessions/by-id/${encodeURIComponent(id)}`);
  return r.status === 404 ? null : ok(r, `${host}: by-id ${id}`);
}

/** Wait until the session is not running a turn (twice in a row, `graceMs` after the call). */
export async function waitIdle(host, id, { timeoutMs = 180000, graceMs = 1500 } = {}) {
  await new Promise((r) => setTimeout(r, graceMs));
  let calm = 0;
  return waitFor(
    async () => {
      const s = await byId(host, id);
      const idle = s && !s.busy && s.activity?.state !== "working";
      calm = idle ? calm + 1 : 0;
      return calm >= 2 ? s : null;
    },
    { timeoutMs, intervalMs: 1000, what: `${host}/${id} idle` },
  );
}

/** Wait until `pred(records)` holds for the session's link inbox; returns the records. */
export const waitInbox = (host, sessionId, pred, { timeoutMs = 60000, what } = {}) =>
  waitFor(
    async () => {
      const recs = await inbox(host, sessionId);
      return pred(recs) ? recs : null;
    },
    { timeoutMs, intervalMs: 1000, what: what ?? `${host}/${sessionId} inbox` },
  );

/** The session's active branch as the page reads it: [{ kind, text, link? }]. */
export async function transcript(host, path) {
  const t = ok(await api(host, `/api/transcript?path=${encodeURIComponent(path)}`), `${host}: transcript`);
  return t.items.map((i) => ({ kind: i.kind, text: i.text ?? "", ...(i.link ? { link: i.link } : {}) }));
}

/** The host's <agent>/sova/mesh-links.json as on disk, or null. */
export function linksFile(host) {
  const raw = readAgentFile(host, LINKS_FILE);
  return raw ? JSON.parse(raw) : null;
}
/** Replace (or, with null, reset to empty) a host's mesh-links.json. Sova reads it once: restart after. */
export function writeLinksFile(host, file) {
  writeAgentFile(host, LINKS_FILE, `${JSON.stringify(file ?? { version: 1, links: [] }, null, 2)}\n`);
}

// ---- the lab lock (one mutating runner at a time) --------------------------------------------------

const LOCK = join(STATE, "LOCK");

/** Take the lab lock for `role`, waiting while someone else holds it. */
export async function takeLock(role, { timeoutMs = 30 * 60000 } = {}) {
  await waitFor(
    () => {
      try {
        mkdirSync(LOCK);
        writeFileSync(join(LOCK, "owner"), `${role}\n`);
        return true;
      } catch {
        return false;
      }
    },
    { timeoutMs, intervalMs: 5000, what: "the lab LOCK" },
  );
}
export const releaseLock = () => rmSync(LOCK, { recursive: true, force: true });
