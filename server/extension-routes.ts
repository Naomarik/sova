// Settings → Extensions' routes. The two reads answer anyone the gate let in, and need
// `full` from another computer (server/mesh/access.ts); every change is your own page's,
// and a request from an extension's own page is refused too, as an accident guard.
import type { Context, Hono } from "hono";
import type { ExtensionRow, ExtensionsInstalled } from "../shared/extension-loader";
import { hostname } from "node:os";
import { approveExtension, chooseFolder, installFolder, LoaderRefusal, programAction, programNotFound, programStartedAt, removeExtension, reviewEntry, reviewFolder, turnOff, turnOn } from "./extension-loader";
import { programLog, programStatus } from "./extension-program";
import { contractWords, extensionHealth, listedExtensions, peerExtensionEntries, type ListedExtension } from "./extensions";
import { extensionPageRefusal, notPage, yourClickRefusal } from "./page-only";

const NO_STORE = { "Cache-Control": "no-store" };
/** A program is Starting until it answers, for this long. */
const STARTING_MS = 30_000;

const LINES: Partial<Record<ListedExtension["state"], string>> = {
  "needs-newer": "This needs a newer Sova. Nothing is running.",
  waiting: "Added or edited outside this screen. Nothing runs until you approve it.",
  changed: "Changed since you approved it. It is still running the old code, and its page is off.",
};

/** One row's one state, the first that applies. */
export async function rowOf(l: ListedExtension): Promise<ExtensionRow> {
  if (!l.valid) {
    const named = typeof l.raw.id === "string" ? l.raw.id : "";
    const dup = l.error?.startsWith("a second entry");
    return { key: named && !dup ? named : `~${l.index}`, id: named, title: typeof l.raw.title === "string" && l.raw.title ? l.raw.title : named || "An entry with no id", state: "not-usable", line: `This can't be used: ${l.error}.` };
  }
  const e = l.valid.entry;
  const folder = typeof l.raw.folder === "string" ? l.raw.folder : undefined;
  const run = Array.isArray(l.raw.run) && l.raw.run.length > 0;
  const base: ExtensionRow = {
    key: e.id,
    id: e.id,
    title: e.title,
    ...(folder ? { folder } : {}),
    state: "running",
    ...(run ? { hasProgram: true } : {}),
    ...(l.valid.offers?.cards?.length ? { hasCards: true } : {}),
  };
  if (l.state === "folder-not-found") return { ...base, state: l.state, line: `This folder is gone: ${folder}. Its program is stopped.` };
  if (l.state === "needs-newer" || l.state === "waiting") return { ...base, state: l.state, line: LINES[l.state]! };
  if (l.state === "changed") return { ...base, state: l.state, line: LINES.changed! };
  if (l.state === "off") return { ...base, state: "off", on: false };
  const on: ExtensionRow = { ...base, on: true };
  if (!run) {
    if (!e.api) return on;
    const own: ExtensionRow = { ...on, ownProgram: true, line: "You run this program yourself, so Sova doesn't start or stop it." };
    const h = await extensionHealth(e.id);
    return h?.status === "ok" ? own : { ...own, state: "stopped", line: `Its program isn't answering. ${own.line}` };
  }
  const missing = programNotFound(e.id);
  if (missing) return { ...on, state: "stopped", line: missing };
  const st = await programStatus(e.id);
  if (st.state !== "active" && st.state !== "activating") return { ...on, state: "stopped", line: "Its program exited." };
  const h = await extensionHealth(e.id);
  if (h?.status === "ok") return on;
  const at = programStartedAt(e.id);
  if (st.state === "activating" || (at !== undefined && Date.now() - at < STARTING_MS)) return { ...on, state: "starting" };
  return { ...on, state: "stopped", line: "Its program isn't answering." };
}

export function registerExtensionRoutes(app: Hono<any>): void {
  /** Your own page only; a refusal's `error` is the deck's sentence. */
  const page =
    (fn: (c: Context) => Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      const refused = yourClickRefusal(c, "extensions") ?? extensionPageRefusal(c);
      if (refused) return refused;
      try {
        return await fn(c);
      } catch (err) {
        if (err instanceof LoaderRefusal) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status, NO_STORE);
        throw err;
      }
    };
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
    } catch {
      // below
    }
    throw new LoaderRefusal("Expected a JSON body.", 400, "invalid");
  };
  const folderOf = (b: Record<string, unknown>): string => {
    if (typeof b.folder !== "string" || !b.folder.startsWith("/")) throw new LoaderRefusal("Expected {folder}, an absolute path.", 400, "invalid");
    return b.folder;
  };

  app.get("/api/extensions/installed", async (c) => {
    const list = listedExtensions();
    if (list === null) return c.json({ error: "The list can't be read whole." }, 409, NO_STORE);
    const answer: ExtensionsInstalled = {
      rows: await Promise.all(list.map(rowOf)),
      others: peerExtensionEntries().map((p) => ({ id: p.entry.id, title: p.entry.title, from: p.from ?? "" })),
      ...(notPage(c) === "local" ? { through: hostname() } : {}),
      has: contractWords(),
    };
    return c.json(answer, 200, NO_STORE);
  });
  app.get("/api/extensions/:id/log", async (c) => c.json({ lines: await programLog(c.req.param("id"), 200) }, 200, NO_STORE));

  app.post(
    "/api/extensions/inspect",
    page(async (c) => {
      const b = await body(c);
      if (typeof b.id === "string" && b.folder === undefined) return c.json(await reviewEntry(b.id), 200, NO_STORE);
      return c.json(await reviewFolder(folderOf(b), typeof b.id === "string" ? b.id : undefined), 200, NO_STORE);
    }),
  );
  app.post(
    "/api/extensions/install",
    page(async (c) => {
      const b = await body(c);
      return c.json({ id: await installFolder(folderOf(b), b.version) }, 200, NO_STORE);
    }),
  );
  const done = (c: Context) => c.json({ ok: true }, 200, NO_STORE);
  app.post(
    "/api/extensions/:id/approve",
    page(async (c) => {
      await approveExtension(c.req.param("id") ?? "", (await body(c)).version);
      return done(c);
    }),
  );
  app.post(
    "/api/extensions/:id/folder",
    page(async (c) => {
      const b = await body(c);
      await chooseFolder(c.req.param("id") ?? "", folderOf(b), b.version);
      return done(c);
    }),
  );
  app.post(
    "/api/extensions/:id/on",
    page(async (c) => {
      await turnOn(c.req.param("id") ?? "");
      return done(c);
    }),
  );
  app.post(
    "/api/extensions/:id/off",
    page(async (c) => {
      await turnOff(c.req.param("id") ?? "");
      return done(c);
    }),
  );
  app.post(
    "/api/extensions/:id/program",
    page(async (c) => {
      await programAction(c.req.param("id") ?? "", (await body(c)).action);
      return done(c);
    }),
  );
  app.delete(
    "/api/extensions/:id",
    page(async (c) => {
      const b = await body(c).catch(() => ({}) as Record<string, unknown>);
      await removeExtension(c.req.param("id") ?? "", b.deleteData === true);
      return done(c);
    }),
  );
}
