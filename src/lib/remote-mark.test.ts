// Run: npx tsx --test src/lib/remote-mark.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { groupRemotePlaceOf, remoteMarkOf, remoteMarkSuffix, remoteMarkTitle } from "./remote-mark";

const T = "/home/u/.pi/agent/pi-web/targets"; // legacy pre-rebrand placeholder root
const TS = "/home/u/.pi/agent/sova/targets"; // current root

const local = { cwd: "/home/u/webapps/pi-web" };
const remote = { cwd: "/home/u/webapps/pi-web", target: "box", remoteCwd: "/srv/site" };
const remote2 = { cwd: `${T}/box/srv/site` };
const remoteNewRoot = { cwd: `${TS}/box/srv/site` };

test("a remote row among local rows carries the mark; the local rows carry none", () => {
  const rows = [local, remote, local];
  assert.deepEqual(remoteMarkOf(rows[1]!), { place: { target: "box", remoteCwd: "/srv/site" } });
  assert.equal(remoteMarkOf(rows[0]!), null);
  assert.equal(remoteMarkOf(rows[2]!), null);
});

test("a local row among remote rows carries no mark, wherever it sits in the group", () => {
  assert.equal(remoteMarkOf(local), null);
  // The placeholder cwd alone marks a row remote, the way the old label logic did — but per row.
  assert.deepEqual(remoteMarkOf(remote2)?.place, { target: "box", remoteCwd: "/srv/site" });
  // The current state-root spelling marks it exactly the same way.
  assert.deepEqual(remoteMarkOf(remoteNewRoot)?.place, { target: "box", remoteCwd: "/srv/site" });
});

test("a uniformly remote group speaks as one place, however its rows say it", () => {
  assert.deepEqual(groupRemotePlaceOf([remote, remote2], remote.cwd), { target: "box", remoteCwd: "/srv/site" });
  assert.equal(groupRemotePlaceOf([local, local], local.cwd), null);
});

test("a mixed group's label claims nothing, whichever way it is mixed", () => {
  assert.equal(groupRemotePlaceOf([remote, local], remote.cwd), null); // the old bug: first row decided
  assert.equal(groupRemotePlaceOf([local, remote], local.cwd), null);
  assert.equal(groupRemotePlaceOf([remote, { cwd: remote.cwd, target: "other", remoteCwd: "/srv/site" }], remote.cwd), null);
  // One target but two folders is not one place either.
  assert.equal(groupRemotePlaceOf([remote, { cwd: remote.cwd, target: "box", remoteCwd: "/elsewhere" }], remote.cwd), null);
});

test("an empty group falls back to its cwd alone", () => {
  assert.deepEqual(groupRemotePlaceOf([], `${T}/box/x`), { target: "box", remoteCwd: "/x" });
  assert.equal(groupRemotePlaceOf([], "/home/u/w"), null);
});

test("the title names the target and folder", () => {
  const r = remoteMarkOf(remote)!;
  assert.equal(remoteMarkTitle(r, "user@host:2222"), "Remote: box (user@host:2222):/srv/site.");
  assert.equal(remoteMarkTitle(r), "Remote: box:/srv/site.");
});

test("the row link's hidden suffix is one short clause", () => {
  assert.equal(remoteMarkSuffix(remoteMarkOf(remote)!), ", remote on box");
});
