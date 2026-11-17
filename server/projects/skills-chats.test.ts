// Run: pnpm test server/projects/skills-chats.test.ts. Its folders are in the runner's throwaway home.
//
// After a folder's decisions change, its chats not yet started are rebuilt: a burst of saves shares one rebuild,
// and a save that turns nothing on or off only tells the panes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const base = realpathSync(mkdtempSync(join(homedir(), "skills-chats-")));
const agent = join(base, "agent");
mkdirSync(join(agent, "sova"), { recursive: true });
const prevAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agent;

const { setChatRouter } = await import("../chat-handle");
const { GATHER, refreshFolderChats } = await import("./skills-chats");

after(() => {
  setChatRouter(null);
  if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgent;
  rmSync(base, { recursive: true, force: true });
});

/** Two folders, a new chat in each and a started one in the first; what the router was asked. */
function chats() {
  const one = join(base, "one");
  const two = join(base, "two");
  for (const d of [one, two]) mkdirSync(join(d, ".git"), { recursive: true });
  const closed: string[] = [];
  const told: string[] = [];
  const handle = (path: string, cwd: string, pristine: boolean) => ({
    path,
    mirror: { cwd, pristine, running: false, special: undefined, loadout: { toggleable: pristine, off: null } },
    pushSetupChanged: () => void told.push(path),
  });
  const all = [handle("new-one", one, true), handle("old-one", one, false), handle("new-two", two, true)];
  setChatRouter({
    ready: async () => {},
    get: (p) => all.find((h) => h.path === p) as never,
    all: () => all as never,
    acquire: async (p) => all.find((h) => h.path === p) as never,
    close: async (p) => (closed.push(p), true),
  });
  return { one, two, closed, told, keys: { one: `d:${one}`, two: `d:${two}` } };
}

test("a burst of saves rebuilds each new chat of the folder once, after the last; a started chat is only told, another folder's not at all", async () => {
  const c = chats();
  const n = await Promise.all([refreshFolderChats(c.keys.one), refreshFolderChats(c.keys.one), refreshFolderChats(c.keys.one)]);
  assert.deepEqual(n, [1, 1, 1], "every save's answer waits for the one refresh");
  assert.deepEqual(c.closed, ["new-one"]);
  assert.deepEqual(c.told.sort(), ["new-one", "old-one"]);
});

test("a save made while a refresh runs joins the next one: two rebuilds for any number of saves", async () => {
  const c = chats();
  const first = refreshFolderChats(c.keys.one);
  await new Promise((r) => setTimeout(r, GATHER.ms + 20)); // the first has started
  const later = [refreshFolderChats(c.keys.one), refreshFolderChats(c.keys.two), refreshFolderChats(c.keys.one)];
  await Promise.all([first, ...later]);
  assert.deepEqual(c.closed.sort(), ["new-one", "new-one", "new-two"]);
});

test("a save that turns nothing on or off rebuilds nothing: the panes are told to read again", async () => {
  const c = chats();
  assert.equal(await refreshFolderChats(c.keys.one, { rebuild: false }), 0);
  assert.deepEqual(c.closed, []);
  assert.deepEqual(c.told.sort(), ["new-one", "old-one"]);
  // Joined by one that does turn something on or off: rebuilt, once.
  await Promise.all([refreshFolderChats(c.keys.two, { rebuild: false }), refreshFolderChats(c.keys.two)]);
  assert.deepEqual(c.closed, ["new-two"]);
  // The Sova-wide setting: every folder.
  await refreshFolderChats(null);
  assert.deepEqual(c.closed.sort(), ["new-one", "new-two", "new-two"]);
});
