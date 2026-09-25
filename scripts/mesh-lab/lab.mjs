#!/usr/bin/env node
// Sova mesh lab CLI. See scripts/mesh-lab/README.md. No dependencies beyond node and docker.
//
// Everything the lab creates carries the compose project name `sovamesh` (containers
// sovamesh-*, network sovamesh_lab, volumes sovamesh_*) or the image tags sovamesh-*:lab, and
// `lab destroy` removes all of it. It never touches another container, network or volume, and
// never the laptop's own tailscaled: every tailscale call below is a `docker exec` into a lab node.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureMockCerts, HOSTS_SNIPPET, hostMockEnv, hostMockVolume, mockTokenService, MOCK_LAPTOP_PORT } from "./mock-token-server/lab.mjs";

export const LAB_DIR = resolve(import.meta.dirname);
export const ROOT = resolve(LAB_DIR, "../..");
export const PROJECT = "sovamesh";
export const NETWORK = `${PROJECT}_lab`;
export const STATE = process.env.LAB_STATE || join(homedir(), ".cache/sova-mesh/lab");
export const DOMAIN = "mesh.lab";
export const IMAGES = { host: "sovamesh-host:lab", plain: "sovamesh-plain:lab" };
const PULLED = { headscale: "headscale/headscale:v0.29.4", caddy: "caddy:2-alpine" };
const AUTH_SRC = join(ROOT, ".agent/auth.json");
const HOST_IDS = "abcdefgh".split("");
/** Laptop ports, loopback only: front door 4890, hosts a..h 4891..4898, plain 4899. */
export const PORTS = { frontdoor: 4890, plain: 4899, host: (id) => 4891 + HOST_IDS.indexOf(id) };
export const SOVA_PORT = 4800; // main listener inside each host (loopback)
export const SERVE_PORT = 8443; // `tailscale serve --http` of the main listener on the tailnet
export const PEER_PORT = 4801; // mesh-core's peer listener default

/** Every lab container resolves through public DNS, not the laptop's resolver (which answers the
 *  real tailnet's MagicDNS names), and inherits no search domain from the laptop. */
const DNS = { dns: ["1.1.1.1", "9.9.9.9"], dns_search: ["."] };

/** The lab CA certificate, trusted by every lab node (system store + NODE_EXTRA_CA_CERTS). */
const CA_MOUNT = `${join(STATE, "tls/ca.pem")}:/run/lab-tls/ca.pem:ro`;

const DEFAULTS = { hosts: ["a", "b", "c"], plain: true, stranger: true, frontdoor: true, mock: true, auth: "all", seed: true, order: null };
const MOCK_DIR = () => join(STATE, "mock-token");

// ---------------------------------------------------------------------------------------------
// small process helpers

function run(cmd, args, { input, allowFail = false, quiet = false, inherit = false } = {}) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"], maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    const msg = `${cmd} ${args.join(" ")} -> exit ${r.status}\n${inherit ? "" : (r.stderr || r.stdout || "").trim()}`;
    if (!quiet) console.error(msg);
    throw new Error(msg);
  }
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const docker = (args, opts) => run("docker", args, opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// lab config (STATE/lab.json) and name mapping

export function loadConfig() {
  const p = join(STATE, "lab.json");
  if (!existsSync(p)) return null;
  return { ...DEFAULTS, ...JSON.parse(readFileSync(p, "utf8")) };
}
function saveConfig(cfg) {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(join(STATE, "lab.json"), JSON.stringify(cfg, null, 2) + "\n");
}
function requireConfig() {
  const cfg = loadConfig();
  if (!cfg) die("no lab configured yet: run `lab up` first");
  return cfg;
}

/** Every lab node that runs tailscaled. */
export function tailnetNodes(cfg) {
  return [...cfg.hosts, ...(cfg.stranger ? ["stranger"] : []), ...(cfg.frontdoor ? ["frontdoor"] : [])];
}
/** Every node that runs Sova. */
export function sovaNodes(cfg) {
  return [...cfg.hosts, ...(cfg.plain ? ["plain"] : [])];
}
export const container = (name) => `${PROJECT}-${name}`;

function die(msg) {
  console.error(`lab: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// compose generation (JSON is valid YAML; compose reads it as-is)

function hostService(cfg, id) {
  const auth = cfg.auth === "all" || (Array.isArray(cfg.auth) && cfg.auth.includes(id));
  const volumes = [
    `${id}-agent:/sova/.agent`,
    `${id}-home:/root`,
    `${id}-ts:/var/lib/tailscale`,
    `${join(STATE, "secrets/authkey")}:/run/lab-secrets/authkey:ro`,
    CA_MOUNT,
  ];
  if (auth) volumes.push(`${AUTH_SRC}:/run/lab-secrets/auth.json:ro`);
  // sync-engineer's mock token server (M3): its CA, the /etc/hosts redirect of pi's fixed provider
  // names, the Claude store simulator's dir. NODE_EXTRA_CA_CERTS then points at a bundle of both
  // lab CAs, built by the entrypoint.
  const mock = cfg.mock
    ? { env: { ...hostMockEnv({ mockContainer: container("mocktoken") }), NODE_EXTRA_CA_CERTS: "/run/lab/ca-bundle.pem" }, volumes: [hostMockVolume(MOCK_DIR()), `${join(STATE, "mock-hosts.sh")}:/run/lab-mock/hosts.sh:ro`] }
    : { env: {}, volumes: [] };
  volumes.push(...mock.volumes);
  return {
    image: IMAGES.host,
    container_name: container(id),
    hostname: id,
    cap_add: ["NET_ADMIN"],
    devices: ["/dev/net/tun:/dev/net/tun"],
    ...DNS,
    environment: {
      LAB_HOST: id,
      LAB_TAILSCALE: "1",
      LAB_SOVA: "1",
      LAB_SEED: cfg.seed ? "1" : "0",
      LAB_LOGIN_SERVER: "https://headscale",
      LAB_SERVE_PORT: String(SERVE_PORT),
      PORT: String(SOVA_PORT),
      HOST: "127.0.0.1",
      NODE_EXTRA_CA_CERTS: "/run/lab/ca-bundle.pem",
      ...mock.env,
    },
    volumes,
    ports: HOST_IDS.includes(id) ? [`127.0.0.1:${PORTS.host(id)}:4900`] : [],
    networks: ["lab"],
    depends_on: ["headscale", ...(cfg.mock ? ["mocktoken"] : [])],
    labels: { "sova.mesh-lab": "1", "sova.mesh-lab.role": "host" },
  };
}

function tailnetOnly(name) {
  return {
    image: IMAGES.host,
    container_name: container(name),
    hostname: name,
    cap_add: ["NET_ADMIN"],
    devices: ["/dev/net/tun:/dev/net/tun"],
    ...DNS,
    environment: { LAB_HOST: name, LAB_TAILSCALE: "1", LAB_SOVA: "0", LAB_LOGIN_SERVER: "https://headscale" },
    volumes: [`${name}-ts:/var/lib/tailscale`, `${join(STATE, "secrets/authkey")}:/run/lab-secrets/authkey:ro`, CA_MOUNT],
    networks: ["lab"],
    depends_on: ["headscale"],
    labels: { "sova.mesh-lab": "1", "sova.mesh-lab.role": name },
  };
}

export function composeFor(cfg) {
  const services = {
    headscale: {
      image: PULLED.headscale,
      container_name: container("headscale"),
      hostname: "headscale",
      ...DNS,
      command: ["serve"],
      volumes: [`${join(LAB_DIR, "headscale/config.yaml")}:/etc/headscale/config.yaml:ro`, `${join(STATE, "tls/headscale.pem")}:/etc/headscale/tls/headscale.pem:ro`, `${join(STATE, "tls/headscale-key.pem")}:/etc/headscale/tls/headscale-key.pem:ro`, "headscale-data:/var/lib/headscale"],
      networks: ["lab"],
      labels: { "sova.mesh-lab": "1", "sova.mesh-lab.role": "headscale" },
    },
  };
  const volumes = { "headscale-data": {} };
  for (const id of cfg.hosts) {
    services[id] = hostService(cfg, id);
    for (const v of ["agent", "home", "ts"]) volumes[`${id}-${v}`] = {};
  }
  if (cfg.plain) {
    const auth = cfg.auth === "all" || (Array.isArray(cfg.auth) && cfg.auth.includes("plain"));
    services.plain = {
      image: IMAGES.plain,
      container_name: container("plain"),
      hostname: "plain",
      // NET_ADMIN only for the entrypoint's egress guard; Sova runs with it dropped. No tun device.
      cap_add: ["NET_ADMIN"],
      ...DNS,
      environment: { LAB_HOST: "plain", LAB_TAILSCALE: "0", LAB_SOVA: "1", LAB_SEED: cfg.seed ? "1" : "0", PORT: String(SOVA_PORT), HOST: "127.0.0.1", NODE_EXTRA_CA_CERTS: "/run/lab-tls/ca.pem" },
      volumes: ["plain-agent:/sova/.agent", "plain-home:/root", CA_MOUNT, ...(auth ? [`${AUTH_SRC}:/run/lab-secrets/auth.json:ro`] : [])],
      ports: [`127.0.0.1:${PORTS.plain}:4900`],
      networks: ["lab"],
      labels: { "sova.mesh-lab": "1", "sova.mesh-lab.role": "plain" },
    };
    volumes["plain-agent"] = {};
    volumes["plain-home"] = {};
  }
  if (cfg.mock) {
    const svc = mockTokenService({ image: IMAGES.plain, containerName: container("mocktoken"), certDir: MOCK_DIR() });
    // the lab image's ENV HOST=127.0.0.1 is for Sova; the mock must answer the lab network
    services.mocktoken = { ...svc, ...DNS, environment: { ...svc.environment, HOST: "0.0.0.0" } };
  }
  if (cfg.stranger) {
    services.stranger = tailnetOnly("stranger");
    volumes["stranger-ts"] = {};
  }
  if (cfg.frontdoor) {
    services.frontdoor = { ...tailnetOnly("frontdoor"), ports: [`127.0.0.1:${PORTS.frontdoor}:80`] };
    volumes["frontdoor-ts"] = {};
    services.caddy = {
      image: PULLED.caddy,
      container_name: container("caddy"),
      network_mode: "service:frontdoor",
      volumes: [`${join(STATE, "caddy")}:/etc/caddy:ro`],
      depends_on: ["frontdoor"],
      labels: { "sova.mesh-lab": "1", "sova.mesh-lab.role": "caddy" },
    };
  }
  return { name: PROJECT, services, volumes, networks: { lab: { name: NETWORK, labels: { "sova.mesh-lab": "1" } } } };
}

function writeCompose(cfg) {
  mkdirSync(STATE, { recursive: true });
  const p = join(STATE, "compose.json");
  writeFileSync(p, JSON.stringify(composeFor(cfg), null, 2) + "\n");
  return p;
}
const compose = (args, opts) => docker(["compose", "-p", PROJECT, "-f", join(STATE, "compose.json"), ...args], opts);

// ---------------------------------------------------------------------------------------------
// headscale, tailscale, sova probes

const hs = (args, opts) => docker(["exec", container("headscale"), "headscale", ...args], opts);

async function waitHeadscale(timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (hs(["users", "list", "-o", "json"], { allowFail: true, quiet: true }).code === 0) return;
    await sleep(500);
  }
  throw new Error("headscale did not come up (lab logs headscale)");
}

/** The reusable pre-auth key lives in STATE/secrets/authkey (0600), minted once per Headscale DB.
 *  The DB and the key file are only ever deleted together (`lab reset` / `lab destroy`). */
function ensureAuthKey() {
  const dir = join(STATE, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = join(dir, "authkey");
  if (existsSync(keyFile) && readFileSync(keyFile, "utf8").trim()) return;
  const listUsers = () => JSON.parse(hs(["users", "list", "-o", "json"]).out || "[]") || [];
  if (!listUsers().some((u) => u.name === "lab")) hs(["users", "create", "lab"]);
  const user = listUsers().find((u) => u.name === "lab");
  const out = hs(["preauthkeys", "create", "--user", String(user.id), "--reusable", "--expiration", "8760h", "-o", "json"]).out;
  const key = JSON.parse(out).key;
  if (!key) throw new Error("headscale returned no pre-auth key");
  writeFileSync(keyFile + ".tmp", key + "\n", { mode: 0o600 });
  renameSync(keyFile + ".tmp", keyFile);
}

/** The lab's own CA (STATE/tls/ca.pem + ca-key.pem, 0600) and certificates it signs, made with
 *  openssl inside the lab image (nothing on the laptop needs openssl). `names` become SANs. */
export function mintCert(file, names) {
  const dir = join(STATE, "tls");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const uid = `${process.getuid()}:${process.getgid()}`;
  const mount = ["-v", `${dir}:/tls`, "-v", `${join(LAB_DIR, "host/mint-cert.sh")}:/mint-cert.sh:ro`];
  docker(["run", "--rm", "--network", "none", "--user", uid, "--entrypoint", "sh", ...mount, IMAGES.host, "/mint-cert.sh", ...(file ? [file, ...names] : [])]);
}
function ensureTls() {
  mintCert("headscale", ["headscale"]);
}

/** Forget Headscale nodes that are no longer part of the lab (after `up --hosts` shrank it), so the
 *  tailnet holds exactly the running lab's nodes. Their agent/home volumes are left for `reset`. */
function pruneNodes(cfg) {
  const want = new Set(tailnetNodes(cfg));
  const nodes = JSON.parse(hs(["nodes", "list", "-o", "json"]).out || "[]") || [];
  for (const n of nodes) {
    const name = n.given_name ?? n.name;
    if (want.has(name)) continue;
    hs(["nodes", "delete", "-i", String(n.id), "--force"], { allowFail: true });
    // its tailscale state now names a deleted node: drop it, so a later `up --hosts` joins afresh
    docker(["volume", "rm", `${PROJECT}_${name}-ts`], { allowFail: true, quiet: true });
    console.log(`headscale: removed node ${name} (no longer in the lab)`);
  }
}

export function tsStatus(name) {
  const r = docker(["exec", container(name), "tailscale", "status", "--json"], { allowFail: true, quiet: true });
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

export function sovaHealthy(name) {
  return docker(["exec", container(name), "curl", "-sf", "-m", "2", `http://127.0.0.1:${SOVA_PORT}/api/health`], { allowFail: true, quiet: true }).code === 0;
}

export function containerState(name) {
  const r = docker(["inspect", "-f", "{{.State.Status}}", container(name)], { allowFail: true, quiet: true });
  return r.code === 0 ? r.out : "absent";
}

async function waitReady(cfg, timeoutMs = 240000) {
  const end = Date.now() + timeoutMs;
  const pending = new Set([...tailnetNodes(cfg).map((n) => `ts:${n}`), ...sovaNodes(cfg).map((n) => `sova:${n}`)]);
  while (pending.size && Date.now() < end) {
    for (const p of [...pending]) {
      const [kind, n] = p.split(":");
      const ok = kind === "ts" ? tsStatus(n)?.BackendState === "Running" && (tsStatus(n)?.Self?.TailscaleIPs?.length ?? 0) > 0 : sovaHealthy(n);
      if (ok) pending.delete(p);
    }
    if (pending.size) await sleep(1000);
  }
  if (pending.size) throw new Error(`not ready after ${timeoutMs / 1000}s: ${[...pending].join(", ")} (lab status / lab logs <name>)`);
}

// ---------------------------------------------------------------------------------------------
// front door (Caddy)

export function writeCaddyfile(cfg) {
  const order = (cfg.order && cfg.order.length ? cfg.order : cfg.hosts).filter((h) => cfg.hosts.includes(h));
  // MagicDNS names, not IPs: each upstream is the host's `tailscale serve`, which routes by Host
  // header, so Caddy must also send the upstream's own name as Host (header_up below).
  const upstreams = order.map((h) => `${h}.${DOMAIN}:${SERVE_PORT}`);
  const text = `# generated by scripts/mesh-lab/lab — order: ${order.join(", ")}
{
\tadmin localhost:2019
\tauto_https off
}

:80 {
\treverse_proxy ${upstreams.join(" ")} {
\t\tlb_policy first
\t\tlb_try_duration 6s
\t\tlb_try_interval 250ms
\t\t# same tolerances as Sova's generated file: one stalled connect must not bench a healthy host
\t\tmax_fails 3
\t\tfail_duration 3s
\t\thealth_uri /api/health
\t\thealth_interval 1s
\t\thealth_timeout 2500ms
\t\thealth_fails 2
\t\thealth_passes 2
\t\tflush_interval -1
\t\theader_up Host {upstream_hostport}
\t\t# as Sova's generated file: reuse upstream connections, bound the dial, bound a request written
\t\t# into a dead host's pooled connection by the header timeout, names through MagicDNS
\t\ttransport http {
\t\t\tdial_timeout 2s
\t\t\tkeepalive 30s
\t\t\tresponse_header_timeout 35s
\t\t\tresolvers 100.100.100.100
\t\t}
\t\theader_down X-Lab-Upstream {upstream_hostport}
\t}
}
`;
  const dir = join(STATE, "caddy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Caddyfile.tmp"), text);
  renameSync(join(dir, "Caddyfile.tmp"), join(dir, "Caddyfile"));
  return { order, upstreams };
}

/** host-local HTTP to a lab host's main listener (from inside the container). */
function hostApi(n, method, path, body) {
  const argv = ["exec", ...(body !== undefined ? ["-i"] : []), container(n), "curl", "-sS", "-m", "5", "-X", method, "-w", "\n%{http_code}"];
  if (body !== undefined) argv.push("-H", "content-type: application/json", "--data-binary", "@-");
  argv.push(`http://127.0.0.1:${SOVA_PORT}${path}`);
  const r = docker(argv, { input: body === undefined ? undefined : JSON.stringify(body), allowFail: true, quiet: true });
  const nl = r.out.lastIndexOf("\n");
  let json = null;
  try {
    json = JSON.parse(r.out.slice(0, nl));
  } catch {}
  return { status: Number(r.out.slice(nl + 1)) || 0, json };
}

/**
 * The Caddyfile Sova itself generates (GET /api/mesh/front-door on `from`), after setting the order
 * there (PUT /api/mesh/settings {frontDoorOrder}). null when that host's Sova has no generator.
 */
function sovaCaddyfile(cfg, from, order, soft) {
  if (order) {
    const r = hostApi(from, "PUT", "/api/mesh/settings", { frontDoorOrder: order });
    if (r.status !== 200) {
      const msg = `${from}: PUT /api/mesh/settings frontDoorOrder -> ${r.status} ${JSON.stringify(r.json)}`;
      // `up` on a fresh (unpaired) lab: Sova refuses an order of hosts that aren't its peers yet
      if (soft) return console.error(`${msg}; using the lab's template until \`lab pair\` + \`lab frontdoor order\``), null;
      die(msg);
    }
  }
  const r = hostApi(from, "GET", "/api/mesh/front-door");
  return r.status === 200 && typeof r.json?.caddyfile === "string" ? r.json.caddyfile : null;
}

/** Put the front door's Caddyfile in place and reload: Sova's own when it has one, else the lab's. */
export function syncFrontDoor(cfg, { order, from = cfg.hosts[0], lab: forceLab = false, soft = false } = {}) {
  const text = forceLab ? null : sovaCaddyfile(cfg, from, order, soft);
  let source;
  if (text) {
    const dir = join(STATE, "caddy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Caddyfile.tmp"), text);
    renameSync(join(dir, "Caddyfile.tmp"), join(dir, "Caddyfile"));
    source = `Sova on ${from} (GET /api/mesh/front-door)`;
  } else {
    writeCaddyfile({ ...cfg, order: order ?? cfg.order });
    source = "the lab's own template";
  }
  const r = reloadCaddy();
  if (r.code !== 0) console.error(`caddy reload failed: ${r.err || r.out}`);
  const upstreams = /reverse_proxy ([^{]+)\{/.exec(readFileSync(join(STATE, "caddy/Caddyfile"), "utf8"))?.[1].trim().split(/\s+/) ?? [];
  return { source, upstreams };
}

function reloadCaddy() {
  return docker(["exec", container("caddy"), "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"], { allowFail: true });
}

// ---------------------------------------------------------------------------------------------
// commands

function parseUpArgs(args, cfg) {
  const next = { ...cfg };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => args[++i] ?? die(`${a} needs a value`);
    if (a === "--hosts") {
      const v = val();
      next.hosts = /^\d+$/.test(v) ? HOST_IDS.slice(0, Number(v)) : v.split(",").filter(Boolean);
      if (!next.hosts.length || next.hosts.some((h) => !HOST_IDS.includes(h))) die(`--hosts: 1..8, or ids from ${HOST_IDS.join(",")}`);
    } else if (a === "--auth") {
      const v = val();
      next.auth = v === "all" || v === "none" ? v : v.split(",");
    } else if (a === "--plain") next.plain = true;
    else if (a === "--no-plain") next.plain = false;
    else if (a === "--stranger") next.stranger = true;
    else if (a === "--no-stranger") next.stranger = false;
    else if (a === "--frontdoor") next.frontdoor = true;
    else if (a === "--no-frontdoor") next.frontdoor = false;
    else if (a === "--mock") next.mock = true;
    else if (a === "--no-mock") next.mock = false;
    else if (a === "--seed") next.seed = true;
    else if (a === "--no-seed") next.seed = false;
    else if (a === "--no-build") next._noBuild = true;
    else if (a === "--dirty") next._dirty = true;
    else if (a === "--rev") next._rev = val();
    else die(`unknown option ${a}`);
  }
  return next;
}

const git = (...a) => run("git", ["-C", ROOT, ...a]).out;
/** Paths whose uncommitted state changes what a lab host runs (the acceptance-relevant tree). */
const PROVENANCE_PATHS = ["server", "shared", "src", "pi-config", "scripts/hermetic-agent-dir.mjs", "scripts/mesh-lab", "package.json", "pnpm-lock.yaml", "index.html", "vite.config.ts", "public"];

/**
 * Build the two images. Default: the Sova tree is `git archive <rev>` (HEAD unless --rev), so a
 * run names one commit and uncommitted edits never reach a host. --dirty builds the working tree
 * instead (what's on disk, commit + the dirty paths recorded). The lab's own build files
 * (Dockerfile, host/) always come from the working tree's scripts/mesh-lab. The provenance lands
 * in every container as /sova/BUILD_COMMIT and on the images as labels.
 */
function build({ rev = "HEAD", dirty = false } = {}) {
  const commit = git("rev-parse", "--verify", `${rev}^{commit}`);
  const dirtyPaths = dirty ? git("status", "--porcelain", "--", ...PROVENANCE_PATHS).split("\n").filter(Boolean) : [];
  const labDirty = git("status", "--porcelain", "--", "scripts/mesh-lab").split("\n").filter(Boolean);
  let ctx = ROOT;
  if (!dirty) {
    ctx = join(STATE, "build-ctx");
    rmSync(ctx, { recursive: true, force: true });
    mkdirSync(ctx, { recursive: true });
    const tar = spawnSync("sh", ["-c", `git -C "$1" archive "$2" | tar -x -C "$3"`, "-", ROOT, commit, ctx], { stdio: "inherit" });
    if (tar.status !== 0) throw new Error(`git archive ${commit} failed`);
    // the lab's build files from the working tree (a commit from before the lab has none)
    for (const f of ["Dockerfile", "Dockerfile.dockerignore", "host"]) {
      rmSync(join(ctx, "scripts/mesh-lab", f), { recursive: true, force: true });
      mkdirSync(join(ctx, "scripts/mesh-lab"), { recursive: true });
      run("cp", ["-r", join(LAB_DIR, f), join(ctx, "scripts/mesh-lab", f)]);
    }
  }
  const provenance = {
    commit,
    rev,
    source: dirty ? "working tree" : "git archive",
    dirty: dirtyPaths,
    labBuildFiles: labDirty.length ? `working tree, uncommitted: ${labDirty.join("; ")}` : "working tree, clean",
    builtAt: new Date().toISOString(),
  };
  console.log(`building ${IMAGES.plain} and ${IMAGES.host} from ${provenance.source} at ${commit.slice(0, 12)}${dirtyPaths.length ? ` + ${dirtyPaths.length} dirty path(s)` : ""}`);
  const common = [
    "build", "-f", join(ctx, "scripts/mesh-lab/Dockerfile"),
    "--label", "sova.mesh-lab=1",
    "--label", `sova.mesh-lab.commit=${commit}`,
    "--label", `sova.mesh-lab.dirty=${dirtyPaths.length}`,
    "--build-arg", `LAB_PROVENANCE=${JSON.stringify(provenance)}`,
  ];
  try {
    docker([...common, "--target", "plain", "-t", IMAGES.plain, ctx], { inherit: true });
    docker([...common, "--target", "host", "-t", IMAGES.host, ctx], { inherit: true });
  } finally {
    if (ctx !== ROOT) rmSync(ctx, { recursive: true, force: true });
  }
  return provenance;
}

/** What each running Sova container was built from (its /sova/BUILD_COMMIT). */
export function provenanceOf(name) {
  const r = docker(["exec", container(name), "cat", "/sova/BUILD_COMMIT"], { allowFail: true, quiet: true });
  try {
    return r.code === 0 ? JSON.parse(r.out) : null;
  } catch {
    return null;
  }
}
export function provenanceLine(cfg) {
  const seen = new Map();
  for (const n of sovaNodes(cfg)) {
    const p = provenanceOf(n);
    const key = p ? `${p.commit.slice(0, 12)} (${p.source}${p.dirty.length ? `, DIRTY: ${p.dirty.length} path(s)` : ", clean"})` : "unknown (image predates provenance)";
    seen.set(key, [...(seen.get(key) ?? []), n]);
  }
  return [...seen].map(([k, ns]) => (seen.size > 1 ? `${k} on ${ns.join(",")}` : k)).join("; ");
}

async function cmdUp(args) {
  const cfg = parseUpArgs(args, loadConfig() || DEFAULTS);
  const { _noBuild: noBuild, _dirty: dirty, _rev: rev } = cfg;
  delete cfg._noBuild;
  delete cfg._dirty;
  delete cfg._rev;
  if (dirty && rev) die("--dirty builds the working tree; it cannot be combined with --rev");
  if (!existsSync(AUTH_SRC) && cfg.auth !== "none") die(`${AUTH_SRC} missing: build it (scripts/hermetic-agent-dir.mjs + the API-key auth.json) or use --auth none`);
  saveConfig(cfg);
  if (!noBuild) build({ rev: rev ?? "HEAD", dirty: !!dirty });
  mkdirSync(join(STATE, "secrets"), { recursive: true, mode: 0o700 });
  const keyFile = join(STATE, "secrets/authkey");
  if (!existsSync(keyFile)) writeFileSync(keyFile, "", { mode: 0o600 }); // bind-mount target must exist
  ensureTls();
  if (cfg.mock) {
    ensureMockCerts(STATE);
    writeFileSync(join(STATE, "mock-hosts.sh"), HOSTS_SNIPPET);
  }
  if (cfg.frontdoor && !existsSync(join(STATE, "caddy/Caddyfile"))) writeCaddyfile({ ...cfg, hosts: [] });
  writeCompose(cfg);
  compose(["up", "-d", "--remove-orphans", "headscale"], { inherit: true });
  await waitHeadscale();
  ensureAuthKey();
  compose(["up", "-d", "--remove-orphans"], { inherit: true });
  console.log("waiting for tailnet + sova health …");
  await waitReady(cfg);
  pruneNodes(cfg);
  if (cfg.frontdoor) {
    const { source, upstreams } = syncFrontDoor(cfg, { order: cfg.order ?? undefined, lab: cfg.frontdoorSource === "lab", soft: true });
    console.log(`front door: http://127.0.0.1:${PORTS.frontdoor}/ ${upstreams.join(" > ")} (from ${source})`);
  }
  cmdStatus([]);
}

function cmdDown() {
  if (!existsSync(join(STATE, "compose.json"))) return console.log("nothing to stop");
  compose(["down", "--remove-orphans"], { inherit: true });
}

/** Stop everything and delete every lab volume and secret; keeps lab.json and the built images. */
function wipe() {
  if (existsSync(join(STATE, "compose.json"))) compose(["down", "-v", "--remove-orphans"], { inherit: true });
  // volumes left by an older lab shape (e.g. a host dropped from --hosts) are not in compose.json
  const vols = docker(["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${PROJECT}`]).out.split("\n").filter(Boolean);
  if (vols.length) docker(["volume", "rm", ...vols], { allowFail: true });
  rmSync(join(STATE, "secrets"), { recursive: true, force: true });
  rmSync(join(STATE, "caddy"), { recursive: true, force: true });
  rmSync(join(STATE, "tls"), { recursive: true, force: true });
  rmSync(MOCK_DIR(), { recursive: true, force: true });
}

async function cmdReset(args) {
  wipe();
  await cmdUp(args);
}

function cmdDestroy(args) {
  wipe();
  const leftovers = docker(["ps", "-aq", "--filter", "label=sova.mesh-lab=1"]).out.split("\n").filter(Boolean);
  if (leftovers.length) docker(["rm", "-f", ...leftovers], { allowFail: true });
  docker(["network", "rm", NETWORK], { allowFail: true, quiet: true });
  for (const img of Object.values(IMAGES)) docker(["image", "rm", "-f", img], { allowFail: true, quiet: true });
  docker(["image", "prune", "-f", "--filter", "label=sova.mesh-lab=1"], { allowFail: true, quiet: true });
  if (args.includes("--pulled")) for (const img of Object.values(PULLED)) docker(["image", "rm", img], { allowFail: true, quiet: true });
  rmSync(STATE, { recursive: true, force: true });
  console.log("lab destroyed: containers, volumes, network, built images and state removed" + (args.includes("--pulled") ? ", pulled images too" : ""));
}

export function statusRows(cfg) {
  const rows = [];
  const names = ["headscale", ...cfg.hosts, ...(cfg.plain ? ["plain"] : []), ...(cfg.stranger ? ["stranger"] : []), ...(cfg.frontdoor ? ["frontdoor", "caddy"] : []), ...(cfg.mock ? ["mocktoken"] : [])];
  for (const n of names) {
    const state = containerState(n);
    const row = { name: n, container: container(n), state };
    if (state === "running" && tailnetNodes(cfg).includes(n)) {
      const st = tsStatus(n);
      row.tailnet = st?.BackendState ?? "?";
      row.ip = st?.Self?.TailscaleIPs?.find((a) => a.includes(".")) ?? null;
      row.dns = st?.Self?.DNSName?.replace(/\.$/, "") ?? null;
      row.nodeId = st?.Self?.ID ?? null;
      row.peersOnline = st ? Object.values(st.Peer || {}).filter((p) => p.Online).length : 0;
      row.partitioned = isPartitioned(n);
    }
    if (state === "running" && sovaNodes(cfg).includes(n)) {
      row.sova = sovaHealthy(n) ? "up" : "down";
      row.url = `http://127.0.0.1:${n === "plain" ? PORTS.plain : PORTS.host(n)}/`;
    }
    if (n === "frontdoor") row.url = `http://127.0.0.1:${PORTS.frontdoor}/`;
    if (n === "mocktoken") row.url = `http://127.0.0.1:${MOCK_LAPTOP_PORT}/mock/lineages`;
    rows.push(row);
  }
  return rows;
}

function cmdStatus(args) {
  const cfg = loadConfig();
  if (!cfg) return console.log("no lab configured (lab up)");
  const rows = statusRows(cfg);
  if (args.includes("--json")) return console.log(JSON.stringify({ config: cfg, provenance: Object.fromEntries(sovaNodes(cfg).map((n) => [n, provenanceOf(n)])), rows }, null, 2));
  console.log(`built from: ${provenanceLine(cfg)}`);
  const cols = ["name", "state", "tailnet", "ip", "dns", "peersOnline", "partitioned", "sova", "url"];
  const table = [cols, ...rows.map((r) => cols.map((c) => (r[c] === undefined || r[c] === null ? "-" : String(r[c]))))];
  const w = cols.map((_, i) => Math.max(...table.map((r) => r[i].length)));
  for (const r of table) console.log(r.map((v, i) => v.padEnd(w[i])).join("  "));
}

// ---- chaos

const CHAIN_IN = "LAB-PART-IN";
const CHAIN_OUT = "LAB-PART-OUT";
function isPartitioned(n) {
  return docker(["exec", container(n), "iptables", "-S", CHAIN_IN], { allowFail: true, quiet: true }).code === 0;
}
/** Partition a tailnet node from the lab network, with iptables in its own netns (every tailnet
 *  node has NET_ADMIN). Default: drop the lab subnet only — the tailnet, Headscale, the other
 *  containers — and keep internet egress and the laptop's published port, so the host stays usable
 *  on its own, like a laptop on a plane. Silent drops are what a real partition looks like: peers
 *  time out, and Headscale keeps showing the node Online until its map stream times out (minutes).
 *  --reject answers with RST/ICMP instead (peers fail fast, Headscale notices within a keepalive);
 *  --full cuts the internet too. */
function partition(n, { full = false, reject = false } = {}) {
  const c = container(n);
  if (isPartitioned(n)) return console.log(`${n} already partitioned`);
  const subnet = docker(["network", "inspect", NETWORK, "-f", "{{(index .IPAM.Config 0).Subnet}}"]).out;
  const gw = docker(["network", "inspect", NETWORK, "-f", "{{(index .IPAM.Config 0).Gateway}}"]).out;
  const ipt = (...a) => docker(["exec", c, "iptables", ...a]);
  const published = n === "frontdoor" ? "80" : "4900";
  ipt("-N", CHAIN_IN);
  ipt("-N", CHAIN_OUT);
  ipt("-A", CHAIN_IN, "-i", "lo", "-j", "RETURN");
  ipt("-A", CHAIN_OUT, "-o", "lo", "-j", "RETURN");
  // the laptop's published port: docker-proxy connects from the bridge gateway
  ipt("-A", CHAIN_IN, "-p", "tcp", "-s", gw, "--dport", published, "-j", "RETURN");
  ipt("-A", CHAIN_OUT, "-p", "tcp", "-d", gw, "--sport", published, "-j", "RETURN");
  const match = (dir) => (full ? [] : [dir === "in" ? "-s" : "-d", subnet]);
  if (reject) {
    ipt("-A", CHAIN_IN, ...match("in"), "-p", "tcp", "-j", "REJECT", "--reject-with", "tcp-reset");
    ipt("-A", CHAIN_IN, ...match("in"), "-j", "REJECT");
    // the RSTs REJECT itself emits leave through OUTPUT: let them out, or nothing is ever reset
    ipt("-A", CHAIN_OUT, ...match("out"), "-p", "tcp", "--tcp-flags", "RST", "RST", "-j", "RETURN");
    ipt("-A", CHAIN_OUT, ...match("out"), "-j", "REJECT");
  } else {
    ipt("-A", CHAIN_IN, ...match("in"), "-j", "DROP");
    ipt("-A", CHAIN_OUT, ...match("out"), "-j", "DROP");
  }
  ipt("-I", "INPUT", "1", "-j", CHAIN_IN);
  ipt("-I", "OUTPUT", "1", "-j", CHAIN_OUT);
  console.log(`${n} partitioned (${full ? "all traffic" : `lab subnet ${subnet}`} ${reject ? "rejected" : "dropped"})`);
}
function restore(n) {
  const c = container(n);
  if (!isPartitioned(n)) return console.log(`${n} is not partitioned`);
  const ipt = (...a) => docker(["exec", c, "iptables", ...a], { allowFail: true, quiet: true });
  ipt("-D", "INPUT", "-j", CHAIN_IN);
  ipt("-D", "OUTPUT", "-j", CHAIN_OUT);
  for (const ch of [CHAIN_IN, CHAIN_OUT]) {
    ipt("-F", ch);
    ipt("-X", ch);
  }
  console.log(`${n} restored`);
}

function needNode(cfg, n, kinds = ["any"]) {
  const all = ["headscale", ...cfg.hosts, "plain", "stranger", "frontdoor", "caddy", "mocktoken"];
  if (!n) die("which node? " + all.join(", "));
  if (kinds.includes("tailnet") && !tailnetNodes(cfg).includes(n)) die(`${n} is not a tailnet node (${tailnetNodes(cfg).join(", ")})`);
  if (kinds.includes("sova") && !sovaNodes(cfg).includes(n)) die(`${n} does not run Sova (${sovaNodes(cfg).join(", ")})`);
  if (!all.includes(n)) die(`unknown node ${n}`);
  return n;
}

async function waitSova(n, up, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (sovaHealthy(n) === up) return true;
    await sleep(500);
  }
  return false;
}

// ---- pairing (peers.json) — mesh-core's format (server/mesh/peers.ts validatePeers): peers are
// authenticated by nodeId (the Tailscale StableID; a decimal string on Headscale) alone; dnsName is
// where the host dials (http://<dnsName>:<SOVA_PEER_PORT, 4801>). This is the one place to update
// if that format changes.

/** A host's browser-facing address on the tailnet: its `tailscale serve` (plain http in the lab). */
const serveUrl = (h) => `http://${h}.${DOMAIN}:${SERVE_PORT}`;

function peersJsonFor(cfg, self, members) {
  const peers = members
    .filter((h) => h !== self)
    .map((h, i) => {
      const st = tsStatus(h);
      if (!st?.Self?.ID) die(`${h} has no tailnet identity yet`);
      return { id: h, label: `Host ${h.toUpperCase()}`, nodeId: st.Self.ID, dnsName: `${h}.${DOMAIN}`, priority: i + 1, serveUrl: serveUrl(h) };
    });
  return { version: 1, self: { id: self, label: `Host ${self.toUpperCase()}`, serveUrl: serveUrl(self) }, peers };
}

function writeAgentFile(n, rel, content) {
  const script = `const fs=require("fs"),p=require("path");const f=p.join(process.env.PI_CODING_AGENT_DIR,process.argv[1]);
fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f+".tmp",require("fs").readFileSync(0),{mode:0o600});fs.renameSync(f+".tmp",f);`;
  docker(["exec", "-i", container(n), "node", "-e", script, rel], { input: content });
}

function restartSova(n) {
  docker(["exec", container(n), "pkill", "-f", "[s]erver/index.ts"], { allowFail: true, quiet: true });
}

async function cmdPair(args) {
  const cfg = requireConfig();
  const noRestart = args.includes("--no-restart");
  const list = args.filter((a) => !a.startsWith("--"));
  const members = list.length ? list[0].split(",") : cfg.hosts;
  for (const h of members) needNode(cfg, h, ["tailnet", "sova"]);
  for (const h of members) {
    // keep what else the file holds (sync switches, frontDoor); replace self + peers
    const cur = docker(["exec", container(h), "sh", "-c", 'cat "$PI_CODING_AGENT_DIR/sova/peers.json" 2>/dev/null || true']).out;
    let prev = {};
    try {
      prev = cur ? JSON.parse(cur) : {};
    } catch {}
    writeAgentFile(h, "sova/peers.json", JSON.stringify({ ...prev, ...peersJsonFor(cfg, h, members) }, null, 2) + "\n");
    console.log(`${h}: peers.json -> ${members.filter((m) => m !== h).join(", ")}`);
  }
  if (!noRestart) {
    for (const h of members) restartSova(h);
    for (const h of members) if (!(await waitSova(h, true))) console.error(`${h}: sova did not come back`);
  }
}

async function cmdUnpair(args) {
  const cfg = requireConfig();
  const list = args.filter((a) => !a.startsWith("--"));
  const members = list.length ? list[0].split(",") : cfg.hosts;
  for (const h of members) {
    docker(["exec", container(h), "sh", "-c", 'rm -f "$PI_CODING_AGENT_DIR/sova/peers.json"']);
    console.log(`${h}: peers.json removed`);
  }
  if (!args.includes("--no-restart")) {
    for (const h of members) restartSova(h);
    for (const h of members) await waitSova(h, true);
  }
}

// ---- dispatcher

const HELP = `usage: scripts/mesh-lab/lab <command> [args]

lifecycle
  up [--hosts N|a,b,..] [--auth all|none|a,b] [--no-plain] [--no-stranger] [--no-frontdoor]
     [--no-mock] [--no-seed] [--no-build] [--rev <rev>] [--dirty]
                                  build images from git archive <rev> (default HEAD; --dirty: the
                                  working tree as is), start/refresh the lab, wait until ready
  build [--rev <rev>] [--dirty]   build the images only
  down                            stop and remove containers (volumes kept)
  reset [up options]              wipe all lab volumes + Headscale DB + secrets, then up
  destroy [--pulled]              remove everything the lab created (containers, volumes, network,
                                  built images, state dir); --pulled also removes pulled images
  status [--json]                 per-node container / tailnet / sova state

chaos
  kill <node>                     docker kill (hard stop)       start <node>   stop <node>   restart <node>
  partition <node> [--reject] [--full]   cut the node off the lab network: silent drop (default) or
                                  fast-fail --reject; keeps internet egress unless --full
  restore <node>                  undo partition
  sova-stop <node> / sova-start <node>   stop/start only the Sova process (tailnet stays up)
  sova-restart <node>             restart the Sova process (picks up agent-dir file changes)
  sova-env <node> [K=V…|--clear]  extra SOVA_* environment for the node's Sova (/run/lab/sova.env), used
                                  from its next start (then: sova-restart <node>); no args: show it

access
  exec <node> [cmd …]             run a command (default: bash) in a node
  logs <node> [-f]                container log (Sova output for hosts)
  ts <node> <tailscale args…>     the node's own tailscale CLI
  hs <headscale args…>            the lab Headscale CLI
  ip <node> / nodeid <node> / url <node>
  curl <node> <curl args…>        curl from inside a node

mesh
  pair [a,b,c] [--no-restart]     write each listed host's peers.json listing the others, restart Sova
  unpair [a,b,c] [--no-restart]   remove peers.json (mesh off)
  frontdoor [order a,b,c] [--from h] [--sova|--lab]
                                  set the order and reload Caddy with the Caddyfile Sova generates
                                  (GET /api/mesh/front-door on h, default the first host); --lab
                                  uses the lab's own template instead (the choice persists)
  tls-cert <stem> [names…]        mint STATE/tls/<stem>.pem + -key.pem from the lab CA (every node trusts it)
  e2e <m0|m1|…|all> [node --test args]   run the milestone harness (scripts/mesh-lab/e2e/)
`;

export async function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      return console.log(HELP);
    case "up":
      return cmdUp(args);
    case "build": {
      const i = args.indexOf("--rev");
      return build({ rev: i >= 0 ? args[i + 1] : "HEAD", dirty: args.includes("--dirty") });
    }
    case "down":
      return cmdDown();
    case "reset":
      return cmdReset(args);
    case "destroy":
      return cmdDestroy(args);
    case "status":
      return cmdStatus(args);
    case "kill":
    case "start":
    case "stop":
    case "restart": {
      const cfg = requireConfig();
      const n = needNode(cfg, args[0]);
      docker([cmd, container(n)], { inherit: true });
      if (n === "frontdoor" && cmd !== "kill" && cmd !== "stop") docker(["restart", container("caddy")], { allowFail: true });
      return;
    }
    case "partition":
    case "restore": {
      const cfg = requireConfig();
      const n = needNode(cfg, args[0], ["tailnet"]);
      return cmd === "partition" ? partition(n, { full: args.includes("--full"), reject: args.includes("--reject") }) : restore(n);
    }
    case "sova-env": {
      const cfg = requireConfig();
      const n = needNode(cfg, args[0], ["sova"]);
      const c = container(n);
      const pairs = args.slice(1);
      if (pairs.length === 0) {
        const r = spawnSync("docker", ["exec", c, "cat", "/run/lab/sova.env"], { encoding: "utf8" });
        process.stdout.write(r.status === 0 ? r.stdout : `${n}: no sova.env\n`);
        return;
      }
      if (pairs[0] === "--clear") {
        docker(["exec", c, "rm", "-f", "/run/lab/sova.env"]);
        console.log(`${n}: sova.env cleared (applies from the next start: lab sova-restart ${n})`);
        return;
      }
      for (const p of pairs) if (!/^SOVA_[A-Z0-9_]+=[A-Za-z0-9._:/,@+-]*$/.test(p)) die(`sova-env: ${p}: want SOVA_NAME=value (plain characters only)`);
      const r = spawnSync("docker", ["exec", "-i", c, "sh", "-c", "umask 077 && cat > /run/lab/sova.env"], { input: pairs.join("\n") + "\n", encoding: "utf8" });
      if (r.status !== 0) die(`sova-env: writing /run/lab/sova.env on ${n} failed: ${r.stderr}`);
      console.log(`${n}: sova.env = ${pairs.map((p) => p.split("=")[0]).join(" ")} (applies from the next start: lab sova-restart ${n})`);
      return;
    }
    case "sova-stop":
    case "sova-start":
    case "sova-restart": {
      const cfg = requireConfig();
      const n = needNode(cfg, args[0], ["sova"]);
      const c = container(n);
      if (cmd === "sova-stop") {
        docker(["exec", c, "sh", "-c", "touch /run/lab/sova-off; pkill -f \"[s]erver/index.ts\"; true"]);
        console.log((await waitSova(n, false)) ? `${n}: sova stopped` : `${n}: sova still answering`);
      } else {
        if (cmd === "sova-restart") restartSova(n);
        docker(["exec", c, "rm", "-f", "/run/lab/sova-off"]);
        console.log((await waitSova(n, true)) ? `${n}: sova up` : `${n}: sova not up after 60s (lab logs ${n})`);
      }
      return;
    }
    case "exec":
    case "sh": {
      const cfg = requireConfig();
      const n = needNode(cfg, args[0]);
      const rest = args.slice(1);
      const tty = process.stdin.isTTY ? ["-it"] : ["-i"];
      const r = spawnSync("docker", ["exec", ...tty, container(n), ...(rest.length ? rest : ["bash"])], { stdio: "inherit" });
      process.exitCode = r.status ?? 1;
      return;
    }
    case "logs": {
      const cfg = requireConfig();
      const n = needNode(cfg, args[0]);
      spawnSync("docker", ["logs", ...args.slice(1), container(n)], { stdio: "inherit" });
      return;
    }
    case "ts": {
      const cfg = requireConfig();
      const n = needNode(cfg, args[0], ["tailnet"]);
      const r = spawnSync("docker", ["exec", container(n), "tailscale", ...args.slice(1)], { stdio: "inherit" });
      process.exitCode = r.status ?? 1;
      return;
    }
    case "hs": {
      const r = spawnSync("docker", ["exec", container("headscale"), "headscale", ...args], { stdio: "inherit" });
      process.exitCode = r.status ?? 1;
      return;
    }
    case "curl": {
      const cfg = requireConfig();
      const n = needNode(cfg, args[0]);
      const r = spawnSync("docker", ["exec", container(n), "curl", ...args.slice(1)], { stdio: "inherit" });
      process.exitCode = r.status ?? 1;
      return;
    }
    case "ip":
    case "nodeid":
    case "url": {
      const cfg = requireConfig();
      const n = needNode(cfg, args[0]);
      if (cmd === "url") return console.log(`http://127.0.0.1:${n === "plain" ? PORTS.plain : n === "frontdoor" ? PORTS.frontdoor : PORTS.host(n)}/`);
      const st = tsStatus(needNode(cfg, n, ["tailnet"]));
      if (!st) die(`${n}: tailscale not answering`);
      return console.log(cmd === "ip" ? st.Self.TailscaleIPs.find((a) => a.includes(".")) : st.Self.ID);
    }
    case "tls-cert": {
      const [file, ...names] = args;
      if (!file || !/^[a-z0-9-]+$/.test(file)) die("tls-cert <file-stem> [dns-name …]  (e.g. tls-cert mock-token mock-token auth.openai.com)");
      mintCert(file, names.length ? names : [file]);
      return console.log(`${join(STATE, "tls", file)}.pem (+ -key.pem), signed by ${join(STATE, "tls/ca.pem")}`);
    }
    case "pair":
      return cmdPair(args);
    case "unpair":
      return cmdUnpair(args);
    case "frontdoor": {
      const cfg = requireConfig();
      if (!cfg.frontdoor) die("this lab has no front door (lab up --frontdoor)");
      const i = args.indexOf("order");
      let order;
      if (i >= 0) {
        order = (args[i + 1] || "").split(",").filter(Boolean);
        if (!order.length || order.some((h) => !cfg.hosts.includes(h))) die(`order: a comma list of ${cfg.hosts.join(",")}`);
        cfg.order = order;
      }
      if (args.includes("--lab")) cfg.frontdoorSource = "lab";
      if (args.includes("--sova")) cfg.frontdoorSource = "sova";
      saveConfig(cfg);
      const f = args.indexOf("--from");
      const { source, upstreams } = syncFrontDoor(cfg, { order: order ?? cfg.order ?? undefined, from: f >= 0 ? args[f + 1] : cfg.hosts[0], lab: cfg.frontdoorSource === "lab" });
      console.log(`front door http://127.0.0.1:${PORTS.frontdoor}/  ${upstreams.join(" > ")}  (Caddyfile from ${source})`);
      return;
    }
    case "e2e": {
      const which = args[0] || die("e2e <m0|m1|…|all>");
      const files = which === "all" ? ["m0", "m1", "m2", "m3", "m4"].map((m) => join(LAB_DIR, `e2e/${m}.test.mjs`)).filter(existsSync) : [join(LAB_DIR, `e2e/${which}.test.mjs`)];
      for (const f of files) if (!existsSync(f)) die(`no harness ${f}`);
      const cfgNow = loadConfig();
      if (cfgNow) console.log(`# lab built from: ${provenanceLine(cfgNow)}`);
      const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...args.slice(1), ...files], { stdio: "inherit", env: { ...process.env, LAB_STATE: STATE } });
      process.exitCode = r.status ?? 1;
      return;
    }
    default:
      die(`unknown command ${cmd}\n\n${HELP}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`lab: ${e.message}`);
    process.exit(1);
  });
}
