// Tests: tailnet peers answered in-process (dial.ts's setPeerWire), so a mesh test needs no socket.
// A peer is a handler by URL origin; a "down" origin fails its TCP check and its fetch, as a stopped
// host does.
import { setPeerWire } from "./dial";

export type PeerHandler = (req: Request) => Response | Promise<Response>;

export interface FakeWire {
  /** Answer `origin` (e.g. "http://127.0.0.1:4801") with `handler`. */
  serve(origin: string, handler: PeerHandler): void;
  /** `origin` stops answering: its TCP check fails and a fetch to it rejects as fetch's does. */
  down(origin: string): void;
  /** Requests sent so far (every one, to any origin). */
  readonly fetches: number;
  /** Requests sent so far, in order. */
  readonly sent: Request[];
  /** Back to the network. */
  restore(): void;
}

/** Install an in-process wire for tailnet peers. */
export function fakeWire(): FakeWire {
  const peers = new Map<string, PeerHandler>();
  const gone = new Set<string>();
  const sent: Request[] = [];
  const refused = () => new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  setPeerWire({
    reachable: async (url) => {
      const origin = new URL(url).origin;
      return peers.has(origin) && !gone.has(origin);
    },
    fetch: async (req) => {
      sent.push(req);
      const origin = new URL(req.url).origin;
      const handler = peers.get(origin);
      if (!handler || gone.has(origin)) throw refused();
      if (req.signal.aborted) throw req.signal.reason;
      return await handler(req);
    },
  });
  return {
    serve: (origin, handler) => {
      peers.set(new URL(origin).origin, handler);
      gone.delete(new URL(origin).origin);
    },
    down: (origin) => void gone.add(new URL(origin).origin),
    get fetches() {
      return sent.length;
    },
    sent,
    restore: () => setPeerWire(null),
  };
}
