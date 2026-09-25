// M0 — the lab itself: Headscale + N Sova hosts that reach each other over the lab tailnet, each
// with its own tailscaled, agent dir and sessions; a host with no tailscale at all; the front door;
// the chaos primitives; and the isolation guarantees (never the laptop's real tailnet).
//   scripts/mesh-lab/lab e2e m0
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import {
  chaos, curlFrom, dockerIp, exec, execBackground, laptopFetch, localapi, magicName, nodeId, readAgentFile, requireLab,
  SERVE_PORT, sh, SOVA_PORT, tailnetIp, tailnetNodes, tsStatus, waitFor, waitTailnetHealth,
} from "./lib.mjs";

let cfg;
before(() => {
  cfg = requireLab();
});

describe("tailnet", () => {
  test("every tailnet node is logged in to the lab Headscale with a 100.64/10 address", () => {
    for (const n of tailnetNodes(cfg)) {
      const st = tsStatus(n);
      assert.equal(st?.BackendState, "Running", `${n} backend`);
      assert.match(tailnetIp(n) ?? "", /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, `${n} ip`);
      assert.equal(st.Self.DNSName, `${magicName(n)}.`, `${n} MagicDNS name`);
      assert.equal(st.CurrentTailnet?.MagicDNSSuffix ?? "mesh.lab", "mesh.lab");
    }
  });

  test("Headscale lists exactly the lab's tailnet nodes, all online", () => {
    const r = exec("headscale", ["headscale", "nodes", "list", "-o", "json"]);
    const nodes = JSON.parse(r.out);
    const names = nodes.map((x) => x.given_name ?? x.name).sort();
    assert.deepEqual(names, [...tailnetNodes(cfg)].sort());
    for (const x of nodes) assert.equal(x.online, true, `${x.given_name} online`);
  });

  test("MagicDNS resolves every host from every host", () => {
    for (const from of cfg.hosts)
      for (const to of cfg.hosts) {
        const r = exec(from, ["getent", "hosts", magicName(to)]);
        assert.equal(r.out.split(/\s+/)[0], tailnetIp(to), `${from} resolves ${to}`);
      }
  });

  test("every host reaches every other host's Sova over the tailnet (tailscale serve :8443)", async () => {
    for (const from of cfg.hosts) for (const to of cfg.hosts) if (from !== to) await waitTailnetHealth(from, to, 30000);
  });

  test("LocalAPI whois of an incoming tailnet connection names the caller", async () => {
    const [a, b] = cfg.hosts;
    const listenIp = tailnetIp(b);
    // One-shot listener on b's tailnet IP: accepts one connection, whois-es its remote address.
    const script = `
const net = require("net"), http = require("http");
const srv = net.createServer((sock) => {
  const addr = sock.remoteAddress + ":" + sock.remotePort;
  http.get({ socketPath: "/var/run/tailscale/tailscaled.sock", path: "/localapi/v0/whois?addr=" + encodeURIComponent(addr), headers: { Host: "local-tailscaled.sock" } }, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
      const w = JSON.parse(d); console.log(JSON.stringify({ addr, id: w.Node && w.Node.StableID, name: w.Node && w.Node.Name }));
      sock.end("ok\\n"); srv.close(); process.exit(0);
    });
  });
});
srv.listen(4999, process.argv[1]); setTimeout(() => process.exit(2), 20000);`;
    const listener = execBackground(b, ["node", "-e", script, listenIp]);
    await waitFor(() => sh(b, "ss -ltn | grep -q ':4999 '").code === 0, { what: "listener on b" });
    const dial = exec(a, ["node", "-e", 'const s=require("net").connect(4999,process.argv[1]);s.on("data",d=>{process.stdout.write(d);s.end()});setTimeout(()=>process.exit(3),5000)', listenIp]);
    assert.equal(dial.out, "ok", `dial from ${a}: ${dial.err}`);
    const { code, out } = await listener.done;
    assert.equal(code, 0, `listener exit (${out})`);
    const seen = JSON.parse(out.split("\n").pop());
    assert.equal(seen.addr.split(":")[0], tailnetIp(a), "remote address is a's tailnet IP");
    assert.equal(seen.id, nodeId(a), "whois StableID is a's node id");
    assert.equal(seen.name, `${magicName(a)}.`);
  });

  test("whois of a non-tailnet address answers nothing", () => {
    const [a] = cfg.hosts;
    const r = exec(a, ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--unix-socket", "/var/run/tailscale/tailscaled.sock", `http://local-tailscaled.sock/localapi/v0/whois?addr=${dockerIp("headscale")}:1`]);
    assert.notEqual(r.out, "200");
  });
});

describe("hosts", () => {
  test("each Sova listens on loopback only (not on the docker network, not on the tailnet IP)", () => {
    const [a, b] = cfg.hosts;
    assert.equal(curlFrom(a, `http://${dockerIp(b)}:${SOVA_PORT}/api/health`, { timeoutS: 2 }).status, 0);
    assert.equal(curlFrom(a, `http://${tailnetIp(b)}:${SOVA_PORT}/api/health`, { timeoutS: 2 }).status, 0);
    assert.equal(curlFrom(b, `http://127.0.0.1:${SOVA_PORT}/api/health`).json?.ok, true);
  });

  test("each host has its own hermetic agent dir: API keys (and mock logins) only", () => {
    for (const n of [...cfg.hosts, ...(cfg.plain ? ["plain"] : [])]) {
      assert.equal(sh(n, "cd /sova && node scripts/hermetic-agent-dir.mjs --check").code, 0, `${n} --check`);
      const auth = readAgentFile(n, "auth.json");
      const wantsAuth = cfg.auth === "all" || (Array.isArray(cfg.auth) && cfg.auth.includes(n));
      if (!wantsAuth) continue;
      assert.ok(auth, `${n} has auth.json`);
      // API keys from the worktree, plus OAuth entries the lab's mock token server minted (its
      // accounts are "acct-L<n>"); a real subscription login never belongs here
      const entries = Object.entries(JSON.parse(auth));
      assert.ok(entries.some(([, v]) => v.type === "api_key"), `${n}: has the API keys`);
      for (const [k, v] of entries) assert.ok(v.type === "api_key" || (v.type === "oauth" && /^acct-L\d+$/.test(v.accountId ?? "")), `${n}: ${k} is ${v.type}, not an API key or a mock login`);
      assert.equal(sh(n, 'stat -c %a "$PI_CODING_AGENT_DIR/auth.json"').out, "600");
      assert.equal(sh(n, "test -e /root/.claude/.credentials.json").code, 1, `${n}: no Claude store`);
    }
  });

  test("each host lists its own sessions and not the others'", async () => {
    if (!cfg.seed) return;
    const seen = new Map();
    for (const n of cfg.hosts) {
      const list = await (await laptopFetch(n, "/api/sessions")).json();
      const titles = list.map((s) => s.title);
      assert.ok(titles.includes(`fixture session on lab host ${n}`), `${n} lists its fixture`);
      for (const [other, ids] of seen) for (const s of list) assert.ok(!ids.has(s.id), `${n} lists ${other}'s session ${s.id}`);
      seen.set(n, new Set(list.map((s) => s.id)));
    }
  });

  test("the plain host has no tailscale at all", () => {
    if (!cfg.plain) return;
    assert.notEqual(sh("plain", "command -v tailscale || command -v tailscaled").code, 0, "no binaries");
    assert.equal(sh("plain", "ip link show tailscale0").code, 1, "no tailscale0");
    assert.equal(sh("plain", "test -e /var/run/tailscale/tailscaled.sock").code, 1, "no LocalAPI socket");
    assert.equal(curlFrom("plain", `http://127.0.0.1:${SOVA_PORT}/api/health`).json?.ok, true, "sova up");
    assert.equal(curlFrom("plain", `http://${tailnetIp(cfg.hosts[0])}:${SERVE_PORT}/api/health`, { timeoutS: 2 }).status, 0, "cannot reach the tailnet");
  });
});

describe("isolation from the laptop's real tailnet", () => {
  test("containers resolve no real MagicDNS names and inherit no laptop search domain", () => {
    for (const n of [...cfg.hosts, ...(cfg.plain ? ["plain"] : [])]) {
      const rc = sh(n, "grep -v '^#' /etc/resolv.conf").out;
      assert.doesNotMatch(rc, /ts\.net/, `${n} resolv.conf`);
    }
  });

  test("every container rejects tailnet-range traffic that is not routed via its own tailscale0", () => {
    for (const n of [...cfg.hosts, ...(cfg.plain ? ["plain"] : []), ...(cfg.stranger ? ["stranger"] : []), ...(cfg.frontdoor ? ["frontdoor"] : [])]) {
      const r = sh(n, "iptables -S OUTPUT");
      assert.match(r.out, /-A OUTPUT -d 100\.64\.0\.0\/10 -o eth0 -j REJECT/, `${n} guard rule`);
    }
    // an address in the tailnet range that no lab node holds
    const r = curlFrom(cfg.hosts[0], "http://100.127.254.254:80/", { timeoutS: 2 });
    assert.equal(r.status, 0);
  });

  test("the lab tailnet contains lab nodes only", () => {
    const st = localapi(cfg.hosts[0], "status");
    const peers = Object.values(st.Peer || {}).map((p) => p.DNSName);
    for (const p of peers) assert.match(p, /\.mesh\.lab\.$/);
  });

  test("Sova runs without NET_ADMIN", () => {
    for (const n of cfg.hosts) {
      const bnd = sh(n, 'grep CapBnd /proc/$(pgrep -f "[i]mport tsx server/index.ts" | head -1)/status').out.split(/\s+/)[1];
      assert.ok(bnd && (BigInt("0x" + bnd) & (1n << 12n)) === 0n, `${n} CapBnd ${bnd}`);
    }
  });
});

describe("front door", () => {
  test("serves the first healthy host in order, WebSockets included", async () => {
    if (!cfg.frontdoor) return;
    const first = (cfg.order && cfg.order.length ? cfg.order : cfg.hosts)[0];
    const res = await waitFor(async () => {
      const r = await laptopFetch("frontdoor", "/api/health");
      return (r.headers.get("x-sova-upstream") ?? r.headers.get("x-lab-upstream")) === `${magicName(first)}:${SERVE_PORT}` && r;
    }, { what: `front door on ${first}` });
    assert.equal(res.status, 200);
    const ws = await new Promise((resolve) => {
      const s = new WebSocket("ws://127.0.0.1:4890/ws/watch");
      s.onopen = () => resolve("open");
      s.onclose = (e) => resolve(`close ${e.code}`);
      s.onerror = () => {};
    });
    assert.ok(ws === "open" || /^close 4\d\d\d$/.test(ws), `upgrade reached Sova (${ws})`);
  });
});

describe("chaos primitives", () => {
  test("partition cuts a host off the tailnet but keeps its internet and its laptop port; restore heals", async () => {
    const [a, , c] = cfg.hosts;
    const victim = c ?? cfg.hosts[1];
    chaos.partition(victim);
    try {
      assert.equal(curlFrom(a, `http://${magicName(victim)}:${SERVE_PORT}/api/health`, { timeoutS: 3 }).status, 0, "tailnet cut");
      assert.equal((await laptopFetch(victim, "/api/health")).status, 200, "laptop port still works");
      assert.notEqual(curlFrom(victim, "https://api.z.ai/", { timeoutS: 8 }).status, 0, "internet still works");
    } finally {
      chaos.restore(victim);
    }
    await waitTailnetHealth(a, victim, 60000);
  });

  test("sova-stop takes only Sova down; the node stays on the tailnet", async () => {
    const [a, b] = cfg.hosts;
    chaos.sovaStop(b);
    try {
      assert.equal(tsStatus(b)?.BackendState, "Running");
      const r = curlFrom(a, `http://${magicName(b)}:${SERVE_PORT}/api/health`, { timeoutS: 3 });
      assert.notEqual(r.json?.ok, true, "sova is down");
    } finally {
      chaos.sovaStart(b);
    }
    await waitTailnetHealth(a, b, 60000);
  });
});
