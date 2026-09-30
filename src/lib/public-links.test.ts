import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicLinksFile, PublicLinksInfo, ShareState } from "../../shared/public-links";
import {
  draftIssue,
  meshChipText,
  parsePort,
  publicLinksChanges,
  publicLinksDraftOf,
  setPublicLinksDraft,
  setPublicLinksSaved,
  sourceLabel,
  stateChip,
  urlIssue,
} from "./public-links";
import { dirtyForms, invalidForms, resetAllDrafts, saveAllDrafts } from "./settings-draft";

const off: PublicLinksFile = { version: 1, route: "off" };
const gw: PublicLinksFile = {
  version: 1,
  route: "self",
  gateway: { publicUrl: "https://share.example.com", front: "caddy", sharePort: 4802, acceptFrom: ["n1"] },
};
const share = (s: Partial<ShareState>): ShareState => ({ state: "off", source: "bound", publicUrl: null, ...s });

test("a public address: https only, a host with no path; a trailing slash is dropped", () => {
  assert.equal(urlIssue("https://share.example.com"), null);
  assert.equal(urlIssue(" https://share.example.com/ "), null);
  assert.equal(urlIssue("http://share.example.com"), "The public address must start with https://.");
  assert.equal(urlIssue("share.example.com"), "The public address must start with https://.");
  assert.equal(urlIssue(""), "Enter the public address.");
  assert.equal(urlIssue("https://share.example.com/x"), "The public address is a host only, with no path.");
});

test("a local port is a whole number 1–65535", () => {
  assert.equal(parsePort("4802"), 4802);
  for (const bad of ["", "0", "65536", "48.2", "-1", "abc"]) assert.equal(parsePort(bad), null, bad);
});

test("only the gateway route has fields to check; a pinned field is never checked", () => {
  const d = publicLinksDraftOf(gw);
  assert.equal(draftIssue({ ...d, route: "off", publicUrl: "nope" }), null);
  assert.equal(draftIssue({ ...d, publicUrl: "http://x" })?.field, "publicUrl");
  assert.equal(draftIssue({ ...d, publicUrl: "http://x" }, ["SOVA_SHARE_PUBLIC_URL"]), null);
  assert.equal(draftIssue({ ...d, sharePort: "0" })?.field, "sharePort");
  assert.equal(draftIssue({ ...d, sharePort: "0" }, ["SOVA_SHARE_PORT"]), null);
});

test("a save sends only what changed; the gateway setting goes whole, acceptFrom as stored", () => {
  assert.deepEqual(publicLinksChanges(publicLinksDraftOf(gw), gw), {});
  assert.deepEqual(publicLinksChanges({ ...publicLinksDraftOf(gw), route: "off" }, gw), { route: "off" });
  assert.deepEqual(publicLinksChanges({ ...publicLinksDraftOf(gw), publicUrl: "https://s2.example.com/" }, gw), {
    gateway: { publicUrl: "https://s2.example.com", front: "caddy", sharePort: 4802, acceptFrom: ["n1"] },
  });
  assert.deepEqual(publicLinksChanges({ ...publicLinksDraftOf(off), route: "self", publicUrl: "https://share.example.com" }, off), {
    route: "self",
    gateway: { publicUrl: "https://share.example.com", front: "vhost", sharePort: 4802, acceptFrom: "all" },
  });
});

test("Save Changes lists the form, and an invalid address holds it and is named", async () => {
  setPublicLinksSaved(off);
  setPublicLinksDraft({ ...publicLinksDraftOf(off), route: "self", publicUrl: "http://share.example.com" });
  assert.deepEqual(dirtyForms().map((f) => f.label), ["Public links"]);
  assert.equal(invalidForms()[0]?.problem(), "Public links: The public address must start with https://.");
  assert.deepEqual(await saveAllDrafts(), { saved: [], failed: [] });
  resetAllDrafts();
  assert.deepEqual(dirtyForms(), []);
});

test("the words: state chip, source, Mesh card chip", () => {
  assert.deepEqual(stateChip(share({ state: "off" })), { word: "Off" });
  assert.deepEqual(stateChip(share({ state: "configured" })), { word: "Not verified", tone: "warn" });
  assert.deepEqual(stateChip(share({ state: "verified" })), { word: "Verified", tone: "success" });
  assert.deepEqual(stateChip(share({ state: "unreachable" })), { word: "Unreachable", tone: "error" });
  const down = { host: "127.0.0.1", port: 4802, reason: "Another program is already using 127.0.0.1:4802." };
  for (const state of ["off", "configured", "verified", "unreachable"] as const)
    assert.deepEqual(stateChip(share({ state, listener: down })), { word: "Not listening", tone: "error" }, `a share port that won't open wins over ${state}`);
  assert.equal(sourceLabel(share({ source: "env" }), ["SOVA_SHARE_PUBLIC_URL"]), "Set by environment (SOVA_SHARE_PUBLIC_URL)");
  assert.equal(sourceLabel(share({ source: "setting" }), []), "From this setting");
  assert.equal(sourceLabel(share({ source: "gateway", via: "vps" }), []), "From vps");
  assert.equal(sourceLabel(share({ source: "bound" }), []), "Bound address");
  const info = (file: PublicLinksFile, s: Partial<ShareState> = {}): PublicLinksInfo => ({ file, share: share(s), pinnedByEnv: [] });
  assert.equal(meshChipText(null), null);
  assert.equal(meshChipText(info(off)), null);
  assert.equal(meshChipText(info(gw)), "Public links: gateway");
  assert.equal(meshChipText(info({ version: 1, route: { via: { nodeId: "n9" } } }, { via: "vps" })), "Public links: through vps");
});

test("routed half: a via route needs a gateway and a valid ingress port; its patch names the node", () => {
  const d = { ...publicLinksDraftOf(off), route: "via" as const };
  assert.equal(draftIssue(d)?.field, "via");
  assert.equal(draftIssue({ ...d, viaNodeId: "n9", ingressPort: "0" })?.field, "ingressPort");
  assert.equal(draftIssue({ ...d, viaNodeId: "n9" }), null);
  assert.deepEqual(publicLinksChanges({ ...d, viaNodeId: "n9" }, off), { route: { via: { nodeId: "n9" } } });
  assert.deepEqual(publicLinksChanges({ ...d, viaNodeId: "n9", ingressPort: "4900" }, off), { route: { via: { nodeId: "n9" } }, ingressPort: 4900 });
  const via: PublicLinksFile = { version: 1, route: { via: { nodeId: "n9" } } };
  assert.deepEqual(publicLinksChanges({ ...publicLinksDraftOf(via), viaNodeId: "n8" }, via), { route: { via: { nodeId: "n8" } } });
  assert.deepEqual(publicLinksChanges(publicLinksDraftOf(via), via), {});
});

test("the accept list: order doesn't count as a change; all ↔ a list does", () => {
  const two: PublicLinksFile = { ...gw, gateway: { ...gw.gateway!, acceptFrom: ["a", "b"] } };
  assert.deepEqual(publicLinksChanges({ ...publicLinksDraftOf(two), acceptFrom: ["b", "a"] }, two), {});
  assert.deepEqual(publicLinksChanges({ ...publicLinksDraftOf(two), acceptFrom: "all" }, two), { gateway: { ...two.gateway!, acceptFrom: "all" } });
  assert.deepEqual(publicLinksChanges({ ...publicLinksDraftOf(two), acceptFrom: ["a"] }, two), { gateway: { ...two.gateway!, acceptFrom: ["a"] } });
});
