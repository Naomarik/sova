// Bun's `ws` shim can't run a WebSocket over a stream the program hands it.
//   bun docs/bun-quirks/repros/ws-stream.mjs    -> server: throws TypeError; client: never opens
//   node docs/bun-quirks/repros/ws-stream.mjs   -> server: upgraded; client: open
// Needs the `ws` package (run from a checkout with node_modules).
import { randomBytes } from "node:crypto";
import { IncomingMessage } from "node:http";
import { Duplex, PassThrough } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

// Server: handleUpgrade on a request that arrived on a plain Duplex (e.g. an HTTP/2 stream).
const sock = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
const req = new IncomingMessage(sock);
req.method = "GET";
req.url = "/";
req.headers = { host: "x", upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13" };
try {
  new WebSocketServer({ noServer: true }).handleUpgrade(req, sock, Buffer.alloc(0), () => console.log("server: upgraded"));
} catch (e) {
  console.log(`server: throws ${e.constructor.name}: ${e.message}`);
}

// Client: createConnection hands ws a stream; the shim ignores it and dials the URL's host itself.
const toServer = new PassThrough();
let wrote = false;
toServer.on("data", () => { wrote = true; });
const conn = new Duplex({ read() {}, write(c, e, cb) { toServer.write(c, e, cb); } });
const ws = new WebSocket("ws://unreachable.invalid/", { createConnection: () => conn });
ws.on("error", () => {});
setTimeout(() => {
  console.log(`client: ${wrote ? "wrote its upgrade request to the given stream" : "never used the given stream"}`);
  process.exit(0);
}, 500);
