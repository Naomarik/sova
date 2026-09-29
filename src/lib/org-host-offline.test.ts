import assert from "node:assert/strict";
import { test } from "node:test";
import type { PeerStatus } from "../../shared/protocol";
import { orgHostOffline } from "./org-host-offline";

const peer = (id: string, state: PeerStatus["state"], label = ""): PeerStatus => ({ id, label, nodeId: `n-${id}`, name: id, url: "", state, lastSeen: null });

test("a local org never warns", () => {
  assert.equal(orgHostOffline(null, [peer("laptop", "down")]), null);
});

test("an org on a down peer names the peer by its label, else its id", () => {
  assert.equal(orgHostOffline("laptop", [peer("laptop", "down", "Laptop")]), "Laptop is offline, so its links can't be opened.");
  assert.equal(orgHostOffline("laptop", [peer("laptop", "down")]), "laptop is offline, so its links can't be opened.");
});

test("up, skewed, refused or unknown peers don't warn", () => {
  for (const s of ["up", "skewed", "refused"] as const) assert.equal(orgHostOffline("laptop", [peer("laptop", s)]), null);
  assert.equal(orgHostOffline("gone", [peer("laptop", "down")]), null);
});
