// bun ws-socket.mjs  vs  node ws-socket.mjs  (Node needs `npm i ws`)
// Node (ws 8): an open WebSocket's `_socket` is its net.Socket (bytesRead, remoteAddress, ...).
// Bun 1.4.2: `_socket` is undefined. (Private API, but widely read, e.g. for bytes on the wire.)
import { WebSocket, WebSocketServer } from "ws";
const wss = new WebSocketServer({ port: 0 });
wss.on("listening", () => {
  const c = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
  c.on("open", () => {
    console.log("_socket:", typeof c._socket, "bytesRead:", c._socket?.bytesRead);
    process.exit(0);
  });
});
