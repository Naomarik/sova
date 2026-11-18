// Run: pnpm test -- src/lib/playbook-runs.browser.test.ts (Solid's reactive build).
// A chat's playbook runs store takes every view whole (src/lib/playbook-run-view.ts), whichever way it
// comes in: a run frozen before teams had members (al_2 a21) reads as an empty team through the list
// load and through record(id), so the card reading it never throws. A fake server: what `fetch`
// answers is all that changes.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { usePlaybookRuns } = await import("./playbook-runs");
type PlaybookRunsStore = import("./playbook-runs").PlaybookRunsStore;

const PATH = "/sessions/a.jsonl";
/** A started run as an older server sends it: its team has roles, a coordinator and a monitor, no members. */
const oldRun = {
  id: "pr_aaaaaaaaaaaa",
  revision: 3,
  playbook: { source: "sova", id: "zz", title: "Card check", dir: "/p" },
  state: "started",
  choices: [],
  teams: [{ id: "write", label: "Write and read together", roles: ["writer", "reader"], coordinator: { modelLabel: "Qwen3 4B" }, monitor: { modelLabel: "Qwen3 4B" } }],
  steps: [{ id: "agree", title: "Agree the topic", stop: "always", stopOn: true, runs: "main" }],
  cycle: null,
  howItRuns: "Runs in this chat.",
  commands: [],
  helpers: { total: 5, limit: 24 },
  startBlocked: "This run has started.",
  started: { at: "2026-11-17T00:27:00Z", revision: 3, chat: { id: "c", path: PATH }, newChat: false, folder: "/f" },
};

const realFetch = globalThis.fetch;
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  globalThis.fetch = realFetch;
});

function fakeServer() {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes(`/api/playbook-runs?path=`)) return Response.json({ runs: [oldRun] });
    if (u.endsWith(`/api/playbook-runs/${oldRun.id}`)) return Response.json(oldRun);
    throw new Error(`unexpected ${u}`);
  }) as typeof fetch;
}

/** The chat's store, and a wait for its first list read. */
function chatStore(): Promise<PlaybookRunsStore> {
  return new Promise((resolve) => {
    solid.createRoot((d) => {
      dispose = d;
      const store = usePlaybookRuns(PATH, () => "/p", null);
      solid.createEffect(() => {
        if (store.runs().length) resolve(store);
      });
    });
  });
}

test("an older run read through the chat's list comes in whole: its team's members are empty, its step names no team", async () => {
  fakeServer();
  const store = await chatStore();
  const run = store.runs()[0]!;
  assert.deepEqual(run.teams[0]!.members, []);
  assert.equal(run.teams[0]!.goal, "");
  assert.deepEqual(run.steps[0]!.teams, []);
  assert.deepEqual(run.who, { teams: 1, members: 0 });
});

test("an older run read by its id (a put-away record) comes in whole too", async () => {
  fakeServer();
  const store = await chatStore();
  const record = await store.record(oldRun.id);
  assert.deepEqual(record.teams[0]!.members, []);
  assert.deepEqual(record.steps[0]!.teams, []);
});

test("Start pressed on a run's card is the chat's to know until it's answered, and only for that run", async () => {
  fakeServer();
  const store = await chatStore();
  assert.equal(store.starting(oldRun.id), false);
  store.setStarting(oldRun.id, true);
  assert.equal(store.starting(oldRun.id), true);
  assert.equal(store.starting("pr_bbbbbbbbbbbb"), false);
  store.setStarting(oldRun.id, false);
  assert.equal(store.starting(oldRun.id), false);
});
