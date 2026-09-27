// Shared helpers for the linked-sessions harnesses (e2e/m6-links*.test.mjs, §mesh/links). Every
// call drives a host's own main listener through its laptop port (lib.mjs `laptopFetch`), so it
// acts as that host's local user: the local acts under /api/mesh/links/* answer there and only there.
//
//   import { newSession, link, send, waitInbox, … } from "./links-lib.mjs";
//
// Model turns use zai/glm-5.3 only (the one key the lab carries).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, laptopFetch, readAgentFile, sh, STATE, waitFor, writeAgentFile } from "./lib.mjs";

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

// ---- file offers (§mesh.links/offers, /transfer) -----------------------------------------------------

/** link_offer as the extension calls it: body = LinkOfferCreate. → { status, json: LinkOfferCreateResult | LinkError } */
export const offer = (host, body) => api(host, "/api/mesh/links/offers", { method: "POST", body, timeoutMs: 5 * 60000 });

/** link_accept on the recipient's host. → { status, json: LinkOffer | LinkError } */
export const accept = (host, sessionId, offerId, dest) =>
  api(host, `/api/mesh/links/offers/${offerId}/accept`, { method: "POST", body: { session: sessionId, dest }, timeoutMs: 30000 });

/** link_decline on the recipient's host. → { status, json: LinkOffer | LinkError } */
export const decline = (host, sessionId, offerId, reason) =>
  api(host, `/api/mesh/links/offers/${offerId}/decline`, { method: "POST", body: { session: sessionId, ...(reason ? { reason } : {}) }, timeoutMs: 30000 });

/** link_offers: every offer the session's host holds for it (the sender's copy has every row). → LinkOffer[] */
export async function offers(host, sessionId) {
  return ok(await api(host, `/api/mesh/links/offers?session=${encodeURIComponent(sessionId)}`, { timeoutMs: 30000 }), `${host}: offers ${sessionId}`).offers;
}

/** One recipient's row of an offer, by its session id. */
export const rowOf = (o, sessionId) => o?.recipients?.find((r) => r.to.sessionId === sessionId);

/** Wait until `pred(offer)` holds for the offer as `host` holds it for the session; returns the offer. */
export const waitOffer = (host, sessionId, offerId, pred, { timeoutMs = 120000, intervalMs = 1000, what } = {}) =>
  waitFor(
    async () => {
      const o = (await offers(host, sessionId)).find((x) => x.id === offerId);
      return o && pred(o) ? o : null;
    },
    { timeoutMs, intervalMs, what: what ?? `${host}/${sessionId} offer ${offerId}` },
  );

/**
 * A tree at `dir` on `host` (replaced if present), made inside the container:
 *   files: N small text files spread over 100 × 7 directories;
 *   blobs/blobMiB: that many files of random bytes (incompressible);
 *   extra: { "rel/path": "text" }; symlinks: { "rel/name": "target" };
 *   git: a repository with one commit of all of it.
 */
export function makeTree(host, dir, { files = 0, blobs = 0, blobMiB = 0, extra = {}, symlinks = {}, git = false } = {}) {
  const script = `const fs=require("fs"),p=require("path"),cp=require("child_process");
const [dir,spec]=[process.argv[1],JSON.parse(process.argv[2])];
fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
for(let i=0;i<spec.files;i++){const d=p.join(dir,"d"+(i%100),"s"+(i%7));fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,"f"+i+".txt"),("file "+i+"\\n").repeat(1+(i%20)));}
for(let i=0;i<spec.blobs;i++)cp.execFileSync("sh",["-c",'head -c "$1" /dev/urandom > "$2"',"-",String(spec.blobMiB*1048576),p.join(dir,"blob"+i+".bin")]);
for(const[k,v]of Object.entries(spec.extra)){fs.mkdirSync(p.dirname(p.join(dir,k)),{recursive:true});fs.writeFileSync(p.join(dir,k),v);}
for(const[k,v]of Object.entries(spec.symlinks)){fs.mkdirSync(p.dirname(p.join(dir,k)),{recursive:true});fs.symlinkSync(v,p.join(dir,k));}
if(spec.git)cp.execSync("git init -q && git add -A && git -c user.name=lab -c user.email=lab@mesh.lab commit -qm tree",{cwd:dir});`;
  const r = exec(host, ["node", "-e", script, dir, JSON.stringify({ files, blobs, blobMiB, extra, symlinks, git })], { timeoutMs: 20 * 60000 });
  if (r.code !== 0) throw new Error(`makeTree ${host}:${dir}: ${r.err || r.out}`);
}

/**
 * One hash of a tree on `host`: every member's type and path (a symlink's target, a file's size),
 * then every regular file's sha256, all in C order. Equal hashes = the same tree, byte for byte.
 */
export function treeHash(host, dir) {
  const r = sh(
    host,
    `cd "${dir}" && { find . -mindepth 1 \\( -type l -printf 'l %p -> %l\\n' \\) -o \\( -type d -printf 'd %p\\n' \\) -o \\( -type f -printf 'f %p %s\\n' \\) -o -printf '? %p\\n' | LC_ALL=C sort; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum; } | sha256sum | cut -d' ' -f1`,
    { timeoutMs: 20 * 60000 },
  );
  if (r.code !== 0 || !/^[0-9a-f]{64}$/.test(r.out)) throw new Error(`treeHash ${host}:${dir}: ${r.err || r.out}`);
  return r.out;
}

// ---- the lab lock (one mutating runner at a time) --------------------------------------------------

const LOCK = join(STATE, "LOCK");

/** Take the lab lock for `role`, waiting while someone else holds it (already `role`'s: taken). */
export async function takeLock(role, { timeoutMs = 30 * 60000 } = {}) {
  await waitFor(
    () => {
      try {
        mkdirSync(LOCK);
        writeFileSync(join(LOCK, "owner"), `${role}\n`);
        return true;
      } catch {
        try {
          return readFileSync(join(LOCK, "owner"), "utf8").trim() === role;
        } catch {
          return false;
        }
      }
    },
    { timeoutMs, intervalMs: 5000, what: "the lab LOCK" },
  );
}
export const releaseLock = () => rmSync(LOCK, { recursive: true, force: true });
