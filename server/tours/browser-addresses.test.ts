import assert from "node:assert/strict";
import { test } from "node:test";
import { TourBrowserAddresses, TOUR_PRIVATE_NAME_FAILURE, isPublicRecordingAddress } from "./browser-addresses";
import { TourCaptureFailure } from "./targets";

// Any globally routable address works here; this is a well-known public resolver address, not a
// user's or machine's address. It is NEVER contacted: every lookup below is an injected resolver.
const PUBLIC = "1.1.1.1";
const privateName = (error: unknown) => error instanceof TourCaptureFailure && error.message === TOUR_PRIVATE_NAME_FAILURE;
test("named origins cannot use private DNS, mixed answers, or mapped IPv6", async () => {
  for (const address of ["127.0.0.1", "127.1.2.3", "10.2.3.4", "172.31.2.3", "192.168.2.3", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fd00::1"]) {
    assert.equal(isPublicRecordingAddress(address), false, address);
    const addresses = new TourBrowserAddresses(async () => [{ address: PUBLIC }, { address }]);
    await assert.rejects(addresses.beforeContact("http://approved.example:4870"), privateName);
    assert.deepEqual(addresses.attestations(), []);
  }
});
test("public preflight is child-only, exact-origin, bounded, and independent of managed service ports", async () => {
  const calls: string[] = [];
  const addresses = new TourBrowserAddresses(async host => { calls.push(host); return [{ address: PUBLIC }]; });
  await Promise.all([addresses.beforeContact("https://public.example:4870"), addresses.beforeContact("https://public.example:4870")]);
  await addresses.beforeContact("https://public.example:4871");
  assert.deepEqual(calls, ["public.example", "public.example"]);
  assert.deepEqual(addresses.attestations(), ["https://public.example:4870", "https://public.example:4871"]);
  addresses.response("https://public.example:4870", undefined); // unavailable peer uses preflight
  addresses.response("https://public.example:4870", PUBLIC);
  assert.throws(() => addresses.response("https://public.example:4870", "127.0.0.1"), privateName);
});
test("literal local and exact localhost remain policy-controlled and never receive public attestation", async () => {
  const addresses = new TourBrowserAddresses(async () => { throw new Error("literal destinations never need DNS"); });
  for (const origin of ["http://127.0.0.1:4870", "http://[::1]:4870", "http://localhost:4870", "http://192.168.0.1"]) {
    await addresses.beforeContact(origin);
    addresses.response(origin, "127.0.0.1");
  }
  await addresses.beforeContact("https://203.0.113.42"); // documentation range: literal, but never attested public
  await addresses.beforeContact(`https://${PUBLIC}`);
  assert.deepEqual(addresses.attestations(), [`https://${PUBLIC}`]);
});
test("lookup failure and empty DNS fail closed; localhost aliases are named, not a local exception", async () => {
  const failed = new TourBrowserAddresses(async () => { throw new Error("confined DNS denied"); });
  await assert.rejects(failed.beforeContact("https://public.example"), /could not be resolved safely/);
  const empty = new TourBrowserAddresses(async () => []);
  await assert.rejects(empty.beforeContact("https://public.example"), privateName);
  const alias = new TourBrowserAddresses(async () => [{ address: "127.0.0.1" }]);
  await assert.rejects(alias.beforeContact("http://copy.localhost:4870"), privateName);
  assert.deepEqual(failed.attestations(), []);
});
test("public attestation excludes nonroutable literals", () => {
  for (const address of ["0.0.0.0", "224.0.0.1", "255.255.255.255", "203.0.113.1", "::", "2001:db8::1", "ff00::1", "not-an-ip"]) assert.equal(isPublicRecordingAddress(address), false, address);
  assert.equal(isPublicRecordingAddress(PUBLIC), true, "the production classifier recognizes a globally routable address");
});
test("proxy mode (sandbox on): the child never resolves, never reads the relay as the peer, and attests nothing", async () => {
  const calls: string[] = [];
  const proxied = new TourBrowserAddresses(async host => { calls.push(host); return [{ address: "127.0.0.1" }]; }, true);
  await proxied.beforeContact("https://public.example");
  await proxied.beforeContact("https://1.1.1.1");
  // Through the proxy every peer is the 127.0.0.1 relay; the proxy itself refuses non-public answers.
  proxied.response("https://public.example", "127.0.0.1");
  assert.equal(calls.length, 0, "no lookup inside the network-less child");
  assert.deepEqual(proxied.attestations(), [], "no public attestation, so no Open This Page");
  // Positive control: the same calls without proxy mode resolve, refuse the relay as a peer, and attest.
  const direct = new TourBrowserAddresses(async host => { calls.push(host); return [{ address: PUBLIC }]; });
  await direct.beforeContact("https://public.example");
  assert.deepEqual(calls, ["public.example"]);
  assert.throws(() => direct.response("https://public.example", "127.0.0.1"), privateName);
  assert.deepEqual(direct.attestations(), ["https://public.example"]);
});
