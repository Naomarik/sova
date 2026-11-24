// A chat's home rebuilt for the device it arrived on (§app.transport/arrival, "Paths rebuilt"): run
// in the staging folder, after the package verified and before the home is published. Each worker
// record's conversation, parent, folder, agent dir, extensions and environment point at this device's
// folders; each conversation's header and extension state too (server/harness/pi/relocate.ts); the
// team's and wakes' records likewise. A Copy also gives every conversation of the chat a new id
// (`ids`), so it is a chat of its own wherever it lands, its original's device included.
import { existsSync } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOME_FILE } from "../chat-homes/root";
import { mapDeep, type PathMap, relocateConversation } from "../harness/pi/relocate";

export type { PathMap } from "../harness/pi/relocate";

export interface Relocation {
  map: PathMap;
  /** Old session id → new one (a Copy); none for a Move. */
  ids?: Readonly<Record<string, string>>;
  /** This device's Sova code root: where a worker's extensions are loaded from here. */
  code?: string;
  /** Pairs applied last, after the code root: the agent dir, the state root, the home folder. */
  broad?: PathMap;
}

export interface Relocated {
  conversations: number;
  workers: number;
  records: number;
}

/** A conversation's session id from pi's file name, `<timestamp>_<id>.jsonl`. */
export const sessionIdOfName = (name: string): string | null => /_([^_/]+)\.jsonl$/.exec(name)?.[1] ?? null;

/** The conversation of session `sessionId` in a home's flat `sessions/` folder, or null. */
export async function findConversation(home: string, sessionId: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(join(home, "sessions"));
  } catch {
    return null;
  }
  const hit = names.find((n) => n.endsWith(".jsonl") && sessionIdOfName(n) === sessionId);
  return hit ? join(home, "sessions", hit) : null;
}

async function files(dir: string, ext: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p, ext)));
    else if (e.isFile() && e.name.endsWith(ext)) out.push(p);
  }
  return out.sort();
}

const renamed = (name: string, ids: Readonly<Record<string, string>>): string => {
  let out = name;
  for (const [k, v] of Object.entries(ids)) if (out.includes(k)) out = out.split(k).join(v);
  return out;
};

async function rewriteJson(file: string, r: Relocation): Promise<boolean> {
  const text = await readFile(file, "utf8");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return false; // not a record of ours
  }
  const next = mapDeep(v, r.map, r.ids ?? {}, r.code, r.broad ?? []);
  const out = `${JSON.stringify(next, null, text.includes('\n  "') ? 2 : undefined)}${text.endsWith("\n") ? "\n" : ""}`;
  if (JSON.stringify(next) === JSON.stringify(v)) return false;
  await writeFile(file, out, { mode: 0o600 });
  return true;
}

/** Rewrite the home at `home` (a staged copy) for this device. Idempotent: a second run changes nothing. */
export async function relocateHome(home: string, r: Relocation): Promise<Relocated> {
  const ids = r.ids ?? {};
  const out: Relocated = { conversations: 0, workers: 0, records: 0 };
  for (const f of await files(join(home, "sessions"), ".jsonl")) {
    const text = await readFile(f, "utf8");
    const next = relocateConversation(text, r.map, ids, r.code, r.broad ?? []);
    if (next !== null) {
      await writeFile(f, next, { mode: 0o600 });
      out.conversations++;
    }
    const name = renamed(f.slice(f.lastIndexOf("/") + 1), ids);
    if (!f.endsWith(`/${name}`)) await rename(f, join(home, "sessions", name));
  }
  for (const f of await files(join(home, "workers"), ".json")) {
    if (await rewriteJson(f, r)) out.workers++;
    const name = renamed(f.slice(f.lastIndexOf("/") + 1), ids);
    if (!f.endsWith(`/${name}`)) await rename(f, join(home, "workers", name));
  }
  // The team's records and the wakes; the chat's own records (its draft never travels).
  for (const dir of ["teams", "wakes", "chat"]) for (const f of await files(join(home, dir), ".json")) if (await rewriteJson(f, r)) out.records++;
  // A Copy's mailboxes name its members' sessions: their ids follow (messages keep their words otherwise).
  if (Object.keys(ids).length)
    for (const f of await files(join(home, "teams"), ".jsonl")) {
      const text = await readFile(f, "utf8");
      const next = renamed(text, ids);
      if (next !== text) {
        await writeFile(f, next, { mode: 0o600 });
        out.records++;
      }
    }
  for (const f of [HOME_FILE, "index.json"]) if (existsSync(join(home, f)) && (await rewriteJson(join(home, f), r))) out.records++;
  return out;
}
