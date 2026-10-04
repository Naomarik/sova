import { WebSocketServer, WebSocket } from "ws";
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 1024 });
let got = null;
wss.on("connection", (s) => { s.on("message", (m) => { got = m.length; }); s.on("error", (e) => { got = "server error: " + e.message; }); });
wss.on("listening", () => {
  const c = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
  c.on("open", () => c.send(Buffer.alloc(4096)));
  c.on("close", (code) => { console.log(process.versions.bun ? "bun" : "node", "client closed", code, "server saw", got); process.exit(0); });
  setTimeout(() => { console.log(process.versions.bun ? "bun" : "node", "no close after 2s; server saw", got, "_socket:", typeof c._socket); process.exit(0); }, 2000);
});
