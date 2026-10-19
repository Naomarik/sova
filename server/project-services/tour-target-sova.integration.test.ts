import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { resolveTourTarget, TourTargetRefused } from "./tour-target";
import type { InstanceRecord, Registry } from "./store";

// A site URL on a live Sova port, against a real listener standing in for it: refused at resolution,
// before any contact (the listener counts every request it gets).
const refused = (pattern: RegExp) => (error: unknown) => error instanceof TourTargetRefused && pattern.test(error.message);
const TEST_COPY = /^Tours of Sova use a test copy; start one for this branch\.$/;

test("a site URL on a live Sova port is refused before any contact; an unrelated port proceeds", async () => {
  let requests = 0;
  const server = createServer((_q, r) => { requests++; r.end("live"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const site = { kind: "site" as const, origin: `http://127.0.0.1:${port}` };
  const none: Registry = { version: 1, instances: [], shared: [] };
  const slot0: InstanceRecord = { id: "live", project: "/p", checkout: "/p", branch: null, slot: 0, generation: 1, createdBy: "operator", createdAt: "2026-01-02T03:04:05.000Z", cutWorktree: false, desired: { server: "running" }, prints: {}, data: {}, ports: { server: { http: port } } };
  try {
    // This server's own listeners (main, share, peer, ingress): refused with the test-copy copy.
    await assert.rejects(resolveTourTarget(site, { registry: () => none, sovaPorts: async () => new Set([port]) }), refused(TEST_COPY));
    // Any registered copy's port, slot 0's adopted port included: refused.
    await assert.rejects(resolveTourTarget(site, { registry: () => ({ ...none, instances: [slot0] }), sovaPorts: async () => new Set() }), refused(/managed running copy/));
    // The unspecified addresses reach local listeners on Linux: the same refusals, before contact.
    for (const host of ["0.0.0.0", "[::]", "0.1.2.3", "[::ffff:0:0]"]) {
      const any = { kind: "site" as const, origin: `http://${host}:${port}` };
      assert.equal(new URL(any.origin).origin, any.origin, `${host} is a canonical origin`);
      await assert.rejects(resolveTourTarget(any, { registry: () => none, sovaPorts: async () => new Set([port]) }), refused(TEST_COPY), host);
      await assert.rejects(resolveTourTarget(any, { registry: () => ({ ...none, instances: [slot0] }), sovaPorts: async () => new Set() }), refused(/managed running copy/), host);
      // Control: the same host on an unrelated port resolves, so the refusal above is the port's.
      assert.equal((await resolveTourTarget({ kind: "site", origin: `http://${host}:${port + 1}` }, { registry: () => none, sovaPorts: async () => new Set([port]) })).origin, `http://${host}:${port + 1}`, host);
    }
    // Abbreviated forms canonicalize (http://0 is 0.0.0.0), so as written they are no tour origin:
    // refused before contact too.
    for (const origin of [`http://0:${port}`, `http://0x0:${port}`, `http://127.1:${port}`]) await assert.rejects(resolveTourTarget({ kind: "site", origin }, { registry: () => none, sovaPorts: async () => new Set([port]) }), refused(/./), origin);
    assert.equal(requests, 0, "nothing contacted the live port");
    // Control: an unrelated loopback port resolves (consent is asked elsewhere), and a public-looking
    // origin is not touched by the live-port rule.
    assert.equal((await resolveTourTarget(site, { registry: () => none, sovaPorts: async () => new Set([port + 1]) })).origin, site.origin);
    assert.equal((await resolveTourTarget({ kind: "site", origin: `http://203.0.113.7:${port}` }, { registry: () => none, sovaPorts: async () => new Set([port]) })).origin, `http://203.0.113.7:${port}`);
    assert.equal(requests, 0, "resolution never contacts a site");
  } finally { server.close(); }
});
