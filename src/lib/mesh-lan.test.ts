// Run: pnpm test -- src/lib/mesh-lan.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { acceptorLine, acceptorReason, type LanPairingStatus, pairingProblem, pairingState, parseFingerprint, portWarning, relayLine, relayProblem, roleWord } from "./mesh-lan";

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
  const d = { role: "dial" as const, fingerprint: FP, id: "relay", label: "", host: "relay.example", port: "4803", internet: false };
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
  for (const pub of ["192.0.2.10", "2001:db8::1", "100.64.0.1", "::ffff:198.51.100.1"]) assert.match(relayProblem(pub, "4803")!, /local-network address.*or choose “The internet”/, pub);
  assert.match(relayProblem("relay.example", "4803")!, /IP address/);
  assert.match(relayProblem("10.0.0.10", "0")!, /port/);
});

test("the relay form's internet choice: any one unicast IP, and only while the accept process runs", () => {
  for (const host of ["192.0.2.10", "2001:db8::1", "10.0.0.10", "::ffff:198.51.100.1"]) assert.equal(relayProblem(host, "4803", "internet", "running"), null, host);
  for (const every of ["0.0.0.0", "::", "::ffff:0.0.0.0"]) assert.match(relayProblem(every, "4803", "internet", "running")!, /not every/, every);
  for (const group of ["224.0.0.1", "255.255.255.255", "ff02::1"]) assert.match(relayProblem(group, "4803", "internet", "running")!, /multicast or broadcast/, group);
  assert.match(relayProblem("192.0.2.10", "4803", "internet", "not configured")!, /no accept process.*SUDO\.md §5/);
  assert.match(relayProblem("192.0.2.10", "4803", "internet", "not running")!, /isn't running/);
  assert.match(relayProblem("192.0.2.10", "4803", "internet", "wrong version")!, /older version/);
  assert.equal(relayProblem("10.0.0.10", "4803", "lan", "not configured"), null, "a LAN relay never needs the accept process");
  assert.equal(acceptorReason("running"), null);
  assert.match(portWarning("internet", "443")!, /share front/);
  assert.equal(portWarning("internet", "4803"), null);
  assert.equal(portWarning("lan", "443"), null);
});

test("the pairing form refuses a relay at a public IP unless it is marked as on the internet; a name is the dialer's to judge", () => {
  const d = { role: "dial" as const, fingerprint: FP, id: "relay", label: "", host: "192.0.2.5", port: "4803", internet: false };
  assert.match(pairingProblem(d, [])!, /local-network address, or check “This relay is on the internet”/);
  assert.equal(pairingProblem({ ...d, host: "10.0.0.5" }, []), null);
  assert.equal(pairingProblem({ ...d, host: "relay.example" }, []), null);
  assert.equal(pairingProblem({ ...d, internet: true }, []), null);
  assert.equal(pairingProblem({ ...d, internet: true, host: "2001:db8::5" }, []), null);
  for (const host of ["0.0.0.0", "224.0.0.1", "255.255.255.255"]) assert.match(pairingProblem({ ...d, internet: true, host }, [])!, /not every address, a multicast or a broadcast/, host);
});

test("the relay line says where it listens, and for how many", () => {
  const relay = { host: "192.0.2.10", port: 4803, exposure: "lan" as const, listening: true, boundPort: 4803 };
  const accept = row("accept", { state: "not connected" }, { state: "not connected" });
  const acceptor = { state: "not configured" as const };
  assert.equal(relayLine({ acceptor, pairings: [] }), "This host isn't a relay.");
  assert.equal(relayLine({ acceptor, relay, pairings: [accept] }), "Listening on 192.0.2.10:4803 for 1 dial-out host.");
  assert.equal(relayLine({ acceptor, relay: { ...relay, listening: false }, pairings: [] }), "Set to 192.0.2.10:4803. It listens only while a dial-out host is paired.");
  assert.equal(relayLine({ acceptor, relay: { ...relay, host: "2001:db8::1" }, pairings: [accept, accept] }), "Listening on [2001:db8::1]:4803 for 2 dial-out hosts.");
});

test("an internet relay's line and the accept process's", () => {
  const relay = { host: "192.0.2.10", port: 4803, exposure: "internet" as const, listening: true, boundPort: 4803, counts: { open: 2, banned: 1, bans: 5 } };
  const accept = row("accept", { state: "not connected" }, { state: "not connected" });
  const running = { state: "running" as const };
  assert.equal(relayLine({ acceptor: running, relay, pairings: [accept] }), "Listening from the internet on 192.0.2.10:4803 for 1 dial-out host.");
  assert.equal(acceptorLine({ acceptor: running, relay, pairings: [accept] }), "Accept process: running · 2 open · 1 banned now · 5 bans so far.");
  const down = { state: "not running" as const };
  assert.equal(relayLine({ acceptor: down, relay: { ...relay, listening: false }, pairings: [accept] }), "Set to 192.0.2.10:4803 from the internet, and not listening: the accept process isn't running. See SUDO.md §5 on the server.");
  assert.equal(acceptorLine({ acceptor: down, relay: { ...relay, listening: false }, pairings: [accept] }), "Accept process: not running.");
  assert.equal(acceptorLine({ acceptor: running, relay: { ...relay, exposure: "lan" }, pairings: [] }), null, "a LAN relay has no accept-process line");
});

test("an internet pairing that keeps timing out says the network may block its port", () => {
  const waiting = { state: "waiting", reason: "timed out", retryAt: 5_000 } as const;
  const p = { ...row("dial", waiting, waiting), host: "192.0.2.10", port: 4803, internet: true as const };
  assert.equal(pairingState(p, 0).detail, "Timed out. Next try in 5 s. The network this host is on may block port 4803.");
  const { internet: _, ...lanPairing } = p;
  assert.equal(pairingState(lanPairing, 0).detail, "Timed out. Next try in 5 s.");
  assert.equal(pairingState({ ...p, channels: { answer: { ...waiting, reason: "accept process refused" }, ask: waiting } }, 0).detail, "Accept process refused. Next try in 5 s.");
});

test("the internet checkbox sits beside its label, not a card's width away", () => {
  // base.css spreads a .toggle row (justify-content: space-between); the pairing form opts out.
  const tsx = readFileSync(new URL("../components/MeshPairings.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../mesh.css", import.meta.url), "utf8");
  assert.match(tsx, /<label class="toggle mesh-pair-internet">/);
  assert.match(css, /\.mesh-pair-internet \{ justify-content: flex-start; \}/);
});
