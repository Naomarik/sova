// bun fetch-refused-error.mjs  vs  node fetch-refused-error.mjs
// A fetch to a port nothing listens on.
// Node 25 (undici): TypeError "fetch failed" with cause.code "ECONNREFUSED".
// Bun 1.4.2: code "ConnectionRefused" on the error itself, no cause, other wording.
// (Not a bug as such, but code written for Node's shape misreads Bun's.)
import { createServer } from "node:net";
const s = createServer();
await new Promise((r) => s.listen(0, "127.0.0.1", r));
const { port } = s.address();
await new Promise((r) => s.close(r));
try {
  await fetch(`http://127.0.0.1:${port}/`);
} catch (e) {
  console.log(JSON.stringify({ code: e.code, message: e.message, cause: e.cause && { code: e.cause.code, message: e.cause.message } }));
}
