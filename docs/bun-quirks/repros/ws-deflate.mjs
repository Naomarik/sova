// bun ws-deflate.mjs  vs  node ws-deflate.mjs  (Node needs `npm i ws`; Bun uses its built-in ws)
// Node (ws 8): the server accepts the client's permessage-deflate offer: "permessage-deflate".
// Bun 1.4.2: the server never negotiates it (with a Node ws client too): "".
import { WebSocket, WebSocketServer } from "ws";
const wss = new WebSocketServer({ port: 0, perMessageDeflate: { threshold: 0 } });
wss.on("listening", () => {
  const c = new WebSocket(`ws://127.0.0.1:${wss.address().port}`, { perMessageDeflate: true });
  c.on("open", () => {
    console.log("negotiated extensions:", JSON.stringify(c.extensions), '(expected "permessage-deflate")');
    process.exit(0);
  });
});
