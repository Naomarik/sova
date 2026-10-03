// bun ws-max-payload.mjs  vs  node ws-max-payload.mjs  (Node needs `npm i ws`; Bun uses its built-in ws)
// Node (ws 8): the 4096-byte message exceeds maxPayload 1024; the server closes with 1009.
// Bun 1.4.2: the server receives all 4096 bytes and nothing closes.
import { WebSocket, WebSocketServer } from "ws";
const wss = new WebSocketServer({ port: 0, maxPayload: 1024 });
wss.on("connection", (s) => {
  s.on("error", () => {});
  s.on("message", (m) => console.log("server received", m.length, "bytes (expected: never, over maxPayload)"));
});
wss.on("listening", () => {
  const c = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
  c.on("error", () => {});
  c.on("open", () => c.send(Buffer.alloc(4096)));
  c.on("close", (code) => { console.log("closed with", code, "(expected 1009)"); process.exit(0); });
  setTimeout(() => { console.log("no close within 1s (expected 1009)"); process.exit(1); }, 1000);
});
