#!/usr/bin/env node
// A stand-in for cloudflared in tests (named by SOVA_CLOUDFLARED). Never touches the network: it takes
// the real argv, serves cloudflared's metrics endpoints on --metrics (loopback), and writes --pidfile
// once "connected", as cloudflared does after its first edge connection.
//
//   GET /ready        {"status":200,"readyConnections":4,"connectorId":"<id>"} (503, 0 connections, before connect or when FAKE_CF_DOWN_FILE exists)
//   GET /quicktunnel  {"hostname":"<host>"} (quick tunnels only: argv has --url)
//   GET /config       {"version":1,"config":{"ingress":[{"service":"<FAKE_CF_INGRESS>"},{"service":"http_status:404"}]}} (named tunnels)
//
// Switches (env):
//   FAKE_CF_LOG=<file>          one line per metrics request ("<pid> <path>"), and "start <pid> <argv>" / "exit <pid> <how>"
//   FAKE_CF_CONNECT_MS=<n>      wait before connecting (default 50)
//   FAKE_CF_FAIL=start          print an error line and exit 1 at once
//   FAKE_CF_NEVER_CONNECT=1     serve metrics but never connect (no pidfile)
//   FAKE_CF_DIE_MS=<n>          exit 1 that long after connecting
//   FAKE_CF_HOSTNAME=<host>     the quick tunnel's host (default: random words + .trycloudflare.com)
//   FAKE_CF_DOWN_FILE=<file>    while this file exists, /ready answers 503 (the edge dropped it)
//   FAKE_CF_INGRESS=<service>   the named tunnel's first ingress service (default http_status:503)
//   FAKE_CF_INGRESS_AFTER_MS=<n> /config answers {"version":0,"config":{}} (nothing pushed yet) until that long after connecting
// A token in argv (--token, or a word shaped like one) is a leak: it logs "token-in-argv" and exits 2.
// It logs "token-env yes|no" (whether TUNNEL_TOKEN is set; never its value).
// SIGTERM / SIGINT: exit 0.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  if (i !== -1) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
};
const log = (line) => {
  if (process.env.FAKE_CF_LOG) appendFileSync(process.env.FAKE_CF_LOG, `${line}\n`);
};

if (argv[0] === "--version" || argv[0] === "version") {
  console.log("cloudflared version 2026.10.7 (built fake)");
  process.exit(0);
}

if (argv.some((a) => a === "--token" || a.startsWith("--token=") || /^eyJ[A-Za-z0-9_-]{20,}/.test(a))) {
  log(`token-in-argv ${process.pid}`);
  process.exit(2);
}
log(`start ${process.pid} ${argv.join(" ")}`);
log(`token-env ${process.env.TUNNEL_TOKEN ? "yes" : "no"}`);
if (process.env.FAKE_CF_FAIL === "start") {
  console.error("ERR fake cloudflared: failed to start (FAKE_CF_FAIL=start)");
  log(`exit ${process.pid} fail-start`);
  process.exit(1);
}

const metrics = opt("--metrics");
const pidfile = opt("--pidfile");
const quick = opt("--url") !== undefined;
const words = ["amber", "brook", "cedar", "delta", "ember", "fjord", "grove", "harbor", "iris", "juniper"];
const pick = () => words[randomBytes(1)[0] % words.length];
const hostname = process.env.FAKE_CF_HOSTNAME || `${pick()}-${pick()}-${pick()}-${randomBytes(3).toString("hex")}.trycloudflare.com`;
const connectorId = randomBytes(16).toString("hex");
let connected = false;
let connectedAt = 0;

const [host, port] = (metrics ?? "127.0.0.1:0").split(":");
const server = createServer((req, res) => {
  log(`${process.pid} ${req.url}`);
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const down = !connected || (process.env.FAKE_CF_DOWN_FILE && existsSync(process.env.FAKE_CF_DOWN_FILE));
  if (req.url === "/ready") return down ? send(503, { status: 503, readyConnections: 0, connectorId }) : send(200, { status: 200, readyConnections: 4, connectorId });
  if (req.url === "/quicktunnel" && quick) return send(200, { hostname });
  if (req.url === "/config" && !quick && (!connectedAt || Date.now() - connectedAt < Number(process.env.FAKE_CF_INGRESS_AFTER_MS ?? 0))) return send(200, { version: 0, config: {} });
  if (req.url === "/config" && !quick) return send(200, { version: 1, config: { ingress: [{ hostname: "share.example.com", service: process.env.FAKE_CF_INGRESS || "http_status:503" }, { service: "http_status:404" }] } });
  send(404, { error: "not found" });
});
server.listen(Number(port), host, () => {
  console.error(`INF fake cloudflared metrics on ${host}:${server.address().port}${quick ? `, quick tunnel ${hostname}` : ""}`);
});

const end = (code, how) => {
  log(`exit ${process.pid} ${how}`);
  server.close();
  process.exit(code);
};
process.on("SIGTERM", () => end(0, "SIGTERM"));
process.on("SIGINT", () => end(0, "SIGINT"));

if (process.env.FAKE_CF_NEVER_CONNECT !== "1") {
  setTimeout(() => {
    connected = true;
    connectedAt = Date.now();
    console.error(`INF Registered tunnel connection connIndex=0 connection=${connectorId}`);
    if (pidfile) writeFileSync(pidfile, `${process.pid}\n`);
    const die = Number(process.env.FAKE_CF_DIE_MS);
    if (die > 0) setTimeout(() => end(1, "die"), die);
  }, Number(process.env.FAKE_CF_CONNECT_MS ?? 50));
}
