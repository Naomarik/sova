// A stub MCP stdio server for tests (server/harness/pi/mcp.integration.test.ts). Node builtins only.
// argv: --name n --log file [--delay ms] [--tools a,b] [--extra] [--announce] [--write path [--need-write]]
//       [--net url [--need-net]] [--die-on-call]. --log gets one JSON line per thing that happens.
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const flag = (k) => process.argv.includes(`--${k}`);
const name = arg("name", "stub"), log = arg("log"), delay = +arg("delay", "0");
const note = (o) => log && appendFileSync(log, JSON.stringify({ at: Date.now(), name, pid: process.pid, ...o }) + "\n");
note({ event: "start", cwd: process.cwd(), canary: process.env.SOVA_CANARY ?? null, X: process.env.X ?? null, envKeys: Object.keys(process.env).sort() });
const nonce = process.env.STUB_NONCE ?? "NONCE-" + name;
const names = arg("tools", "echo").split(",");
if (flag("extra")) names.push("appeared_after_check");
const tools = names.map((n) => ({ name: n, description: `Stub tool ${n} of ${name}. Returns a token.`, inputSchema: { type: "object", properties: { text: { type: "string" } } } }));
if (arg("write")) { try { writeFileSync(arg("write"), "x"); note({ event: "wrote" }); } catch (e) { process.stderr.write(`write failed: ${e.message}\n`); note({ event: "write-failed", error: e.code }); if (flag("need-write")) process.exit(3); } }
if (arg("net")) { try { const r = await fetch(arg("net"), { signal: AbortSignal.timeout(4000) }); note({ event: "net", status: r.status }); } catch (e) { note({ event: "net-failed", error: String(e.cause?.code ?? e.message) }); process.stderr.write(`network failed: ${e.cause?.code ?? e.message}\n`); if (flag("need-net")) process.exit(4); } }
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("close", () => { note({ event: "stdin-closed" }); process.exit(0); });
rl.on("line", async (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  note({ event: "rpc", method: m.method });
  if (m.method === "notifications/initialized" && flag("announce")) out({ method: "notifications/tools/list_changed" });
  if (m.id === undefined) return;
  if (m.method === "initialize") { if (delay) await new Promise((r) => setTimeout(r, delay)); return out({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: "1" }, instructions: `Stub ${name}` } }); }
  if (m.method === "tools/list") return out({ id: m.id, result: { tools } });
  if (m.method === "tools/call") { if (flag("die-on-call")) { process.stderr.write("stub dying on purpose\n"); process.exit(7); } return out({ id: m.id, result: { content: [{ type: "text", text: `${nonce} tool=${m.params.name} args=${JSON.stringify(m.params.arguments)}` }] } }); }
  out({ id: m.id, error: { code: -32601, message: "nf" } });
});
