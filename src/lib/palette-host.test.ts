// Run: pnpm test -- src/lib/palette-host.test.ts
// A palette command that names the open session by id goes to the host holding that session
// (§app.command-palette/command-panel), as the rest of the page sends a peer's session's requests;
// one that names it by path is routed by its path; none goes anywhere but as its request says.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findCommand } from "../../shared/commands-catalog";
import { commandHost } from "./palette";
import { hostUrl } from "./mesh";

const peerSession = { path: "/sessions/--w--/2026-10-18T00-00-00-000Z_s9.jsonl", id: "s9", title: "On the laptop", terminal: false };
const hosts = new Map([[peerSession.path, "laptop"]]);
const hostOf = (p: string) => hosts.get(p) ?? null;

test("Show Session and Set Session Tags on a peer's session go to that peer", () => {
  for (const id of ["session.get", "session.tags.set"]) {
    const entry = findCommand(id)!;
    assert.equal(entry.sessionKey, "id");
    assert.equal(commandHost(entry, peerSession, hostOf), "laptop", id);
  }
  assert.equal(hostUrl(commandHost(findCommand("session.get")!, peerSession, hostOf), "/api/sessions/summary?id=s9"), "/peer/laptop/api/sessions/summary?id=s9");
});

test("this host's session, a path-named command and no session: as the request says", () => {
  const local = { ...peerSession, path: "/sessions/--w--/local_s1.jsonl", id: "s1" };
  assert.equal(commandHost(findCommand("session.get")!, local, hostOf), null);
  assert.equal(commandHost(findCommand("session.read")!, peerSession, hostOf), null, "routed by its path already");
  assert.equal(commandHost(findCommand("models.list")!, peerSession, hostOf), null);
  assert.equal(commandHost(findCommand("session.get")!, null, hostOf), null);
});
