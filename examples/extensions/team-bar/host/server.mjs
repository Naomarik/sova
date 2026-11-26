// Team Bar, the host-mode part: runs on the shared server. Its description asks Sova for `senders`, so
// Sova records which computer started each chat and which computer typed each message. This program
// turns "which computer started it" into a person and puts that person's id on the chat as its `owner`
// label, under this extension's id (`team-bar`), which is the id the user part on each person's Sova
// declares, so their bar can filter by person and draw the owner's avatar. Node builtins only; no page.
//
// People come from $SOVA_EXTENSION_DATA_DIR/people.json (see ../people.example.json), read on each pass.
// A chat whose starter matches no one's `callers` is left without an owner.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

const PORT = Number(process.env.PORT);
const SOVA = process.env.SOVA_URL ?? "";
const KEY_FILE = process.env.SOVA_EXTENSION_KEY_FILE ?? "";
const DATA = process.env.SOVA_EXTENSION_DATA_DIR ?? "";
const ID = process.env.SOVA_EXTENSION_ID || "team-bar";
const OWNER_KEY = "owner";
/** How often the whole list is checked for chats with no owner yet (events make it sooner). */
const PASS_MS = 3000;

export function readPeople(file = join(DATA, "people.json")) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw?.people) ? raw.people : [];
  } catch {
    return [];
  }
}

/** The person whose callers name `caller` (a recorded starter: "peer:<node id>" or "operator"). */
export function personOf(people, caller) {
  if (typeof caller !== "string") return undefined;
  return people.find((p) => Array.isArray(p.callers) && p.callers.includes(caller));
}

let key = "";
const readKey = () => {
  try {
    key = readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    key = "";
  }
};

/** A call to Sova with this extension's key; on a 401 the key file is read again once (it may have rotated). */
async function sova(method, path, body) {
  if (!key) readKey();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${SOVA}${path}`, {
      method,
      headers: { "x-sova-token": key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401 && attempt === 0) {
      readKey();
      continue;
    }
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }
}

// ---- the parts that follow Sova's openings (labels and senders) ---------------------------------------

/** This chat's owner label as Sova lists it, if any. */
const ownerOf = (row) => row?.labels?.[ID]?.[OWNER_KEY];

/** Who started the chat, as Sova recorded it (`senders`): "peer:<node id>", "operator", or null. */
async function startedBy(row) {
  const r = await sova("GET", `/api/sessions/senders?path=${encodeURIComponent(row.path)}`);
  const by = r.status === 200 ? r.body?.startedBy?.by : null;
  return typeof by === "string" ? by : null;
}

async function setOwner(row, person) {
  return sova("POST", "/api/sessions/labels", { id: row.id, labels: { [OWNER_KEY]: person } });
}

/** The chats Sova holds here, with the labels this extension put on them. */
async function listChats() {
  const r = await sova("GET", `/api/sessions?labels=${encodeURIComponent(`${ID}:${OWNER_KEY}`)}`);
  if (r.status !== 200) return [];
  return Array.isArray(r.body) ? r.body : Array.isArray(r.body?.sessions) ? r.body.sessions : [];
}

// -------------------------------------------------------------------------------------------------------

/** Chats already looked at and found to have no known starter: asked again only after a minute. */
const unknownUntil = new Map();
let passing = false;

/** One pass: every chat with no owner whose starter is a known person gets that person as its owner. */
export async function pass() {
  if (passing) return;
  passing = true;
  try {
    const people = readPeople();
    if (!people.length) return;
    for (const row of await listChats()) {
      if (ownerOf(row) || (unknownUntil.get(row.id) ?? 0) > Date.now()) continue;
      // A helper chat follows the chat that started it (Sova reads the parent's labels for it).
      if (row.workerOf) continue;
      const person = personOf(people, await startedBy(row));
      if (!person) {
        unknownUntil.set(row.id, Date.now() + 60_000);
        continue;
      }
      const r = await setOwner(row, person.id);
      if (r.status >= 300) console.error(`team-bar: labelling ${row.id} failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
  } catch (err) {
    console.error(`team-bar: pass failed: ${err?.message ?? err}`);
  } finally {
    passing = false;
  }
}

/** Sova's events: a new chat is labelled within about a second instead of at the next pass. */
function listen() {
  if (typeof WebSocket !== "function") return;
  let ws;
  try {
    // Node's and Bun's WebSocket both take headers here; a browser's never would, and this never runs in one.
    ws = new WebSocket(`${SOVA.replace(/^http/, "ws")}/ws/events`, { headers: { "x-sova-token": key } });
  } catch {
    return;
  }
  ws.addEventListener("message", (m) => {
    if (/"session\.(created|changed|labelled)"/.test(String(m.data))) setTimeout(pass, 300);
  });
  ws.addEventListener("close", () => setTimeout(listen, 5000));
  ws.addEventListener("error", () => {});
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  readKey();
  createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/api/health") return json(res, 200, { ok: true, part: "host" });
    json(res, 404, { error: "Not found" });
  }).listen(PORT, "127.0.0.1", () => console.log(`team-bar (host mode) on 127.0.0.1:${PORT}`));
  setInterval(pass, PASS_MS);
  void pass();
  listen();
}
