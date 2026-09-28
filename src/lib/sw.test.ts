import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

// public/sw.js is hand-rolled with no build step, so it is loaded here as the browser loads it: its
// text run against a stub `self`, then driven through the events it registers.
const SOURCE = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "http://127.0.0.1:4810";

function loadWorker(cacheNames: string[] = []) {
  const handlers = new Map<string, (event: unknown) => void>();
  const names = [...cacheNames];
  const deleted: string[] = [];
  const cache = { match: async () => undefined, put: async () => {}, addAll: async () => {} };
  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: {},
  };
  const caches = {
    open: async (name: string) => {
      if (!names.includes(name)) names.push(name);
      return cache;
    },
    keys: async () => [...names],
    delete: async (name: string) => (deleted.push(name), true),
    match: async () => undefined,
  };
  const fetch = async () => new Response("", { status: 503 });
  runInNewContext(SOURCE, { self, caches, fetch, URL, Response });
  /** Whether the worker answers this GET itself (its caches) or leaves it to the network. */
  const answers = (path: string, mode: string = "cors"): boolean => {
    let responded = false;
    handlers.get("fetch")!({
      request: { method: "GET", url: `${ORIGIN}${path}`, mode },
      respondWith: () => {
        responded = true;
      },
      waitUntil: () => {},
    });
    return responded;
  };
  const activate = async (): Promise<string[]> => {
    const jobs: Promise<unknown>[] = [];
    handlers.get("activate")!({ waitUntil: (p: Promise<unknown>) => jobs.push(p) });
    await Promise.all(jobs);
    return deleted;
  };
  return { answers, activate };
}

test("everything under /peer/ goes to the network, never through the worker's cache", () => {
  const w = loadWorker();
  for (const path of [
    "/peer/sova-vps/api/baton/0199aa/link",
    "/peer/sova-vps/api/orgs/org_28jaa7uy",
    "/peer/sova-vps/api/orgs/org_28jaa7uy/projects/prj_1/overseer?x=1",
    "/peer/sova-vps/ws/chat?path=%2Fa.jsonl",
    "/peer/sova-vps/anything-else",
    "/peer/",
  ]) {
    assert.equal(w.answers(path), false, path);
  }
});

test("this host's live data stays uncached as before; the shell and static files stay cached", () => {
  const w = loadWorker();
  for (const path of ["/api/sessions", "/ws/chat", "/ext/notes/", "/design/base.css"]) assert.equal(w.answers(path), false, path);
  // The prefix is a path segment: a static file whose name merely starts with "peer" is still the worker's.
  for (const path of ["/assets/index-abc123.js", "/icons/pwa-192.png", "/peers.svg"]) assert.equal(w.answers(path), true, path);
  assert.equal(w.answers("/", "navigate"), true);
});

test("activating drops the caches that stored peer answers", async () => {
  const w = loadWorker(["sova-v1", "sova-v2", "other-app"]);
  const deleted = await w.activate();
  assert.ok(deleted.includes("sova-v2"), "sova-v2 held /peer/ answers and must go");
  assert.ok(deleted.includes("sova-v1"));
  assert.ok(!deleted.includes("other-app"), "only this app's own caches are dropped");
});
