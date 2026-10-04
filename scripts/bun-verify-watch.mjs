#!/usr/bin/env node
// /ws/watch live tailing check (Node vs Bun verification): a watch socket on a fresh session
// while a chat socket writes to it; the watch must receive the appended rows.
//   node scripts/bun-verify-watch.mjs <port> <agentDir> [modelRef=zai/glm-5.3]
import { readFileSync, mkdirSync } from "node:fs";
import WebSocket from "ws";

const [portArg, agentDir, modelRef = "zai/glm-5.3"] = process.argv.slice(2);
const PORT = Number(portArg);
const TOKEN = readFileSync(`${agentDir}/sova/auth-token`, "utf8").trim();
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "x-sova-token": TOKEN, Host: `127.0.0.1:${PORT}` };
const CWD = "/tmp/sova-verify-cwd";
mkdirSync(CWD, { recursive: true });

const post = async (path, body) => { const r = await fetch(BASE + path, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) }); return r.json(); };
const sock = (route, path) => new WebSocket(`ws://127.0.0.1:${PORT}${route}?path=${encodeURIComponent(path)}`, { headers: { ...H, Origin: BASE } });
const until = (ws, pred, ms, label) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms);
  const on = (buf) => { let m; try { m = JSON.parse(buf.toString()); } catch { return; } if (pred(m)) { clearTimeout(t); ws.off("message", on); res(m); } };
  ws.on("message", on);
});

const R = { port: PORT };
const { path } = await post("/api/sessions", { cwd: CWD });
const chat = sock("/ws/chat", path);
await until(chat, (m) => m.type === "hello", 30000, "chat hello");
chat.send(JSON.stringify({ type: "set_model", ref: modelRef }));
await until(chat, (m) => m.type === "model", 30000, "model");

const watch = sock("/ws/watch", path);
const rows = []; const t0 = Date.now(); let snapshot = null;
watch.on("message", (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.type === "snapshot") snapshot = (m.items ?? []).length;
  if (m.type === "append") for (const it of m.items ?? []) rows.push({ at: Date.now() - t0, kind: it.kind ?? it.role ?? it.type, hasMarker: JSON.stringify(it).includes("WATCHED-ROW") });
  if (m.type === "error") rows.push({ error: m.message });
});
await until(watch, (m) => m.type === "snapshot", 30000, "watch snapshot");

chat.send(JSON.stringify({ type: "prompt", text: "Reply with exactly: WATCHED-ROW", clientId: "w1" }));
await until(chat, (m) => m.type === "event" && m.event?.type === "agent_end", 180000, "agent_end");
const tEnd = Date.now() - t0;
await new Promise((r) => setTimeout(r, 4000));
R.snapshotItems = snapshot;
R.appendRows = rows.length;
R.agentEndAtMs = tEnd;
R.rows = rows;
R.pass = rows.some((r) => r.kind === "user" && r.hasMarker) && rows.some((r) => /assistant/.test(r.kind) && r.hasMarker);
chat.close(); watch.close();
await post("/api/sessions/archive", { path, archived: true });
console.log(JSON.stringify(R, null, 2));
process.exit(0);
