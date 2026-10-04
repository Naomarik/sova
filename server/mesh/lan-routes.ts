// The Mesh page's dial-out pairings (§mesh.lan/pairing): this host's key and fingerprint, this host
// as a relay, and adding or removing a pairing. This host's own browser only: the peer listener,
// a pairing's streams and the /peer proxy never reach /api/mesh/*, and localRequest also refuses a
// relayed browser, so no peer can pair itself or change where this host listens.
//
// A pairing is a peers.json entry with a `lan` link (peers.ts), so it is a peer like any other:
// its grant is written here at pairing (presence unless the page chose another) and dropped at
// unpairing, and removing it ends its connections at once (lan.ts follows peers.json).

import type { Context, Hono } from "hono";
import { MESH_PRESETS, type MeshPreset } from "../../shared/mesh-access";
import type { LanPairingAdd, LanRelayPut, LanStatus } from "../../shared/mesh-lan";
import { lanNodeId, parsePin, samePin } from "./lan-cert";
import { type PeerEntry, type PeersConfig, PEER_ID_RE } from "./peers";
import { localRequest } from "./proxy";

export interface LanRouteDeps {
  status: () => LanStatus;
  /** This host's key, made on first use; its pin. */
  ensureKey: () => { pin: string };
  updatePeers: (change: (config: PeersConfig) => PeersConfig | { error: string }) => { config: PeersConfig } | { error: string; status: 400 | 409 };
  /** Grants to write for newly paired nodes, and nodes whose grant goes (index.ts applyPairingGrants). */
  applyGrants: (set: Record<string, MeshPreset>, removed: string[]) => void;
}

const LABEL_MAX = 80;

export function lanRoutes(app: Hono, deps: LanRouteDeps): void {
  const local = (h: (c: Context) => Response | Promise<Response>) => (c: Context) => (localRequest(c) ? h(c) : c.json({ error: "Not found" }, 404));

  app.get("/api/mesh/lan", local((c) => c.json(deps.status())));

  // The key is made only when asked for: a host that never pairs has none.
  app.post(
    "/api/mesh/lan/key",
    local((c) => {
      deps.ensureKey();
      return c.json(deps.status());
    }),
  );

  app.post(
    "/api/mesh/lan/pairings",
    local(async (c) => {
      const body = await jsonBody<Partial<LanPairingAdd>>(c);
      if (!body) return c.json({ error: "Expected JSON body { id, role, pin, host?, port?, label?, grant? }" }, 400);
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!PEER_ID_RE.test(id)) return c.json({ error: `id must match ${PEER_ID_RE}` }, 400);
      if (body.role !== "dial" && body.role !== "accept") return c.json({ error: 'role must be "dial" or "accept"' }, 400);
      const pin = parsePin(body.pin);
      if (!pin) return c.json({ error: "That fingerprint isn't 32 hex digits: copy it from the other host's Mesh page" }, 400);
      const grant = body.grant ?? "presence";
      if (!(MESH_PRESETS as readonly unknown[]).includes(grant)) return c.json({ error: `grant must be one of ${MESH_PRESETS.join(", ")}` }, 400);
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, LABEL_MAX) : id;
      const own = deps.ensureKey();
      if (samePin(own.pin, pin)) return c.json({ error: "That is this host's own fingerprint" }, 400);
      const nodeId = lanNodeId(pin);
      const entry: Record<string, unknown> = {
        id,
        label,
        nodeId,
        pairedAt: Date.now(),
        lan: body.role === "dial" ? { role: "dial", pin, host: typeof body.host === "string" ? body.host.trim() : body.host, port: body.port } : { role: "accept", pin },
      };
      const r = deps.updatePeers((config) => {
        if (config.peers.some((p) => p.id === id)) return { error: `${id} is already a host here` };
        if (config.peers.some((p) => p.nodeId === nodeId)) return { error: "A host with that fingerprint is already paired" };
        return { ...config, peers: [...config.peers, entry as unknown as PeerEntry] };
      });
      if ("error" in r) return c.json({ error: r.error }, r.status);
      deps.applyGrants({ [nodeId]: grant as MeshPreset }, []);
      return c.json(deps.status());
    }),
  );

  app.delete(
    "/api/mesh/lan/pairings/:id",
    local((c) => {
      const id = c.req.param("id");
      let gone: PeerEntry | undefined;
      const r = deps.updatePeers((config) => {
        gone = config.peers.find((p) => p.id === id && p.lan);
        if (!gone) return { error: "No such pairing" };
        return { ...config, peers: config.peers.filter((p) => p !== gone) };
      });
      if ("error" in r) return c.json({ error: r.error }, r.error === "No such pairing" ? 404 : r.status);
      deps.applyGrants({}, [gone!.nodeId]);
      return c.json(deps.status());
    }),
  );

  // This host as a relay: where its listener binds while it accepts a pairing (null: not a relay).
  app.put(
    "/api/mesh/lan/relay",
    local(async (c) => {
      const body = await jsonBody<{ relay?: LanRelayPut }>(c);
      if (!body || !("relay" in body)) return c.json({ error: "Expected JSON body { relay: { host, port, exposure? } | null }" }, 400);
      const r = deps.updatePeers((config) => {
        const self = { ...config.self };
        if (body.relay === null) delete self.relay;
        else self.relay = body.relay as NonNullable<PeersConfig["self"]["relay"]>;
        return { ...config, self };
      });
      if ("error" in r) return c.json({ error: r.error }, r.status);
      return c.json(deps.status());
    }),
  );
}

async function jsonBody<T>(c: Context): Promise<T | null> {
  try {
    const b = (await c.req.json()) as unknown;
    return typeof b === "object" && b !== null && !Array.isArray(b) ? (b as T) : null;
  } catch {
    return null;
  }
}
