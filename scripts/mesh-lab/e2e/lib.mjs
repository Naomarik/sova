// Helpers for the milestone harnesses (scripts/mesh-lab/e2e/m*.test.mjs). Every call goes through
// docker against the running lab (`lab up` first); nothing here starts or stops the lab except the
// explicit chaos wrappers. Use from node:test files:
//
//   import { requireLab, curlFrom, waitFor, … } from "./lib.mjs";
//   const cfg = requireLab();            // skips the whole file with a message if no lab is up

import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { container, containerState, DOMAIN, LAB_DIR, loadConfig, PEER_PORT, PORTS, SERVE_PORT, SOVA_PORT, sovaNodes, STATE, tailnetNodes, tsStatus } from "../lab.mjs";

export { container, DOMAIN, PEER_PORT, PORTS, SERVE_PORT, SOVA_PORT, sovaNodes, STATE, tailnetNodes, tsStatus };

/** The lab config, or throws a clear error when no lab is up (node:test reports it as the failure). */
export function requireLab() {
  const cfg = loadConfig();
  if (!cfg) throw new Error(`no lab configured in ${STATE}: run scripts/mesh-lab/lab up`);
  const down = ["headscale", ...cfg.hosts].filter((n) => containerState(n) !== "running");
  if (down.length) throw new Error(`lab not running (${down.join(", ")} down): scripts/mesh-lab/lab up`);
  return cfg;
}

/** Run the lab CLI; returns stdout, throws on a nonzero exit. */
export function lab(...args) {
  const r = spawnSync(process.execPath, [join(LAB_DIR, "lab.mjs"), ...args], { encoding: "utf8", env: { ...process.env, LAB_STATE: STATE } });
  if (r.status !== 0) throw new Error(`lab ${args.join(" ")} -> ${r.status}\n${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

/** docker exec <node> <argv…>; never throws on a nonzero exit. */
export function exec(node, argv, { input, timeoutMs = 60000 } = {}) {
  const r = spawnSync("docker", ["exec", ...(input !== undefined ? ["-i"] : []), container(node), ...argv], { input, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 << 20 });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
export const sh = (node, script, opts) => exec(node, ["sh", "-c", script], opts);

/** Start a long-running docker exec in the background; returns { done: Promise<{code,out,err}>, kill() }. */
export function execBackground(node, argv) {
  const p = spawn("docker", ["exec", container(node), ...argv], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  const done = new Promise((res) => p.on("close", (code) => res({ code, out: out.trim(), err: err.trim() })));
  return { done, kill: () => p.kill() };
}

/**
 * HTTP from inside a lab node (curl). Returns { status, body, json, headers, error }.
 * status 0 = no HTTP answer at all (refused, timed out, unreachable); `error` then says why.
 */
export function curlFrom(node, url, { method = "GET", body, headers = {}, timeoutS = 5 } = {}) {
  const argv = ["curl", "-sS", "-m", String(timeoutS), "-X", method, "-D", "/dev/stderr", "-o", "-", "-w", "\n%{http_code}"];
  for (const [k, v] of Object.entries(headers)) argv.push("-H", `${k}: ${v}`);
  if (body !== undefined) argv.push("-H", "content-type: application/json", "--data-binary", "@-");
  argv.push(url);
  const r = exec(node, argv, { input: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), timeoutMs: (timeoutS + 5) * 1000 });
  const nl = r.out.lastIndexOf("\n");
  const status = Number(nl >= 0 ? r.out.slice(nl + 1) : r.out) || 0;
  const text = nl >= 0 ? r.out.slice(0, nl) : "";
  const hdrs = {};
  for (const line of r.err.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (m) hdrs[m[1].toLowerCase()] = m[2];
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  const error = status === 0 ? r.err.split("\n").find((l) => l.startsWith("curl:")) || r.err : undefined;
  return { status, body: text, json, headers: hdrs, error };
}

/** HTTP from the laptop to a lab node's published port (`a`…`h`, `plain`, `frontdoor`). */
export async function laptopFetch(node, path, init = {}) {
  const port = node === "plain" ? PORTS.plain : node === "frontdoor" ? PORTS.frontdoor : PORTS.host(node);
  return fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 10000) });
}
export const hostUrl = (node) => `http://127.0.0.1:${node === "plain" ? PORTS.plain : node === "frontdoor" ? PORTS.frontdoor : PORTS.host(node)}`;

/**
 * Open a WebSocket from inside a lab node (Node's global WebSocket) and report what happened:
 * { opened, closeCode, closeReason, messages[] } after `holdMs` or the first close.
 */
export function wsFrom(node, url, { holdMs = 1500, send = [] } = {}) {
  const script = `
const [url, holdMs, send] = [process.argv[1], Number(process.argv[2]), JSON.parse(process.argv[3])];
const r = { opened: false, closeCode: null, closeReason: null, messages: [] };
const ws = new WebSocket(url);
const finish = () => { console.log(JSON.stringify(r)); process.exit(0); };
ws.onopen = () => { r.opened = true; for (const m of send) ws.send(typeof m === "string" ? m : JSON.stringify(m)); };
ws.onmessage = (e) => r.messages.push(String(e.data).slice(0, 2000));
ws.onerror = (e) => { r.error = String(e.message || e.type); };
ws.onclose = (e) => { r.closeCode = e.code; r.closeReason = e.reason; finish(); };
setTimeout(finish, holdMs);`;
  const r = exec(node, ["node", "-e", script, url, String(holdMs), JSON.stringify(send)], { timeoutMs: holdMs + 15000 });
  try {
    return JSON.parse(r.out.split("\n").pop());
  } catch {
    return { opened: false, error: r.err || r.out };
  }
}

/** LocalAPI GET inside a tailnet node (e.g. "status", "whois?addr=100.64.0.3:1"). */
export function localapi(node, path) {
  const r = exec(node, ["curl", "-sS", "-m", "5", "--unix-socket", "/var/run/tailscale/tailscaled.sock", `http://local-tailscaled.sock/localapi/v0/${path}`]);
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

export const tailnetIp = (node) => tsStatus(node)?.Self?.TailscaleIPs?.find((a) => a.includes(".")) ?? null;
export const nodeId = (node) => tsStatus(node)?.Self?.ID ?? null;
export const magicName = (node) => `${node}.${DOMAIN}`;

/** The node's IP on the lab docker network (a non-tailnet address). */
export function dockerIp(node) {
  const r = spawnSync("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container(node)], { encoding: "utf8" });
  return r.stdout.trim();
}

/** Poll `fn` (sync or async) until it returns a truthy value; returns that value or throws after timeoutMs. */
export async function waitFor(fn, { timeoutMs = 30000, intervalMs = 500, what = "condition" } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

/** Files inside a node's agent dir ($PI_CODING_AGENT_DIR = /sova/.agent). */
export function readAgentFile(node, rel) {
  const r = exec(node, ["sh", "-c", 'cat "$PI_CODING_AGENT_DIR/$1"', "-", rel]);
  return r.code === 0 ? r.out : null;
}
export function writeAgentFile(node, rel, content) {
  const script = `const fs=require("fs"),p=require("path");const f=p.join(process.env.PI_CODING_AGENT_DIR,process.argv[1]);
fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f+".tmp",fs.readFileSync(0),{mode:0o600});fs.renameSync(f+".tmp",f);`;
  const r = exec(node, ["node", "-e", script, rel], { input: content });
  if (r.code !== 0) throw new Error(`writeAgentFile ${node}:${rel}: ${r.err}`);
}

// chaos wrappers (each prints through the CLI)
export const chaos = {
  kill: (n) => lab("kill", n),
  start: (n) => lab("start", n),
  restart: (n) => lab("restart", n),
  partition: (n, ...flags) => lab("partition", n, ...flags),
  restore: (n) => lab("restore", n),
  sovaStop: (n) => lab("sova-stop", n),
  sovaStart: (n) => lab("sova-start", n),
  sovaRestart: (n) => lab("sova-restart", n),
};

/** Wait until `from` reaches `to`'s Sova over the tailnet (through `to`'s tailscale serve). */
export const waitTailnetHealth = (from, to, timeoutMs = 60000) =>
  waitFor(() => curlFrom(from, `http://${magicName(to)}:${SERVE_PORT}/api/health`, { timeoutS: 2 }).json?.ok === true, { timeoutMs, what: `${from} -> ${to} over the tailnet` });
