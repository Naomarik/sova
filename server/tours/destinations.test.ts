import assert from "node:assert/strict";
import { test } from "node:test";
import dns from "node:dns/promises";
import { tourEditionFixture } from "../../shared/tour-fixtures";
import { ownerTourDestinations } from "./destinations";
import { publicTour } from "./public-view";

test("owner Open requires exact approval and public literal or child-attested named origin, with no view network", () => {
  const e = tourEditionFixture(); e.source = { kind: "site", origin: "https://example.com" };
  const step = e.manifest.steps[0]!, view = step.views[0]!; view.route = "/drafts";
  const oldLookup = dns.lookup, oldFetch = globalThis.fetch; let network = 0;
  dns.lookup = (() => { network++; throw new Error("Viewing must never look up a name."); }) as typeof dns.lookup;
  globalThis.fetch = (() => { network++; throw new Error("Viewing must never contact the app."); }) as typeof fetch;
  try {
    assert.deepEqual(ownerTourDestinations(e, () => true), {}, "a public-looking name is not an attestation");
    e.provenance.publicOrigins = ["https://example.com"];
    assert.equal(ownerTourDestinations(e, () => true)[step.id]?.[view.id]?.phone, "https://example.com/drafts");
    e.provenance.publicOrigins = ["https://other.example.com"];
    assert.deepEqual(ownerTourDestinations(e, () => true), {}, "another exact origin never authorizes this source");
    e.provenance.publicOrigins = ["https://example.com"];
    assert.deepEqual(ownerTourDestinations(e, () => false), {}, "revoked origin consent still hides the link");
    e.source = { kind: "site", origin: "https://1.1.1.1" };
    assert.equal(ownerTourDestinations(e, () => true)[step.id]?.[view.id]?.desktop, "https://1.1.1.1/drafts", "literal public IP needs no named-origin receipt");
    for (const origin of ["http://127.0.0.1:4810", "http://localhost:4810", "http://10.0.0.1", "http://100.64.0.1", "http://[::1]", "http://[::ffff:127.0.0.1]", "https://app.local", "https://app.internal", "http://intranet"]) { e.source = { kind: "site", origin }; e.provenance.publicOrigins = [origin]; assert.deepEqual(ownerTourDestinations(e, () => true), {}, origin); }
    e.source = { kind: "project", projectId: "demo", instanceId: "demo", checkout: "/projects/demo", serviceId: "web", endpoint: "http" }; assert.deepEqual(ownerTourDestinations(e, () => true), {});
    e.source = { kind: "site", origin: "https://example.com" }; e.provenance.publicOrigins = [e.source.origin]; view.route = "/drafts?token=private"; assert.deepEqual(ownerTourDestinations(e, () => true), {});
    for (const route of ["/drafts#access_token=private", "/drafts#id_token=private", "/drafts#session=private", "/drafts#access_token%3Dprivate", "/drafts#opaque-credential", "/drafts#overview"]) { view.route = route; assert.deepEqual(ownerTourDestinations(e, () => true), {}, "fragments are hidden conservatively, not classified as safe anchors"); }
    const p = publicTour(e.manifest, { id: "opaque-tour", editionId: "opaque-edition" });
    assert.equal(p.steps[0]!.views[0]!.route, null); assert.equal(JSON.stringify(p).includes("example.com"), false);
    assert.equal(network, 0, "neither DNS nor HTTP runs when evaluating view-only links");
  } finally { dns.lookup = oldLookup; globalThis.fetch = oldFetch; }
});
