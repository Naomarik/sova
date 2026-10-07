// Tests: the peer listener's gate (listener.ts's PeerGate) with no socket under it. Its HTTP server is
// never listened on, as a dial-out pairing's isn't in production: each call is a NEW in-process
// connection fed to it, so the caller is identified again, as a new TCP connection would be.
import { request } from "node:http";
import { duplexPair } from "./duplex-pair-test-fixtures";
import { type GateDeps, type Identify, PeerGate } from "./listener";

export interface PeerCall {
  status: number;
  /** Its X-Sova-Mesh marker: "refused" (not a peer) or "denied" (not granted). */
  marker: string | undefined;
  body: string;
}

/** A peer gate answering in-process: `call` sends one request on a new connection. */
export function inProcessPeerGate(deps: GateDeps, identify: Identify) {
  const gate = new PeerGate(deps);
  const server = gate.server(identify);
  const call = (method: string, path: string, body?: string): Promise<PeerCall> =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "peer",
          path,
          method,
          headers: body ? { "content-type": "application/json" } : {},
          createConnection: () => {
            const [client, served] = duplexPair();
            Object.assign(served, { remoteAddress: undefined, remotePort: undefined, setTimeout: () => served, setNoDelay: () => served, setKeepAlive: () => served, ref: () => served, unref: () => served });
            Object.assign(client, { setTimeout: () => client, setNoDelay: () => client, setKeepAlive: () => client, ref: () => client, unref: () => client });
            server.emit("connection", served);
            return client as never;
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, marker: res.headers["x-sova-mesh"] as string | undefined, body: text }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  return { gate, call };
}
