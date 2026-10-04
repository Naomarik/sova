// Run: pnpm test -- src/lib/mesh-lan.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { type LanPairingStatus, pairingProblem, pairingState, parseFingerprint, relayLine, relayProblem, roleWord } from "./mesh-lan";

const FP = "ABCD-EF01-2345-6789-ABCD-EF01-2345-6789";
const row = (role: "dial" | "accept", answer: LanPairingStatus["channels"]["answer"], ask: LanPairingStatus["channels"]["ask"]): LanPairingStatus => ({
  id: "x",
  label: "X",
  role,
  fingerprint: FP,
  channels: { answer, ask },
});

test("a pairing is connected only when both channels are", () => {
  const up = { state: "connected", since: 1 } as const;
  assert.deepEqual(pairingState(row("dial", up, up), 0), { tone: "success", word: "Connected" });
  assert.equal(pairingState(row("dial", up, { state: "connecting" }), 0).word, "Connecting");
  assert.equal(pairingState(row("accept", up, { state: "not connected" }), 0).word, "Half connected");
});

test("waiting says why, and when it tries again, in whole seconds", () => {
  const s = pairingState(row("dial", { state: "waiting", reason: "relay's pin didn't match", retryAt: 8_400 }, { state: "connecting" }), 1_000);
  assert.equal(s.tone, "warn");
  assert.equal(s.detail, "Relay's pin didn't match. Next try in 7 s.");
});

test("an accepted pairing that never dialed in is said calmly", () => {
  const idle = { state: "not connected" } as const;
  assert.deepEqual(pairingState(row("accept", idle, idle), 0), { tone: "neutral", word: "Not connected", detail: "It hasn't dialed in yet." });
  assert.equal(roleWord({ role: "accept" }), "Dial-out host");
  assert.equal(roleWord({ role: "dial" }), "Relay");
});

test("fingerprints parse with any case, dashes or spaces, and nothing else", () => {
  assert.equal(parseFingerprint(FP.toLowerCase()), FP.replace(/-/g, ""));
  assert.equal(parseFingerprint(FP.replace(/-/g, " ")), FP.replace(/-/g, ""));
  for (const bad of ["", "ABCD", `${FP}0`, FP.replace("A", "G")]) assert.equal(parseFingerprint(bad), null, bad);
});

test("the pairing form names the first thing missing", () => {
  const d = { role: "dial" as const, fingerprint: FP, id: "relay", label: "", host: "relay.example", port: "4803" };
  assert.equal(pairingProblem(d, []), null);
  assert.match(pairingProblem({ ...d, fingerprint: "nope" }, [])!, /fingerprint/);
  assert.match(pairingProblem(d, [], FP.toLowerCase())!, /own fingerprint/);
  assert.match(pairingProblem({ ...d, id: "Relay!" }, [])!, /lowercase/);
  assert.match(pairingProblem(d, ["relay"])!, /already in the list/);
  assert.match(pairingProblem({ ...d, host: " " }, [])!, /address/);
  assert.match(pairingProblem({ ...d, port: "70000" }, [])!, /port/);
  assert.equal(pairingProblem({ ...d, role: "accept", host: "", port: "" }, []), null, "a dial-out host needs no address");
});

test("the relay form wants one local-network IP of this host and a port, as the server does", () => {
  assert.equal(relayProblem("10.0.0.10", "4803"), null);
  assert.equal(relayProblem("fd00::1", "4803"), null);
  assert.equal(relayProblem("fe80::1%eth0", "4803"), null);
  for (const every of ["0.0.0.0", "::", "0::", "0::0", "::ffff:0.0.0.0", "::0.0.0.0"]) assert.match(relayProblem(every, "4803")!, /not every/, every);
  for (const pub of ["192.0.2.10", "2001:db8::1", "100.64.0.1", "::ffff:198.51.100.1"]) assert.match(relayProblem(pub, "4803")!, /internet isn't available/, pub);
  assert.match(relayProblem("relay.example", "4803")!, /IP address/);
  assert.match(relayProblem("10.0.0.10", "0")!, /port/);
});

test("the pairing form refuses a relay at a public IP; a name is the dialer's to judge", () => {
  const d = { role: "dial" as const, fingerprint: FP, id: "relay", label: "", host: "192.0.2.5", port: "4803" };
  assert.match(pairingProblem(d, [])!, /local-network address/);
  assert.equal(pairingProblem({ ...d, host: "10.0.0.5" }, []), null);
  assert.equal(pairingProblem({ ...d, host: "relay.example" }, []), null);
});

test("the relay line says where it listens, and for how many", () => {
  const relay = { host: "192.0.2.10", port: 4803, exposure: "lan" as const, listening: true, boundPort: 4803 };
  const accept = row("accept", { state: "not connected" }, { state: "not connected" });
  assert.equal(relayLine({ pairings: [] }), "This host isn't a relay.");
  assert.equal(relayLine({ relay, pairings: [accept] }), "Listening on 192.0.2.10:4803 for 1 dial-out host.");
  assert.equal(relayLine({ relay: { ...relay, listening: false }, pairings: [] }), "Set to 192.0.2.10:4803. It listens only while a dial-out host is paired.");
  assert.equal(relayLine({ relay: { ...relay, host: "2001:db8::1" }, pairings: [accept, accept] }), "Listening on [2001:db8::1]:4803 for 2 dial-out hosts.");
});
