// bun ws-handshake-timeout.mjs  vs  node ws-handshake-timeout.mjs  (Node needs `npm i ws`)
// A TCP server that accepts and never answers the WebSocket upgrade.
// Node (ws 8): error "Opening handshake has timed out" after ~500 ms, then close 1006.
// Bun 1.4.2: nothing; the socket stays CONNECTING forever.
import net from "node:net";
import { WebSocket } from "ws";
const wedged = net.createServer(() => {});
await new Promise((r) => wedged.listen(0, "127.0.0.1", r));
const t0 = Date.now();
const c = new WebSocket(`ws://127.0.0.1:${wedged.address().port}/`, { handshakeTimeout: 500 });
c.on("error", (e) => console.log(`error after ${Date.now() - t0} ms: ${e.message}`));
c.on("close", (code) => { console.log(`close ${code}`); process.exit(0); });
setTimeout(() => { console.log("no error or close after 2 s (expected a timeout at ~500 ms)"); process.exit(1); }, 2000);
