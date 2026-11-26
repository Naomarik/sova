// Team Bar, the user part: runs on a person's own Sova and answers the `list` screen place with the
// team's people and the label key that names a chat's owner. Sova draws the person menu and the owner
// avatars from this answer and from the `owner` label the host-mode part puts on each chat on the shared
// server. Node builtins only; no page.
//
// People come from $SOVA_EXTENSION_DATA_DIR/people.json (see ../people.example.json), read on each ask, so an
// edit needs no restart and no new approval (the data folder is not part of what you approve).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

const PORT = Number(process.env.PORT);
const DATA = process.env.SOVA_EXTENSION_DATA_DIR ?? "";
/** The label key whose value is a people[].id: the host-mode part writes it under this same extension id. */
const OWNER_KEY = "owner";

/** The people file, as the `list` place's answer wants it; null when there is none or it doesn't read. */
export function declaration(file = join(DATA, "people.json")) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const people = (Array.isArray(raw?.people) ? raw.people : [])
    .filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && typeof p.initials === "string")
    .map((p) => ({ id: p.id, name: p.name, initials: p.initials, callers: Array.isArray(p.callers) ? p.callers.filter((c) => typeof c === "string") : [] }));
  if (!people.length) return null;
  const self = typeof raw.self === "string" && people.some((p) => p.id === raw.self) ? raw.self : undefined;
  return { people, ownerKey: OWNER_KEY, ...(self ? { self } : {}) };
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/api/health") return json(res, 200, { ok: true, part: "user" });
    if (req.method === "GET" && path === "/api/screens/list") {
      const d = declaration();
      // No people configured: answer nothing, so Sova draws nothing.
      if (d) return json(res, 200, d);
      res.writeHead(204);
      return res.end();
    }
    json(res, 404, { error: "Not found" });
  }).listen(PORT, "127.0.0.1", () => console.log(`team-bar (user) on 127.0.0.1:${PORT}`));
}
