// Run: pnpm exec tsx --conditions=browser --test src/lib/claude-catalog.browser.test.ts. An open Settings
// tab's model rows follow the Claude list with no reopening (§app.claude-code-provider/model-table).
// Solid's reactive (browser) build and a fake server: what `fetch` answers is all that changes.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createEffect, createRoot } from "solid-js";
import type { ClaudeCatalogInfo, DelegateOptions } from "../../shared/protocol";
import { mergeClaudeCatalog } from "../../pi-config/extensions/claude-code/catalog.ts";
import { claudeListIsLastKnown, liveDelegateOptions, loadClaudeCatalog } from "./claude-catalog";

if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser");

const NEW = "claude-nova-1-2";
const optionsWith = (...ids: string[]): DelegateOptions => ({
  backends: [{ id: "claude-code", label: "Claude Code", models: ids.map((id) => ({ id, name: id, efforts: ["low"] })) }],
});

interface Server { options: DelegateOptions | null; catalog: ClaudeCatalogInfo; optionReads: number }
let dispose: (() => void) | undefined;

function server(): Server {
  const s: Server = { options: optionsWith("claude-opus-5-5"), catalog: { data: { models: [] }, lastKnown: false }, optionReads: 0 };
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/api/claude/catalog")) return Response.json(s.catalog);
    if (u.includes("/api/settings/delegate/options")) {
      s.optionReads++;
      return s.options ? Response.json(s.options) : Response.json({ error: "down" }, { status: 500 });
    }
    throw new Error(`unexpected ${u}`);
  }) as typeof fetch;
  return s;
}

/** A tab's rows: every state they read, and a wait for the first read that lists `id`. */
function openTab() {
  const states: string[] = [];
  const waiting: { id: string; done: () => void }[] = [];
  const ids = { now: [] as string[] };
  createRoot((d) => {
    dispose = d;
    const [options] = liveDelegateOptions();
    createEffect(() => {
      states.push(options.state);
      if (options.state !== "ready") return;
      ids.now = options()!.backends[0]!.models!.map((m) => m.id);
      for (const w of waiting) if (ids.now.includes(w.id)) w.done();
    });
  });
  const lists = (id: string) => (ids.now.includes(id) ? Promise.resolve() : new Promise<void>((done) => waiting.push({ id, done })));
  return { states, ids, lists };
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  mergeClaudeCatalog({ models: [] });
});

test("a new model reaches an open tab's rows in place, never through Checking…", async () => {
  const s = server();
  const tab = openTab();
  await tab.lists("claude-opus-5-5");
  const before = tab.states.length;

  s.options = optionsWith("claude-opus-5-5", NEW);
  s.catalog = { data: { models: [{ id: NEW }] }, lastKnown: false };
  await loadClaudeCatalog();
  await tab.lists(NEW);

  assert.deepEqual([...new Set(tab.states.slice(before))], ["ready"], "the rows stay readable while they're read again");
});

test("a catalog with no change reads nothing; only the last-known flag moves", async () => {
  const s = server();
  const tab = openTab();
  await tab.lists("claude-opus-5-5");
  const reads = s.optionReads;

  s.catalog = { data: { models: [] }, lastKnown: true };
  await loadClaudeCatalog();

  assert.equal(claudeListIsLastKnown(), true);
  assert.equal(s.optionReads, reads);
  s.catalog = { data: { models: [] }, lastKnown: false };
  await loadClaudeCatalog();
  assert.equal(claudeListIsLastKnown(), false);
});

test("a re-read that fails leaves the rows as they are", async () => {
  const s = server();
  const tab = openTab();
  await tab.lists("claude-opus-5-5");

  s.options = null;
  s.catalog = { data: { models: [{ id: NEW }] }, lastKnown: false };
  const failed = s.optionReads + 1;
  await loadClaudeCatalog();
  while (s.optionReads < failed) await new Promise((r) => setTimeout(r, 1));
  await new Promise((r) => setTimeout(r, 5));

  assert.deepEqual(tab.ids.now, ["claude-opus-5-5"]);
  assert.equal(tab.states.at(-1), "ready");
});

test("every screen with model rows reads them through the live list", () => {
  const src = join(import.meta.dirname, "..");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !n.includes(".test.") ? [p] : [];
  });
  const direct = files(src).filter((f) => /\bgetDelegateOptions\b/.test(readFileSync(f, "utf8"))).map((f) => f.slice(src.length + 1)).sort();
  assert.deepEqual(direct, ["lib/api.ts", "lib/claude-catalog.ts"], "a screen that calls getDelegateOptions itself needs its tab reopened to see a new model");
  for (const screen of ["ProfilesSettings", "OverseerSettings", "SummarizerSettings", "SessionTitleSettings"])
    assert.match(readFileSync(join(src, "components", `${screen}.tsx`), "utf8"), /= liveDelegateOptions\(\);/, screen);
});
