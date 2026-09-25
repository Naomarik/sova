import { arch, hostname, release } from "node:os";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HostDetails, HostLabel, HostRenameResult, HostTold, MeshDetails, MeshHostDetails } from "../../shared/mesh-details";
import { activityOf, readLiveRecords, type RawLiveRecord, WORKING_FRESH_MS, workerCountsOf } from "../live";
import { stateRoot } from "../state-root";
import { BatteryReader, buildCommit, cores, deviceType, diskOf, loadAverages, type Machine, machineUptime, memory, modelName, realMachine } from "./details-collect";
import { DEFAULT_SERVE_PORT, frontDoorOrder } from "./front-door";
import { ownHello, peerLastSeen, PROBE_TIMEOUT_MS, probePeer } from "./hello";
import type { MeshApi } from "./index";
import { nextLabelAt, type PeerEntry, type PeersConfig } from "./peers";

// Per-host details and rename (types and routes: shared/mesh-details.ts). A host answers for
// itself on the peer listener; the page's /api/mesh/details gathers every host's answer. While the
// mesh is off every route here is the plain 404 and nothing runs: no probe, no child process, no timer.

/** What the details need from outside the mesh: counted by server/index.ts, which owns them. */
export interface DetailsSources {
  /** Session files on this host. */
  sessions(): Promise<number>;
  /** Logins held here, and keys held back by a conflict; null when logins don't sync here. */
  logins(): { count: number; conflicts: number } | null;
}

/** A details answer is local reads only; the probe before it has already reached the host. */
const DETAILS_TIMEOUT_MS = 1500;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const notFound = (c: Context) => c.json({ error: "Not found" }, 404);
const small = bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) });

/** A host name as peers.json takes it: trimmed, 1–80 characters. */
export function cleanLabel(v: unknown): string | null {
  return typeof v === "string" && v.trim() && v.trim().length <= 80 ? v.trim() : null;
}

/** Sessions with a turn running now and workers working now, from every fresh live record. */
export function activityNow(records: RawLiveRecord[], now = Date.now()): { turnsRunning: number; workers: number } {
  const working = new Set<string>();
  const workers = new Map<string, number>();
  records.forEach((r, i) => {
    const beat = typeof r.rec?.heartbeat === "number" ? r.rec.heartbeat : 0;
    if (now - beat > WORKING_FRESH_MS || beat - now > 5 * 60_000) return;
    const key = r.sessionFile ?? `#${i}`;
    if (activityOf(r.rec)?.state === "working") working.add(key);
    // Several processes may claim one file (a TUI and this server): the largest count wins.
    workers.set(key, Math.max(workers.get(key) ?? 0, workerCountsOf(r.rec)?.working ?? 0));
  });
  return { turnsRunning: working.size, workers: [...workers.values()].reduce((a, b) => a + b, 0) };
}

/** Where a browser opens a host: its own https address, or through this host (a phone has none). */
export function openOf(entry: { serveUrl?: string; dnsName?: string } | null, details: HostDetails | undefined, leftOut: boolean): MeshHostDetails["open"] {
  const url = entry?.serveUrl ?? details?.serveUrl;
  if (url) return { kind: "direct", url };
  const phone = details ? details.identity.device === "phone" : leftOut;
  const name = entry?.dnsName ?? details?.identity.dnsName;
  if (phone || !name) return { kind: "through" };
  return { kind: "direct", url: new URL(`https://${name.includes(":") ? `[${name}]` : name}:${DEFAULT_SERVE_PORT}`).origin };
}

/** Front-door standing of each host id in this host's config: 1-based position, or left out. */
function frontDoorOf(config: PeersConfig, dnsName: string | null): (id: string) => MeshHostDetails["frontDoor"] {
  const order = frontDoorOrder(config, dnsName).map((h) => h.id);
  return (id) => {
    const i = order.indexOf(id);
    return { position: i < 0 ? null : i + 1, excluded: i < 0 };
  };
}

/**
 * What stays put while Sova runs: build commit, model and device type. The device type waits for
 * the first battery reading everywhere but Android (Termux:API can hang; sysfs and pmset can't): a
 * Mac or a Linux laptop whose firmware names no chassis is told apart by its battery.
 */
export async function fixedFacts(machine: Machine, battery: BatteryReader): Promise<{ commit?: string; model?: string; device: HostDetails["identity"]["device"] }> {
  const [b, model] = await Promise.all([battery.read(machine.platform !== "android"), modelName(machine)]);
  const commit = buildCommit(machine, ROOT);
  return { ...(commit ? { commit } : {}), ...(model ? { model } : {}), device: deviceType(machine, !!b.battery) };
}

export function mountDetails(app: Hono, mesh: MeshApi, sources: DetailsSources, machine: Machine = realMachine): void {
  const battery = new BatteryReader(machine);
  let fixed: ReturnType<typeof fixedFacts> | null = null;

  async function ownDetails(): Promise<HostDetails> {
    const self = mesh.self();
    const node = mesh.selfNode();
    const hello = ownHello(self, node.nodeId);
    const [facts, b, sessions] = await Promise.all([(fixed ??= fixedFacts(machine, battery)), battery.read(), sources.sessions().catch(() => 0)]);
    const load = loadAverages(machine);
    const disk = diskOf(stateRoot());
    const logins = mesh.settings().sync.logins ? sources.logins() : null;
    const serveUrl = mesh.config()?.self.serveUrl;
    return {
      details: 1,
      id: self.id,
      label: self.label,
      now: Date.now(),
      identity: {
        hostname: hostname(),
        ...(node.dnsName ? { dnsName: node.dnsName } : {}),
        addresses: node.addresses,
        platform: machine.platform,
        osRelease: release(),
        arch: arch(),
        device: facts.device,
        ...(facts.model ? { model: facts.model } : {}),
      },
      versions: { sova: hello.version, ...(facts.commit ? { commit: facts.commit } : {}), pi: hello.pi, node: process.version, protocol: hello.protocol },
      uptime: { process: Math.round(process.uptime()), machine: machineUptime() },
      resources: {
        cores: cores(),
        ...(load ? { load } : {}),
        memory: memory(),
        ...(disk ? { disk } : {}),
        ...b,
      },
      activity: { sessions, ...activityNow(readLiveRecords({ includeOwn: true })) },
      sync: { categories: mesh.syncStatus(), ...(logins ? { logins } : {}) },
      ...(serveUrl ? { serveUrl } : {}),
    };
  }

  /** A peer's own details, or why there are none. */
  async function peerDetails(p: PeerEntry): Promise<Pick<MeshHostDetails, "details" | "unavailable" | "error">> {
    try {
      // Inside the page's 4 s read deadline, after a probe of up to 2.5 s.
      const res = await mesh.peerFetch(p.id, "/api/peer/details", { signal: AbortSignal.timeout(DETAILS_TIMEOUT_MS) });
      if (res.status === 404) {
        await res.body?.cancel();
        return { unavailable: "update" };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return res.status === 403 ? { unavailable: "refused" } : { unavailable: "down", error: `answered ${res.status}` };
      }
      const d = (await res.json()) as HostDetails;
      // A later format (details: 2) is still read for what this build knows; garbage is not.
      if (typeof d !== "object" || d === null || typeof d.details !== "number" || !d.identity || !d.versions) return { unavailable: "update", error: "not a details answer" };
      return { details: d };
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      return { unavailable: "down", error: e.name === "TimeoutError" ? "no answer in time" : (e.cause?.code ?? e.message) };
    }
  }

  async function meshDetails(config: PeersConfig): Promise<MeshDetails> {
    const node = mesh.selfNode();
    const front = frontDoorOf(config, node.dnsName ?? null);
    const excluded = new Set(config.frontDoorExclude ?? []);
    const own = await ownDetails();
    const selfRow: MeshHostDetails = {
      id: config.self.id,
      label: config.self.label,
      self: true,
      state: "self",
      details: own,
      lastSeen: Date.now(),
      stateSince: Date.now() - own.uptime.process * 1000,
      frontDoor: front(config.self.id),
      open: openOf({ ...(config.self.serveUrl ? { serveUrl: config.self.serveUrl } : {}), ...(node.dnsName ? { dnsName: node.dnsName } : {}) }, own, excluded.has(config.self.id)),
    };
    const peers = await Promise.all(
      config.peers.map(async (p): Promise<MeshHostDetails> => {
        const probe = await probePeer(p);
        mesh.sawPeer(p.id, probe.state === "up");
        // Details are outside the protocol hash, so a skewed host is asked too.
        const got = probe.state === "up" || probe.state === "skewed" ? await peerDetails(p) : { unavailable: probe.state as "down" | "refused" };
        return {
          id: p.id,
          label: p.label,
          self: false,
          state: probe.state,
          ...got,
          ...(!got.error && probe.error && probe.state !== "up" ? { error: probe.error } : {}),
          ...(probe.ms !== undefined ? { latencyMs: probe.ms } : {}),
          lastSeen: peerLastSeen(p.id),
          stateSince: mesh.peerSince(p.id),
          pairedAt: p.pairedAt ?? null,
          frontDoor: front(p.id),
          open: openOf(p, got.details, excluded.has(p.id)),
        };
      }),
    );
    return { hosts: [selfRow, ...peers] };
  }

  // ---- rename -----------------------------------------------------------------------------------

  /** Tell every peer (or just `to`) this host's name; a down one hears it when it next comes up. */
  async function announce(to?: string): Promise<HostTold[]> {
    const self = mesh.config()?.self;
    if (!self?.labelAt) return [];
    const body: HostLabel = { label: self.label, labelAt: self.labelAt };
    return Promise.all(
      mesh
        .peers()
        .filter((p) => to === undefined || p.id === to)
        .map(async (p): Promise<HostTold> => {
          try {
            const res = await mesh.peerFetch(p.id, "/api/peer/label", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            });
            await res.body?.cancel();
            return res.ok ? { id: p.id, ok: true } : { id: p.id, ok: false, error: res.status === 404 ? "runs an older build" : `answered ${res.status}` };
          } catch (err) {
            const e = err as Error & { cause?: { code?: string } };
            return { id: p.id, ok: false, error: e.name === "TimeoutError" ? "no answer in time" : (e.cause?.code ?? e.message) };
          }
        }),
    );
  }

  /** This host calls itself `label` from now: stamped, so peers take it over an older name. */
  function renameSelf(label: string): { labelAt: number } | { error: string; status: 400 | 409 } {
    let labelAt = 0;
    const r = mesh.updatePeers((c) => {
      labelAt = nextLabelAt(c.self.labelAt);
      return { ...c, self: { ...c.self, label, labelAt } };
    });
    return "error" in r ? r : { labelAt };
  }

  /** A peer's own new name, taken only over an older one (never the same one twice: no write). */
  function takeLabel(nodeId: string, label: string, labelAt: number): { error: string; status: 400 | 409 } | null {
    const r = mesh.updatePeers((c) => {
      const hit = c.peers.find((p) => p.nodeId === nodeId);
      if (!hit || (hit.labelAt ?? 0) >= labelAt) return c;
      return { ...c, peers: c.peers.map((p) => (p === hit ? { ...p, label, labelAt } : p)) };
    });
    return "error" in r ? r : null;
  }

  // A peer that comes up hears this host's name, in case it missed a rename while it was away.
  mesh.onPeerUp((id) => {
    if (mesh.config()?.self.labelAt) void announce(id);
  });
  // A rename on Settings → Mesh goes out like one made from the details.
  // Seeded when the mesh comes on, so a later settings PUT doesn't re-send a name peers already have.
  let announced: number | undefined;
  mesh.onMeshStart(() => {
    announced ??= mesh.config()?.self.labelAt;
  });
  mesh.onSettingsChange(() => {
    if (!mesh.enabled()) return; // off: exactly what the PUT did before
    const at = mesh.config()?.self.labelAt;
    if (!at || at === announced) return;
    announced = at;
    void announce();
  });

  // ---- routes -----------------------------------------------------------------------------------

  app.get("/api/peer/details", async (c) => (mesh.requestPeer(c) ? c.json(await ownDetails()) : notFound(c)));

  app.post("/api/peer/rename", small, async (c) => {
    if (!mesh.requestPeer(c)) return notFound(c);
    const label = cleanLabel(((await c.req.json().catch(() => null)) as { label?: unknown } | null)?.label);
    if (!label) return c.json({ error: "label must be 1–80 characters" }, 400);
    const r = renameSelf(label);
    if ("error" in r) return c.json({ error: r.error }, r.status);
    announced = r.labelAt;
    void announce();
    return c.json({ label, labelAt: r.labelAt } satisfies HostLabel);
  });

  app.post("/api/peer/label", small, async (c) => {
    const caller = mesh.requestPeer(c);
    if (!caller) return notFound(c);
    const body = (await c.req.json().catch(() => null)) as Partial<HostLabel> | null;
    const label = cleanLabel(body?.label);
    const labelAt = body?.labelAt;
    if (!label || typeof labelAt !== "number" || !Number.isFinite(labelAt) || labelAt <= 0) return c.json({ error: "Expected {label, labelAt}" }, 400);
    const err = takeLabel(caller.nodeId, label, labelAt);
    return err ? c.json({ error: err.error }, err.status) : c.json({ ok: true as const });
  });

  app.get("/api/mesh/details", async (c) => {
    const config = mesh.enabled() ? mesh.config() : null; // null too if a hand edit just broke peers.json
    return config ? c.json(await meshDetails(config)) : notFound(c);
  });

  app.put("/api/mesh/label", small, async (c) => {
    if (!mesh.enabled()) return notFound(c);
    const body = (await c.req.json().catch(() => null)) as { id?: unknown; label?: unknown } | null;
    const label = cleanLabel(body?.label);
    if (!label) return c.json({ error: "A name is 1–80 characters" }, 400);
    const config = mesh.config();
    if (!config) return notFound(c);
    if (body?.id === config.self.id) {
      const r = renameSelf(label);
      if ("error" in r) return c.json({ error: r.error }, r.status);
      announced = r.labelAt;
      return c.json({ label, told: await announce() } satisfies HostRenameResult);
    }
    const peer = config.peers.find((p) => p.id === body?.id);
    if (!peer) return c.json({ error: "Unknown host" }, 404);
    let res: Response;
    try {
      res = await mesh.peerFetch(peer.id, "/api/peer/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2),
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      return c.json({ error: `${peer.label} didn't answer: ${e.name === "TimeoutError" ? "no answer in time" : (e.cause?.code ?? e.message)}` }, 502);
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return c.json({ error: `${peer.label} runs an older build: update it to rename it from here` }, 501);
    }
    const got = (await res.json().catch(() => null)) as Partial<HostLabel> | { error?: string } | null;
    if (!res.ok || !got || !("labelAt" in got) || typeof got.labelAt !== "number" || !cleanLabel(got.label)) {
      const why = got && "error" in got && typeof got.error === "string" ? got.error : `answered ${res.status}`;
      return c.json({ error: `${peer.label} didn't take the name: ${why}` }, 502);
    }
    // It tells every peer itself (this host included); taking its answer here makes the page right at once.
    const err = takeLabel(peer.nodeId, cleanLabel(got.label)!, got.labelAt);
    if (err) return c.json({ error: err.error }, err.status);
    return c.json({ label: cleanLabel(got.label)!, told: [{ id: peer.id, ok: true }] } satisfies HostRenameResult);
  });
}
