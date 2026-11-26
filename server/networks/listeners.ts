import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import type { DetectedNetwork, NetworkKind, TrustedNetwork } from "../../shared/networks";
import { networkLabel } from "./detect";
import { markTrusted, setOpenTrusted, type OpenTrusted } from "./live";
import { detectNetworks, routedFrom } from "./probe";
import { cidrContains, firstHost, parseCidr, sourceCheck, type SourceCheck } from "./ranges";
import { readTrusted, type TrustedEntry } from "./store";

// A trusted network's listener (§app.access/networks, §app.access/gate): Sova listens at this
// computer's address on that network, on the main listener's port, through the same node-server
// adapter (so the main gate, token included, runs on every request: authGate needs c.env.incoming)
// and the same upgrade dispatch. Only a source inside the network's ranges gets anything: judged by
// the socket's own address at accept, again per request and per upgrade, and every open socket,
// upgraded ones included, is re-judged when the list changes, closed when it no longer passes.
// The listeners follow the store and the system: every 30 s, on each read of the page's list and
// after each change; a bind that fails is tried again in 15 s.

const POLL_MS = 30_000;
const RETRY_MS = 15_000;

/** One listener to have: an address to bind and the ranges whose sources it admits. */
export interface PlannedListener {
  address: string;
  ranges: string[];
  label?: string;
}

export interface TrustedListenerDeps {
  /** The app's fetch (the main listener's own). */
  fetch: (req: Request, env: { incoming: IncomingMessage }) => Response | Promise<Response>;
  /** The main listener's upgrade dispatch, gate included (server/ws.ts mainListenerUpgrade). */
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** The main listener's port. */
  port: () => number;
  /** HOST: a wildcard bind answers everywhere already, and an address it holds is the main listener's. */
  host: () => string;
}

interface Running {
  server: Server;
  address: string;
  port: number;
  ranges: string[];
  label?: string;
  check: SourceCheck;
  sockets: Set<Socket>;
}

/** What each trusted entry resolved to on the last refresh, for the page. */
interface Resolved {
  entry: TrustedEntry;
  address: string | null;
  iface?: string;
  kind?: NetworkKind;
  why?: string;
}

let deps: TrustedListenerDeps | null = null;
const running = new Map<string, Running>();
const failures = new Map<string, string>();
let resolved: Resolved[] = [];
let detected: DetectedNetwork[] = [];
let planForTest: PlannedListener[] | null = null;
let poll: NodeJS.Timeout | null = null;
let retry: NodeJS.Timeout | null = null;
let chain: Promise<void> = Promise.resolve();

export const isWildcard = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "0.0.0.0" || h === "::";
};

/** Tests: listeners from this plan instead of the store and detection (no private-range rule, so a loopback
    stand-in can be trusted); null goes back to the store. Takes effect at the next refreshTrustedListeners. */
export function setTrustedPlanForTest(plan: PlannedListener[] | null): void {
  planForTest = plan ? plan.map((p) => ({ ...p, ranges: [...p.ranges] })) : null;
}

/** Where each entry listens: this computer's address inside its range on a listed network, else its interface's
    address, else the address the system routes its range from when that is a listed network's. */
export async function resolveEntries(entries: TrustedEntry[], networks: DetectedNetwork[], route: (address: string) => Promise<string | null> = routedFrom): Promise<Resolved[]> {
  const out: Resolved[] = [];
  for (const entry of entries) {
    const c = parseCidr(entry.range);
    if (!c) continue;
    const family = c.family === 4 ? (a: string) => !a.includes(":") : (a: string) => a.includes(":");
    let net = networks.find((n) => cidrContains(c, n.address));
    if (!net && entry.iface) net = networks.find((n) => n.iface === entry.iface && family(n.address));
    if (!net) {
      const from = await route(firstHost(c));
      net = from ? networks.find((n) => n.address === from) : undefined;
    }
    out.push(net ? { entry, address: net.address, iface: net.iface, kind: net.kind } : { entry, address: null, why: entry.iface ? `${entry.iface} isn't connected.` : "No network of this computer reaches that range now." });
  }
  return out;
}

const mainHost = (): string => (deps?.host() ?? process.env.HOST ?? "127.0.0.1").toLowerCase().replace(/^\[|\]$/g, "");

async function plan(look: boolean): Promise<PlannedListener[]> {
  if (planForTest) {
    resolved = [];
    return planForTest;
  }
  // Nothing trusted and the page isn't asking: nothing to listen at, and nothing of the system is read.
  const entries = readTrusted();
  if (!entries.length && !look) {
    resolved = [];
    return [];
  }
  detected = await detectNetworks().catch(() => []);
  if (isWildcard(mainHost())) {
    resolved = [];
    return [];
  }
  resolved = await resolveEntries(entries, detected);
  const byAddress = new Map<string, PlannedListener>();
  const main = mainHost();
  for (const r of resolved) {
    if (!r.address || r.address === main) continue;
    const at = byAddress.get(r.address) ?? { address: r.address, ranges: [] };
    at.ranges.push(r.entry.range);
    at.label ??= r.entry.label ?? (r.kind && r.iface ? networkLabel({ kind: r.kind, iface: r.iface }) : undefined);
    byAddress.set(r.address, at);
  }
  return [...byAddress.values()];
}

function closeRunning(r: Running): void {
  running.delete(r.address);
  r.server.close();
  r.server.closeAllConnections?.();
  // closeAllConnections leaves upgraded sockets alone (on Bun too): without this a socket upgraded on the
  // listener stays open after Stop Trusting.
  for (const s of r.sockets) s.destroy();
  r.sockets.clear();
}

/** Drop every open socket the listener's check no longer admits. */
function rejudge(r: Running): void {
  for (const s of r.sockets) {
    if (!r.check.allows(s.remoteAddress)) {
      r.sockets.delete(s);
      s.destroy();
    }
  }
}

function bind(p: PlannedListener, port: number): Promise<Running> {
  const d = deps!;
  const listener = getRequestListener(d.fetch as never, { hostname: p.address });
  const holder: { r?: Running } = {};
  const allows = (s: Socket | undefined): boolean => !!holder.r && !!s && holder.r.check.allows(s.remoteAddress);
  /** Every socket it holds open, for the re-judging and the close. */
  const track = (socket: Socket): void => {
    const r = holder.r;
    if (!r || r.sockets.has(socket)) return;
    markTrusted(socket);
    r.sockets.add(socket);
    socket.once("close", () => r.sockets.delete(socket));
  };
  const server = createServer((req, res) => {
    // Per request: a kept-alive connection the list stopped admitting gets nothing more.
    if (!allows(req.socket)) {
      req.socket.destroy();
      return;
    }
    track(req.socket);
    markTrusted(req);
    void listener(req, res);
  });
  server.on("connection", (socket: Socket) => {
    // At accept: anyone outside the ranges is cut off before a byte is read.
    if (!allows(socket)) {
      socket.destroy();
      return;
    }
    track(socket);
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!allows(req.socket)) {
      socket.destroy();
      return;
    }
    track(req.socket);
    if (socket !== req.socket) track(socket as Socket);
    markTrusted(req);
    d.upgrade(req, socket, head);
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, p.address, () => {
      server.off("error", reject);
      server.on("error", (err) => console.warn(`[networks] listener ${p.address}: ${err.message}`));
      holder.r = { server, address: p.address, port, ranges: [...p.ranges], ...(p.label ? { label: p.label } : {}), check: sourceCheck(p.ranges), sockets: new Set() };
      resolve(holder.r);
    });
  });
}

async function apply(look: boolean): Promise<void> {
  const want = await plan(look);
  const wanted = new Map(want.map((p) => [p.address.toLowerCase(), p]));
  const port = deps?.port() ?? 0;
  for (const r of [...running.values()]) {
    const p = wanted.get(r.address);
    if (!p || r.port !== port) {
      closeRunning(r);
      continue;
    }
    r.ranges = [...p.ranges];
    r.check = sourceCheck(p.ranges);
    if (p.label) r.label = p.label;
    else delete r.label;
    rejudge(r);
  }
  failures.clear();
  if (deps && port) {
    for (const [address, p] of wanted) {
      if (running.has(address)) continue;
      try {
        const r = await bind({ ...p, address }, port);
        running.set(address, r);
        console.log(`[networks] listening at ${address.includes(":") ? `[${address}]` : address}:${port} for ${p.ranges.join(", ")}`);
      } catch (err) {
        failures.set(address, (err as Error).message);
      }
    }
  }
  setOpenTrusted([...running.values()].map((r): OpenTrusted => ({ address: r.address, port: r.port, ranges: r.ranges, ...(r.label ? { label: r.label } : {}) })));
  if (failures.size && !retry && deps) {
    retry = setTimeout(() => {
      retry = null;
      void refreshTrustedListeners();
    }, RETRY_MS);
    retry.unref();
  }
}

/** Bring the listeners in line with the store and the system (or the test plan). Resolves once every bind has
    finished and every socket no longer admitted is closed. Calls run one at a time. `look`: read the system's
    networks even with nothing trusted (the page's list asks). */
export function refreshTrustedListeners(opts: { look?: boolean } = {}): Promise<void> {
  const step = () => apply(!!opts.look);
  const run = chain.then(step, step);
  chain = run.catch((err) => console.warn(`[networks] refresh failed: ${(err as Error).message}`));
  return run;
}

export function startTrustedListeners(d: TrustedListenerDeps): void {
  deps = d;
  void refreshTrustedListeners();
  if (!poll) {
    poll = setInterval(() => void refreshTrustedListeners(), POLL_MS);
    poll.unref();
  }
}

export function stopTrustedListeners(): void {
  if (poll) clearInterval(poll);
  poll = null;
  if (retry) clearTimeout(retry);
  retry = null;
  for (const r of [...running.values()]) closeRunning(r);
  setOpenTrusted([]);
}

/** The networks found on the last refresh, each marked trusted when a trusted range covers its address. */
export function detectedNetworks(): DetectedNetwork[] {
  const ranges = readTrusted().map((e) => parseCidr(e.range)).filter((c) => !!c);
  return detected.map((n) => ({ ...n, trusted: ranges.some((c) => cidrContains(c!, n.address) || (n.range !== null && n.range === `${c!.network}/${c!.prefix}`)) }));
}

/** Each trusted entry as the page shows it: where it listens, or why it doesn't. */
export function trustedNetworks(): TrustedNetwork[] {
  return resolved.map((r): TrustedNetwork => {
    const at = r.address ? running.get(r.address) : undefined;
    const failed = r.address ? failures.get(r.address) : undefined;
    const main = !!deps && mainHost() === r.address;
    const label = r.entry.label ?? (r.kind && r.iface ? networkLabel({ kind: r.kind, iface: r.iface }) : undefined);
    return {
      range: r.entry.range,
      address: r.address,
      port: at?.port ?? (main ? (deps?.port() ?? null) : null),
      listening: !!at || main,
      ...(r.iface ? { iface: r.iface } : {}),
      ...(r.kind ?? r.entry.kind ? { kind: (r.kind ?? r.entry.kind)! } : {}),
      ...(label ? { label } : {}),
      ...(r.why ? { error: r.why } : failed ? { error: `Sova couldn't listen there: ${failed}` } : {}),
    };
  });
}
