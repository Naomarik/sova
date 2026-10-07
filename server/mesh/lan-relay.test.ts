// Run: pnpm test -- server/mesh/lan-relay.test.ts
// The relay listener's rules that need no socket (§mesh.lan/relay-listener): the addresses it binds,
// and its handshake deadline. Over real TLS: lan-relay.integration.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mintLanIdentity } from "./lan-cert";
import { LAN_PROFILE } from "./lan-admission";
import { RelayListener } from "./lan-relay";
import { HANDSHAKE_MS, relayServerOptions } from "./lan-tls";

const relayId = mintLanIdentity();

test("never on every interface or a public address; an internet relay takes one public address", () => {
  // The backstop behind the relay setting's own check (peers.ts): any spelling of every interface,
  // a public address or a name throws before anything binds.
  for (const host of ["0.0.0.0", "::", "", "0::", "0::0", "0000::", "::0.0.0.0", "::ffff:0.0.0.0", "[::]"]) {
    assert.throws(() => new RelayListener({ host, port: 0, identity: relayId, profile: LAN_PROFILE, onPeer: () => {} }), /one local-network address/, host);
  }
  for (const host of ["192.0.2.10", "2001:db8::1", "100.64.0.1", "relay.example"]) {
    assert.throws(() => new RelayListener({ host, port: 0, identity: relayId, profile: LAN_PROFILE, onPeer: () => {} }), /one local-network address/, host);
  }
  // The internet scope (the accept process's alone) takes one public address, never every interface
  // or a group address; the default scope above never takes a public one.
  for (const host of ["192.0.2.10", "2001:db8::1", "198.51.100.7"]) {
    assert.doesNotThrow(() => new RelayListener({ scope: "internet", host, port: 0, identity: relayId, profile: LAN_PROFILE, onPeer: () => {} }), host);
  }
  for (const host of ["0.0.0.0", "::", "::ffff:0.0.0.0", "224.0.0.1", "255.255.255.255", "ff02::1", "relay.example"]) {
    assert.throws(() => new RelayListener({ scope: "internet", host, port: 0, identity: relayId, profile: LAN_PROFILE, onPeer: () => {} }), /an internet relay binds one address/, host);
  }
});

test("a handshake not done in 5 s is closed: the relay's TLS server is built with that deadline", () => {
  assert.equal(HANDSHAKE_MS, 5_000);
  assert.equal(relayServerOptions(relayId).handshakeTimeout, 5_000);
  assert.equal(relayServerOptions(relayId, 300).handshakeTimeout, 300, "tests shorten it");
});
