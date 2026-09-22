// Run: npx tsx --test server/path-map.test.ts (or npm test)
// The repo-rename bridge: a session whose stored cwd names the pre-rename project root still opens
// (the map points at where the directory went), and misuse of the map can't swallow state roots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-path-map-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths

const { movedPath } = await import("./path-map");
const { stateRoot } = await import("./state-root");

const write = (body: unknown) => {
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(join(stateRoot(), "path-map.json"), JSON.stringify(body));
};

after(() => rmSync(agentDir, { recursive: true, force: true }));

test("no file is an empty map, never a failure", () => {
  assert.equal(movedPath("/home/u/webapps/pi-web"), "/home/u/webapps/pi-web");
});

test("an exact root and its children map; a prefix lookalike does not", () => {
  write({ version: 1, moved: [{ from: "/home/u/webapps/pi-web", to: "/home/u/webapps/sova" }] });
  assert.equal(movedPath("/home/u/webapps/pi-web"), "/home/u/webapps/sova");
  assert.equal(movedPath("/home/u/webapps/pi-web/src/lib"), "/home/u/webapps/sova/src/lib");
  assert.equal(movedPath("/home/u/webapps/pi-web-fanout"), "/home/u/webapps/pi-web-fanout", "shares a prefix, not a child");
  assert.equal(movedPath("/elsewhere"), "/elsewhere");
});

test("malformed files and entries degrade to no mapping", () => {
  write("not json");
  assert.equal(movedPath("/home/u/webapps/pi-web"), "/home/u/webapps/pi-web");
  write({ version: 1, moved: [{ from: "relative/path", to: "/abs" }, { to: "/x" }, 42] });
  assert.equal(movedPath("/home/u/webapps/pi-web"), "/home/u/webapps/pi-web");
  write({ version: 1, moved: [{ from: "/home/u/webapps/pi-web/", to: "/home/u/webapps/sova/" }] });
  assert.equal(movedPath("/home/u/webapps/pi-web"), "/home/u/webapps/sova", "trailing slashes tolerated");
});

test("state-root entries are refused: the rename's own bridge owns those, never double-mapped", () => {
  write({
    version: 1,
    moved: [
      { from: join(agentDir, "pi-web"), to: join(agentDir, "sova") },
      { from: "/home/u/webapps/pi-web", to: "/home/u/webapps/sova" },
    ],
  });
  assert.equal(movedPath(join(agentDir, "pi-web", "targets", "box")), join(agentDir, "pi-web", "targets", "box"), "untouched here");
  assert.equal(movedPath("/home/u/webapps/pi-web"), "/home/u/webapps/sova", "other entries still work");
});

test("longest from wins when entries nest", () => {
  write({
    version: 1,
    moved: [
      { from: "/w", to: "/w2" },
      { from: "/w/apps/pi-web", to: "/w/apps/sova" },
    ],
  });
  assert.equal(movedPath("/w/apps/pi-web/src"), "/w/apps/sova/src");
});
