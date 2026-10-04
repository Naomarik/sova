// M9 — an internet relay behind its separate accept process (§mesh.lan/accept-process, §mesh.vps/internet-relay),
// between real Sova processes, with `plain` (no Tailscale) as the dial-out host:
//   - the lab runs with `--wan`: the first host (the relay) and plain also sit on sovamesh_wan, 198.51.100.0/24,
//     a documentation range Sova treats as PUBLIC, so plain may dial it only with the internet mark;
//   - in the relay's container the accept process runs as its own uid (sova-relay), from the bundle the deploy
//     builds (`bun build --target=node`, stamped with the image's commit), on Node with --jitless --permission,
//     reaching Sova only through the handoff socket's group; iptables owner rules stand in for the unit's
//     IPAddressDeny (no loopback, lab network, tailnet or link-local) and SUDO.md §5's "no new outbound";
//   - Sova (root in the lab) gets SOVA_RELAY_HANDOFF through /run/lab/sova.env and is restarted once;
//   - cases: the internet relay can't be saved before the accept process runs; once it runs, the port is the
//     accept process's (never Sova's); plain comes up on both channels and grants hold both ways; an unpaired
//     certificate and TLS 1.2 are refused at the accept process and Sova hears of neither; a forged handoff
//     written to the socket as the accept process's uid, with another key inside, is refused and flagged;
//     the accept process's uid reaches neither Sova's port nor the tailnet nor the lab network; killing it
//     drops both channels, the relay reads not listening and the port closes; restarted, plain comes back;
//     Stop Relaying ends everything; a public relay address without the mark is refused.
//   scripts/mesh-lab/lab up --wan && scripts/mesh-lab/lab e2e m9-internet-relay   (takes the lab LOCK; undoes
//   everything it set up: pairings, relay, the accept process, its rules and user, sova.env)
// No key, pin or fingerprint is printed: assertions compare them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { WAN_IPS } from "../lab.mjs";
import { dockerIp, laptopFetch, PEER_PORT, requireLab, sh, SOVA_PORT, tailnetIp, waitFor } from "./lib.mjs";
import { releaseLock, takeLock } from "./links-lib.mjs";

const RELAY_PORT = 4803;
const DIALER = "plain";
const ACC = "/opt/sova-relay";
const HANDOFF_DIR = "/run/sova-relay-lab";
const SOCK = `${HANDOFF_DIR}/h.sock`;
const STATE_DIR = "/var/lib/sova-relay";
let cfg;
let R; // the relay host
let labIp = ""; // R on the (private) lab network
let relayFp = "";
let dialerFp = "";
let savedEnv = "";
/** The lab network's subnet (the accept process may reach nothing on it). */
const labSubnet = () => spawnSync("docker", ["network", "inspect", "sovamesh_lab", "-f", "{{(index .IPAM.Config 0).Subnet}}"], { encoding: "utf8" }).stdout.trim();

const send = (method, body) => ({ method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const lanOf = async (n) => (await laptopFetch(n, "/api/mesh/lan")).json();
const pairingOf = async (n, id) => (await lanOf(n)).pairings?.find((p) => p.id === id);
const bothUp = (p) => p?.channels.answer.state === "connected" && p?.channels.ask.state === "connected";
const bothDown = (p) => p && p.channels.answer.state !== "connected" && p.channels.ask.state !== "connected";
const sessionsRow = async (n, id) => (await (await laptopFetch(n, "/api/mesh/sessions")).json()).peers?.find((p) => p.id === id);
async function grant(host, peer, preset) {
  const res = await laptopFetch(host, "/api/mesh/access", send("PUT", { peer, grant: { preset } }));
  assert.equal(res.status, 200, `${host} grants ${peer} ${preset}: ${res.status}`);
}
/** One shell word, single-quoted: a multi-line script reaches node byte for byte. */
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Run `node -e` in R as the accept process's uid, with its group; prints what it printed. */
const asAcceptor = (script, ...args) =>
  sh(R, `setpriv --reuid=sova-relay --regid=sova-relay --groups=0 --no-new-privs node -e ${shq(script)} ${args.map((a) => shq(String(a))).join(" ")}`).out;
/** A bare TCP connect from inside R as the accept process's uid: "open" or "blocked". */
const reachAsAcceptor = (host, port) =>
  asAcceptor('const s=require("net").connect(+process.argv[2],process.argv[1]);const o=(w)=>{console.log(w);process.exit(0)};s.setTimeout(3000,()=>o("blocked"));s.on("connect",()=>o("open"));s.on("error",()=>o("blocked"))', host, String(port));
/** Whether anything accepts TCP at the relay's public address from plain. */
const publicPortOpen = () =>
  sh(DIALER, `node -e 'const s=require("net").connect(${RELAY_PORT},"${WAN_IPS.relay}");const o=(w)=>{console.log(w);process.exit(0)};s.setTimeout(3000,()=>o("closed"));s.on("connect",()=>o("open"));s.on("error",()=>o("closed"))'`).out === "open";
/** Lines Sova logged about the internet relay so far. */
const sovaRelayLines = () => sh(R, "grep -c 'internet relay' /var/log/lab/sova.log || true").out;

function startAcceptor() {
  // Node 25 (the lab image) gates the network under --permission; the VPS's Node 22 doesn't (its unit omits it).
  const r = sh(R, `net=; node -e 'process.exit(+process.versions.node.split(".")[0] >= 25 ? 0 : 1)' && net=--allow-net;
    setsid -f setpriv --reuid=sova-relay --regid=sova-relay --groups=0 --inh-caps=-all --bounding-set=-all --no-new-privs \
      env -i PATH=/usr/local/bin:/usr/bin:/bin SOVA_ACCEPT_HANDOFF=${SOCK} SOVA_ACCEPT_STATE=${STATE_DIR} \
      node --jitless --permission $net --allow-fs-read=${ACC}/accept --allow-fs-read=${STATE_DIR} --allow-fs-write=${STATE_DIR} \
      ${ACC}/accept/relay-accept.mjs >>/var/log/lab/relay-accept.log 2>&1 </dev/null; echo started`);
  assert.equal(r.out, "started", r.err);
}
const stopAcceptor = (signal = "TERM") => sh(R, `pkill -${signal} -u sova-relay -f relay-accept.mjs; sleep 0.3; true`);
const acceptorRunning = async () => (await lanOf(R)).acceptor?.state === "running";

async function restartSova() {
  sh(R, 'pkill -f "[s]erver/index.ts"; true');
  await waitFor(async () => (await laptopFetch(R, "/api/health")).ok, { what: "the relay's Sova back", timeoutMs: 60000 });
}

/** In R: the accept process's user, its bundle (built as the deploy builds it), the handoff directory, its state
    directory, the network rules, and Sova pointed at the socket. */
async function setUp() {
  const steps = [
    "id -u sova-relay >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sova-relay",
    `cd /sova && commit=$(node -e 'try{const c=JSON.parse(require("fs").readFileSync("BUILD_COMMIT","utf8")).commit;process.stdout.write(/^[0-9a-f]{40}$/.test(c)?c:"dev")}catch{process.stdout.write("dev")}') \
      && install -d -m 0755 ${ACC}/accept \
      && bun build server/mesh/relay-accept/main.ts --target=node --format=esm --outfile ${ACC}/accept/relay-accept.mjs --define "__SOVA_ACCEPT_BUILD__=\\"$commit\\"" >/dev/null \
      && chmod 0644 ${ACC}/accept/relay-accept.mjs`,
    // Sova runs as root here, so its own directory is root:root 0750; the accept process reaches it through group 0.
    `install -d -m 0750 -o root -g root ${HANDOFF_DIR}`,
    `install -d -m 0700 -o sova-relay -g sova-relay ${STATE_DIR}`,
    // Stand-ins for IPAddressDeny and SUDO.md §5 step 5: nothing new outbound, nothing to loopback, the lab network,
    // the tailnet or link-local. Replies to the internet (plain on the wan) stay allowed.
    `for d in 127.0.0.0/8 ${labSubnet()} 100.64.0.0/10 169.254.0.0/16; do \
       iptables -I OUTPUT -m owner --uid-owner sova-relay -d "$d" -j REJECT; done; \
     iptables -I OUTPUT -m owner --uid-owner sova-relay -m conntrack --ctstate NEW -j REJECT; \
     ip6tables -I OUTPUT -m owner --uid-owner sova-relay -j REJECT 2>/dev/null; true`,
  ];
  for (const s of steps) {
    const r = sh(R, s, { timeoutMs: 120000 });
    assert.equal(r.code, 0, `${s.slice(0, 60)}…: ${r.err}`);
  }
  savedEnv = sh(R, "cat /run/lab/sova.env 2>/dev/null || true").out;
  sh(R, `{ grep -v '^SOVA_RELAY_HANDOFF=' /run/lab/sova.env 2>/dev/null; echo SOVA_RELAY_HANDOFF=${SOCK}; } > /run/lab/sova.env.new && mv /run/lab/sova.env.new /run/lab/sova.env`);
  await restartSova();
}

async function tearDown() {
  stopAcceptor("KILL");
  sh(R, `while iptables -D OUTPUT -m owner --uid-owner sova-relay -m conntrack --ctstate NEW -j REJECT 2>/dev/null; do :; done;
    for d in 127.0.0.0/8 ${labSubnet()} 100.64.0.0/10 169.254.0.0/16; do
      while iptables -D OUTPUT -m owner --uid-owner sova-relay -d "$d" -j REJECT 2>/dev/null; do :; done; done;
    while ip6tables -D OUTPUT -m owner --uid-owner sova-relay -j REJECT 2>/dev/null; do :; done;
    rm -rf ${ACC} ${HANDOFF_DIR} ${STATE_DIR}; userdel sova-relay 2>/dev/null; true`);
  if (savedEnv) sh(R, `printf '%s\\n' ${JSON.stringify(savedEnv)} > /run/lab/sova.env`);
  else sh(R, "rm -f /run/lab/sova.env");
  await restartSova();
}

async function unpairAll() {
  for (const [host, id] of [[R, "laptop"], [DIALER, "vps"], [DIALER, "unmarked"]]) {
    const res = await laptopFetch(host, `/api/mesh/lan/pairings/${id}`, { method: "DELETE" });
    await res.body?.cancel();
  }
  await (await laptopFetch(R, "/api/mesh/lan/relay", send("PUT", { relay: null }))).body?.cancel();
}

before(async () => {
  cfg = requireLab();
  assert.ok(cfg.plain, "M9 needs the plain host (lab up without --no-plain)");
  assert.ok(cfg.wan, "M9 needs the wan network: scripts/mesh-lab/lab up --wan");
  R = cfg.hosts[0];
  labIp = dockerIp(R);
  assert.equal(dockerIp(R, "sovamesh_wan"), WAN_IPS.relay);
  assert.equal(dockerIp(DIALER, "sovamesh_wan"), WAN_IPS.plain);
  await takeLock("m9-internet-relay");
  await unpairAll();
  await setUp();
});

after(async () => {
  try {
    await unpairAll();
    await tearDown();
  } finally {
    releaseLock();
  }
});

describe("setting up", () => {
  test("pairing: each side pastes the other's fingerprint; plain marks the relay as on the internet", async () => {
    relayFp = (await (await laptopFetch(R, "/api/mesh/lan/key", { method: "POST" })).json()).fingerprint;
    dialerFp = (await (await laptopFetch(DIALER, "/api/mesh/lan/key", { method: "POST" })).json()).fingerprint;
    const acc = await laptopFetch(R, "/api/mesh/lan/pairings", send("POST", { id: "laptop", label: "Laptop", role: "accept", pin: dialerFp }));
    assert.equal(acc.status, 200, await acc.text());
    const unmarked = await laptopFetch(DIALER, "/api/mesh/lan/pairings", send("POST", { id: "unmarked", role: "dial", pin: relayFp, host: WAN_IPS.relay, port: RELAY_PORT }));
    assert.equal(unmarked.status, 400, "a public relay address without the internet mark is refused");
    assert.match((await unmarked.json()).error, /public address/);
    const dial = await laptopFetch(DIALER, "/api/mesh/lan/pairings", send("POST", { id: "vps", label: "VPS", role: "dial", pin: relayFp, host: WAN_IPS.relay, port: RELAY_PORT, internet: true }));
    assert.equal(dial.status, 200, await dial.text());
    assert.equal((await pairingOf(DIALER, "vps"))?.internet, true);
  });

  test("the internet relay can't be saved while the accept process isn't running", async () => {
    assert.equal((await lanOf(R)).acceptor.state, "not running");
    const res = await laptopFetch(R, "/api/mesh/lan/relay", send("PUT", { relay: { host: WAN_IPS.relay, port: RELAY_PORT, exposure: "internet" } }));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "the accept process isn't running (SUDO.md §5)");
    assert.equal(publicPortOpen(), false);
  });

  test("with the accept process running it saves, and the port is the accept process's, never Sova's", async () => {
    startAcceptor();
    await waitFor(acceptorRunning, { what: "the accept process connected", timeoutMs: 20000 });
    assert.equal(sh(R, `stat -c '%a %U %G' ${STATE_DIR}/accept-identity.json`).out, "600 sova-relay sova-relay", "its own key, its own file");
    assert.equal(sh(R, `stat -c '%a' ${SOCK}`).out, "660");
    const res = await laptopFetch(R, "/api/mesh/lan/relay", send("PUT", { relay: { host: WAN_IPS.relay, port: RELAY_PORT, exposure: "internet" } }));
    assert.equal(res.status, 200, await res.text());
    await waitFor(async () => (await lanOf(R)).relay?.listening, { what: "listening", timeoutMs: 15000 });
    // The listening socket's process belongs to sova-relay; Sova (root) holds nothing on that port.
    // Root in a container lacks CAP_SYS_PTRACE, so it can't see another uid's sockets: the port's
    // owner is the uid whose own `ss -p` finds a pid on it, and root's (Sova's) finds none.
    const portPid = (who) => sh(R, `${who}ss -ltnpH 'sport = :${RELAY_PORT}' | grep -c 'pid='`).out;
    assert.equal(portPid("setpriv --reuid=sova-relay --regid=sova-relay --clear-groups "), "1", "the accept process holds the port");
    assert.equal(portPid(""), "0", "Sova (root) holds nothing on that port");
    assert.equal(sh(R, `ss -ltnH 'sport = :${RELAY_PORT}' | awk '{print $4}'`).out, `${WAN_IPS.relay}:${RELAY_PORT}`, "one address, never every interface");
    assert.equal(publicPortOpen(), true);
  });
});

describe("through the accept process", () => {
  test("plain comes up on both channels", async () => {
    await waitFor(async () => bothUp(await pairingOf(DIALER, "vps")), { what: "plain's two channels", timeoutMs: 70000 });
    await waitFor(async () => bothUp(await pairingOf(R, "laptop")), { what: "the relay's view" });
  });

  test("grants hold both ways, each under the answering host's grant", async () => {
    assert.equal((await sessionsRow(R, "laptop"))?.state, "hidden");
    assert.equal((await sessionsRow(DIALER, "vps"))?.state, "hidden");
    await grant(DIALER, "vps", "sessions");
    await waitFor(async () => (await sessionsRow(R, "laptop"))?.state === "up", { what: "plain's sessions on the relay" });
    assert.equal((await sessionsRow(DIALER, "vps"))?.state, "hidden", "grants are per direction");
    await grant(R, "laptop", "sessions");
    await waitFor(async () => (await sessionsRow(DIALER, "vps"))?.state === "up", { what: "the relay's sessions on plain" });
    await grant(R, "laptop", "presence");
    await grant(DIALER, "vps", "presence");
  });

  test("an unpaired certificate and TLS 1.2 are refused at the accept process; Sova hears of neither", async () => {
    const before = sovaRelayLines();
    const probe = sh(DIALER, `d=$(mktemp -d); openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout $d/k -out $d/c -days 1 -subj /CN=probe 2>/dev/null;
      timeout 8 openssl s_client -connect ${WAN_IPS.relay}:${RELAY_PORT} -tls1_3 -alpn pa/1 -noservername -cert $d/c -key $d/k -quiet -ign_eof </dev/null 2>/dev/null | wc -c; rm -rf $d`);
    assert.equal(probe.out, "0", "no byte back to an unpaired certificate");
    const t12 = sh(DIALER, `timeout 8 openssl s_client -connect ${WAN_IPS.relay}:${RELAY_PORT} -tls1_2 -noservername -brief </dev/null 2>&1 | grep -c 'Protocol version: TLSv1.2' || true`);
    assert.equal(t12.out, "0", "TLS 1.2 never completes");
    const http = sh(DIALER, `curl -sk -m 4 -o /dev/null -w '%{http_code}' https://${WAN_IPS.relay}:${RELAY_PORT}/api/peer/hello || true`).out;
    assert.equal(http.replace(/^0+$/, ""), "", "no HTTP answer without a certificate");
    assert.equal(sovaRelayLines(), before, "nothing reached Sova");
    assert.ok(bothUp(await pairingOf(DIALER, "vps")), "the real pairing is untouched");
  });

  test("a forged handoff, written to the socket as the accept process's uid with another key inside, is refused and flagged", async () => {
    // What a compromised accept process could do: vouch for plain's pin, then prove another key.
    const script = `
      const fs=require("fs"),net=require("net"),tls=require("tls");
      const [sock,pin,dir]=process.argv.slice(1);
      const u=net.connect(sock);
      u.on("error",()=>{});
      u.on("close",()=>{console.log("closed");process.exit(0)});
      u.on("connect",()=>{
        u.write(JSON.stringify({v:1,kind:"conn",pin,channel:"ask"})+"\\n");
        const t=tls.connect({socket:u,key:fs.readFileSync(dir+"/k"),cert:fs.readFileSync(dir+"/c"),rejectUnauthorized:false,minVersion:"TLSv1.3",maxVersion:"TLSv1.3",ALPNProtocols:["pq/1"],servername:""});
        t.on("error",()=>{});
      });
      setTimeout(()=>{console.log("open");process.exit(0)},5000);`;
    // A real key and its own certificate, so the inner handshake completes and proves that key's pin.
    const dir = sh(R, `d=$(mktemp -d); openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout $d/k -out $d/c -days 1 -subj /CN=x 2>/dev/null; chmod 755 $d; chmod 644 $d/k $d/c; echo $d`).out;
    const out = asAcceptor(script, SOCK, dialerFp.replace(/-/g, ""), dir);
    sh(R, `rm -rf ${dir}`);
    assert.equal(out, "closed");
    await waitFor(async () => (await lanOf(R)).acceptor.mismatchAt, { what: "the Mesh page's alert", timeoutMs: 5000 });
    assert.match(sh(R, "grep -c 'vouched for a host the connection' /var/log/lab/sova.log").out, /^[1-9]/);
    assert.ok(bothUp(await pairingOf(DIALER, "vps")), "the real pairing is untouched");
  });

  test("the accept process's uid reaches neither Sova's own port, nor the tailnet, nor the lab network", () => {
    assert.equal(reachAsAcceptor("127.0.0.1", SOVA_PORT), "blocked", "Sova's main listener on loopback");
    const ts = tailnetIp(R);
    if (ts) assert.equal(reachAsAcceptor(ts, PEER_PORT), "blocked", "the tailnet");
    const other = cfg.hosts[1] ? dockerIp(cfg.hosts[1]) : labIp;
    assert.equal(reachAsAcceptor(other, SOVA_PORT), "blocked", "the lab network");
    assert.equal(reachAsAcceptor(WAN_IPS.plain, 4900), "blocked", "no new outbound connection at all");
    // Root (Sova's side here) still reaches them: the rules are the acceptor's alone.
    assert.equal(sh(R, `node -e 'const s=require("net").connect(${SOVA_PORT},"127.0.0.1");s.on("connect",()=>{console.log("open");process.exit(0)});s.on("error",()=>{console.log("x");process.exit(0)})'`).out, "open");
  });

  test("killing the accept process drops both channels at once, the relay reads not listening, and the port closes", async () => {
    stopAcceptor("KILL");
    await waitFor(async () => bothDown(await pairingOf(R, "laptop")), { what: "the relay's channels down", timeoutMs: 3000 });
    await waitFor(async () => bothDown(await pairingOf(DIALER, "vps")), { what: "plain's channels down", timeoutMs: 5000 });
    const st = await lanOf(R);
    assert.equal(st.acceptor.state, "not running");
    assert.equal(st.relay.listening, false);
    assert.equal(st.relay.exposure, "internet", "the setting stays; nothing fell back to Sova");
    assert.equal(publicPortOpen(), false, "nothing listens on the public port");
    assert.equal(sh(R, `ss -ltnH 'sport = :${RELAY_PORT}' | wc -l`).out, "0");
  });

  test("restarted, the accept process takes Sova's word again and plain comes back", async () => {
    startAcceptor();
    await waitFor(acceptorRunning, { what: "the accept process back", timeoutMs: 20000 });
    await waitFor(async () => (await lanOf(R)).relay?.listening, { what: "listening again", timeoutMs: 15000 });
    await waitFor(async () => bothUp(await pairingOf(DIALER, "vps")), { what: "plain back on both channels", timeoutMs: 70000 });
  });

  test("Stop Relaying ends both channels at once; the accept process stops listening", async () => {
    const res = await laptopFetch(R, "/api/mesh/lan/relay", send("PUT", { relay: null }));
    assert.equal(res.status, 200);
    await res.body?.cancel();
    await waitFor(async () => bothDown(await pairingOf(R, "laptop")), { what: "the relay's channels down", timeoutMs: 1000 });
    await waitFor(async () => bothDown(await pairingOf(DIALER, "vps")), { what: "plain's channels down", timeoutMs: 3000 });
    await waitFor(() => !publicPortOpen(), { what: "the port closed", timeoutMs: 5000 });
    assert.equal((await lanOf(R)).acceptor.state, "running", "the accept process keeps running, listening nowhere");
  });
});
