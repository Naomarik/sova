// Run: npx tsx --test src/lib/remote-session.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { cwdLabel, localOnly, splitRemoteCwd, remoteCrumbs, remoteParent, remotePlaceOf, remoteRecents } from "./remote-session";

const T = "/home/u/.pi/agent/sova/targets"; // the placeholder root

test("splitRemoteCwd reads the target and the mirrored remote folder", () => {
  for (const root of [T]) {
    assert.deepEqual(splitRemoteCwd(`${root}/acme-prod/home/deploy/site`), { target: "acme-prod", remoteCwd: "/home/deploy/site" });
    assert.deepEqual(splitRemoteCwd(`${root}/box`), { target: "box", remoteCwd: "/" });
    assert.deepEqual(splitRemoteCwd(`${root}/box/`), { target: "box", remoteCwd: "/" });
    assert.equal(splitRemoteCwd(`${root}/`), null);
  }
  assert.equal(splitRemoteCwd("/home/u/webapps/sova"), null);
});

test("remotePlaceOf prefers the summary's own fields", () => {
  assert.deepEqual(remotePlaceOf({ cwd: `${T}/a/x`, target: "b", remoteCwd: "/y" }), { target: "b", remoteCwd: "/y" });
  assert.deepEqual(remotePlaceOf({ cwd: `${T}/a/x` }), { target: "a", remoteCwd: "/x" });
  assert.equal(remotePlaceOf({ cwd: "/w" }), null);
});

test("remoteRecents keeps order, dedupes, filters by target; localOnly drops them", () => {
  const cwds = [`${T}/a/x`, "/w", `${T}/b/y`, `${T}/a/x/`, `${T}/a/z`];
  assert.deepEqual(
    remoteRecents(cwds).map((p) => `${p.target}:${p.remoteCwd}`),
    ["a:/x", "b:/y", "a:/z"],
  );
  assert.deepEqual(remoteRecents(cwds, "a").map((p) => p.remoteCwd), ["/x", "/z"]);
  assert.deepEqual(localOnly(cwds), ["/w"]);
});

test("remoteParent and remoteCrumbs are pure path work from /", () => {
  assert.equal(remoteParent("/"), null);
  assert.equal(remoteParent("/home"), "/");
  assert.equal(remoteParent("/home/deploy/"), "/home");
  assert.deepEqual(remoteCrumbs("/home/deploy"), [
    { label: "/", path: "/" },
    { label: "home", path: "/home" },
    { label: "deploy", path: "/home/deploy" },
  ]);
  assert.deepEqual(remoteCrumbs("/"), [{ label: "/", path: "/" }]);
});

test("cwdLabel shows a remote folder as target:path, never with ~", () => {
  assert.equal(cwdLabel({ cwd: `${T}/box/home/u/x` }, "/home/u"), "box:/home/u/x");
  assert.equal(cwdLabel({ cwd: "/home/u/w" }, "/home/u"), "~/w");
});
