import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Context, Hono } from "hono";
import { grantCaps, MESH_CAPS, MESH_PRESETS, type MeshGrant, type MeshPreset } from "../../shared/mesh-access";
import type { LanPairingAdd } from "../../shared/mesh-lan";
import {
  DECIDED_KEEP_MS,
  FULL_ACCESS_PRESETS,
  PROPOSAL_TTL_MS,
  WAITING_MAX,
  WHY_MAX,
  type MeshProposal,
  type MeshProposalKind,
} from "../../shared/mesh-proposals";
import { extensionCaller, TOKEN_HEADER } from "../auth";
import { notPage, pageFrameRefusal, yourClickRefusal } from "../page-only";
import { writeFileAtomic } from "../sync/logins-stores";
import { fingerprint, lanNodeId, parsePin } from "./lan-cert";
import { PEER_ID_RE, type PeerEntry } from "./peers";
import { localRequest } from "./proxy";

/**
 * An extension proposes, Sova asks (§mesh.lan/proposals). An installed extension's program, by its own key, proposes a
 * change to this computer's dial-out pairings; what only takes access away is applied at once, and what gives a
 * computer more waits for the person's click in Sova's own dialog. Proposals live in memory only. Nothing here runs
 * until an extension asks: no file is read, no frame sent, no timer set (the one timer runs only while one waits).
 */

/** What applying a proposal needs: the Mesh page's own code, so a proposal meets every check the page does. */
export interface ProposalDeps {
  now(): number;
  /** This computer's pin if its key exists; never makes one. */
  ownPin(): string | undefined;
  ensureKey(): { pin: string };
  peers(): PeerEntry[];
  selfId(): string;
  /** This computer as a relay, or null. */
  relay(): { host: string; port: number } | null;
  /** A link's stored grant, or what it has with none. */
  grantOf(peer: string): MeshGrant;
  pair(body: LanPairingAdd, opts?: { dry?: boolean }): Promise<Result>;
  unpair(peer: string): Result;
  setGrant(peer: string, preset: MeshPreset): Result;
  setRelay(relay: { host: string; port: number } | null, opts?: { dry?: boolean }): Result;
  titleOf(extension: string): string;
  /** Every proposal that waits, after each change. */
  publish(waiting: MeshProposal[]): void;
  /** Which extension made which link (`<state root>/mesh-proposals.json`). */
  linksFile(): string;
}

export interface Result {
  status: number;
  body: unknown;
}

interface Kept extends MeshProposal {
  /** The pin as peers.json keeps it (pair). */
  pin?: string;
}

interface LinksFile {
  version: 1;
  links: Record<string, { extension: string; nodeId: string }>;
}

const LABEL_MAX = 80;
const KEEP_MAX = 200;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const errorOf = (r: Result): string => ((r.body as { error?: string } | null)?.error ?? `refused (${r.status})`);
const refuse = (status: number, error: string): Result => ({ status, body: { error } });
const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
/** One line of the extension's words: no control or bidi characters, no line breaks. */
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim();

const KEYS: Record<MeshProposalKind, readonly string[]> = {
  key: ["kind"],
  pair: ["kind", "role", "peer", "label", "fingerprint", "host", "port", "grant", "relay", "why"],
  grant: ["kind", "peer", "grant", "why"],
  unpair: ["kind", "peer", "why"],
};

export const NOT_ITS_LINK = "An extension changes only the links it made. Nothing changed.";
export const NO_SUCH_LINK = "No such link here. Nothing changed.";

export class MeshProposals {
  private readonly kept = new Map<string, Kept>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ProposalDeps) {}

  /** Every proposal that waits, oldest first. */
  waiting(): MeshProposal[] {
    this.expire();
    return [...this.kept.values()].filter((p) => p.state === "waiting").sort((a, b) => a.createdAt - b.createdAt).map(publicOf);
  }

  /** An extension's own proposals (waiting, and decided in the last hour), or every one for the page (null). */
  list(extension: string | null): MeshProposal[] {
    this.expire();
    return [...this.kept.values()].filter((p) => extension === null || p.extension.id === extension).sort((a, b) => a.createdAt - b.createdAt).map(publicOf);
  }

  get(extension: string | null, id: string): MeshProposal | null {
    this.expire();
    const p = this.kept.get(id);
    return p && (extension === null || p.extension.id === extension) ? publicOf(p) : null;
  }

  /** The links an extension made that are still here. */
  links(extension: string): Array<{ peer: string; label: string; nodeId: string; grant: MeshPreset }> {
    const file = this.readLinks();
    return this.deps
      .peers()
      .filter((p) => file.links[p.id]?.extension === extension && file.links[p.id]!.nodeId === p.nodeId)
      .map((p) => ({ peer: p.id, label: p.label ?? p.id, nodeId: p.nodeId, grant: this.deps.grantOf(p.id).preset }));
  }

  async propose(extension: string, body: unknown): Promise<Result> {
    if (!isObj(body) || typeof body.kind !== "string" || !Object.hasOwn(KEYS, body.kind)) return refuse(400, 'Expected { kind: "key" | "pair" | "grant" | "unpair", … }.');
    const kind = body.kind as MeshProposalKind;
    for (const k of Object.keys(body)) if (!KEYS[kind].includes(k)) return refuse(400, `"${k}" isn't part of a ${kind} proposal: ${KEYS[kind].join(", ")} are.`);
    let why: string | undefined;
    if (body.why !== undefined) {
      if (typeof body.why !== "string") return refuse(400, "why is one line of text.");
      why = oneLine(body.why);
      if (why.length > WHY_MAX) return refuse(400, `why is at most ${WHY_MAX} characters.`);
      if (!why) why = undefined;
    }
    this.expire();
    const now = this.deps.now();
    const base = { id: `mp_${randomBytes(12).toString("base64url")}`, extension: { id: extension, title: this.deps.titleOf(extension) }, kind, createdAt: now, ...(why ? { why } : {}) };

    if (kind === "key") {
      const pin = this.deps.ensureKey().pin;
      const p = this.keep({ ...base, state: "applied", decidedAt: now, widens: false, fullAccess: false });
      return { status: 200, body: { proposal: publicOf(p), fingerprint: fingerprint(pin) } };
    }

    const peer = typeof body.peer === "string" ? body.peer.trim() : "";
    if (!PEER_ID_RE.test(peer)) return refuse(400, `peer must match ${PEER_ID_RE}.`);

    if (kind === "pair") return this.proposePair(base, peer, body);

    // grant and unpair: only on a link this extension made.
    const link = this.deps.peers().find((p) => p.id === peer);
    // Gone already (removed on the Mesh page, say): 404, so the extension can read it as done.
    if (!link) return refuse(404, NO_SUCH_LINK);
    const owner = this.readLinks().links[peer];
    if (!owner || owner.extension !== extension || owner.nodeId !== link.nodeId) return refuse(403, NOT_ITS_LINK);

    if (kind === "unpair") {
      const r = this.deps.unpair(peer);
      if (r.status === 200) this.forgetLink(peer);
      const p = this.keep({ ...base, peer, label: link.label ?? peer, ...decided(r, now), widens: false, fullAccess: false });
      return { status: 200, body: { proposal: publicOf(p) } };
    }

    if (!(MESH_PRESETS as readonly unknown[]).includes(body.grant)) return refuse(400, `grant is one of ${MESH_PRESETS.join(", ")}.`);
    const grant = body.grant as MeshPreset;
    const before = this.deps.grantOf(peer);
    const was = grantCaps(before);
    const to = grantCaps({ preset: grant });
    const widens = MESH_CAPS.some((c) => to[c] && !was[c]);
    const fields = { ...base, peer, label: link.label ?? peer, grant, from: before.preset, widens, fullAccess: FULL_ACCESS_PRESETS.includes(grant) };
    if (widens) return this.wait(fields);
    const r = this.deps.setGrant(peer, grant);
    return { status: 200, body: { proposal: publicOf(this.keep({ ...fields, ...decided(r, now) })) } };
  }

  private async proposePair(base: Omit<Kept, "state" | "widens" | "fullAccess">, peer: string, body: Record<string, unknown>): Promise<Result> {
    if (body.role !== "dial" && body.role !== "accept") return refuse(400, 'role is "dial" (this computer dials it) or "accept" (it dials this computer).');
    const pin = parsePin(body.fingerprint);
    if (!pin) return refuse(400, "That fingerprint isn't 32 hex digits: copy it from the other computer.");
    if (!(MESH_PRESETS as readonly unknown[]).includes(body.grant)) return refuse(400, `grant is one of ${MESH_PRESETS.join(", ")}: nothing is assumed.`);
    const grant = body.grant as MeshPreset;
    if (body.label !== undefined && typeof body.label !== "string") return refuse(400, "label is text.");
    const label = typeof body.label === "string" && oneLine(body.label) ? oneLine(body.label).slice(0, LABEL_MAX) : peer;
    if (peer === this.deps.selfId()) return refuse(409, `${peer} is this computer's own id.`);
    let relay: { host: string; port: number } | undefined;
    if (body.role === "dial") {
      if (typeof body.host !== "string" || !body.host.trim() || body.host.length > 253 || !isPort(body.port)) return refuse(400, "A computer this one dials needs its host and port.");
      if (body.relay !== undefined) return refuse(400, "relay goes with an accept proposal: it is where this computer listens.");
    } else {
      if (body.host !== undefined || body.port !== undefined) return refuse(400, "An accept proposal has no host or port: that computer dials this one. relay is where this computer listens.");
      if (body.relay !== undefined) {
        const r = body.relay;
        if (!isObj(r) || typeof r.host !== "string" || !isPort(r.port) || Object.keys(r).some((k) => k !== "host" && k !== "port")) return refuse(400, "relay is { host, port }: a local-network address of this computer.");
        relay = { host: r.host.trim(), port: r.port };
      }
    }
    // Sent again while it waits: the same one.
    const same = [...this.kept.values()].find((p) => p.state === "waiting" && p.kind === "pair" && p.extension.id === base.extension.id && p.peer === peer && p.pin === pin);
    if (same) return { status: 200, body: { proposal: publicOf(same) } };
    const pairing = pairingOf({ peer, label, role: body.role, pin, host: body.host as string | undefined, port: body.port as number | undefined, grant });
    const dry = await this.deps.pair(pairing, { dry: true });
    if (dry.status !== 200) return refuse(dry.status === 400 ? 400 : 409, errorOf(dry));
    if (relay) {
      const now = this.deps.relay();
      if (now && (now.host !== relay.host || now.port !== relay.port)) return refuse(409, `This computer already listens at ${now.host}:${now.port}. Leave relay out, or send that one.`);
      if (!now) {
        const r = this.deps.setRelay(relay, { dry: true });
        if (r.status !== 200) return refuse(r.status === 400 ? 400 : 409, errorOf(r));
      }
    }
    return this.wait({
      ...base,
      peer,
      label,
      role: body.role,
      pin,
      fingerprint: fingerprint(pin),
      ...(body.role === "dial" ? { host: (body.host as string).trim(), port: body.port as number } : {}),
      ...(relay ? { relay } : {}),
      grant,
      widens: true,
      fullAccess: FULL_ACCESS_PRESETS.includes(grant),
    });
  }

  /** The extension takes back one that waits. */
  withdraw(extension: string, id: string): Result {
    this.expire();
    const p = this.kept.get(id);
    if (!p || p.extension.id !== extension) return refuse(404, "No such proposal.");
    if (p.state !== "waiting") return refuse(409, `That proposal is ${p.state} already.`);
    this.decide(p, { state: "withdrawn" });
    return { status: 200, body: { proposal: publicOf(p) } };
  }

  /** The person's Decline. */
  decline(id: string): Result {
    this.expire();
    const p = this.kept.get(id);
    if (!p) return refuse(404, "No such proposal.");
    if (p.state !== "waiting") return refuse(409, `That proposal is ${p.state} already.`);
    this.decide(p, { state: "declined" });
    return { status: 200, body: { proposal: publicOf(p) } };
  }

  /** The person's Link Computer or Give Access: applied now, by the Mesh page's own code, or `failed` with why. */
  async confirm(id: string): Promise<Result> {
    this.expire();
    const p = this.kept.get(id);
    if (!p) return refuse(404, "No such proposal.");
    if (p.state !== "waiting") return refuse(409, `That proposal is ${p.state} already.`);
    // Taken out of waiting first: a second click while this one applies finds it decided.
    p.state = "applied";
    let error: string | null = null;
    if (p.kind === "pair") error = await this.applyPair(p);
    else if (p.kind === "grant") {
      const link = this.deps.peers().find((x) => x.id === p.peer);
      const owner = this.readLinks().links[p.peer!];
      if (!link || !owner || owner.extension !== p.extension.id || owner.nodeId !== link.nodeId) error = `${p.peer} is no longer a link ${p.extension.title} made.`;
      else {
        const r = this.deps.setGrant(p.peer!, p.grant!);
        if (r.status !== 200) error = errorOf(r);
      }
    }
    this.decide(p, error ? { state: "failed", error } : { state: "applied" });
    return { status: error ? 409 : 200, body: error ? { error, proposal: publicOf(p) } : { proposal: publicOf(p) } };
  }

  private async applyPair(p: Kept): Promise<string | null> {
    let setRelay = false;
    if (p.relay) {
      const now = this.deps.relay();
      if (now && (now.host !== p.relay.host || now.port !== p.relay.port)) return `This computer listens at ${now.host}:${now.port} now. Nothing changed.`;
      if (!now) {
        const r = this.deps.setRelay(p.relay);
        if (r.status !== 200) return errorOf(r);
        setRelay = true;
      }
    }
    const r = await this.deps.pair(pairingOf({ peer: p.peer!, label: p.label!, role: p.role!, pin: p.pin!, host: p.host, port: p.port, grant: p.grant! }));
    if (r.status !== 200) {
      // A relay set for this pairing alone goes again with it.
      if (setRelay) this.deps.setRelay(null);
      return errorOf(r);
    }
    this.noteLink(p.peer!, p.extension.id, lanNodeId(p.pin!));
    return null;
  }

  private wait(fields: Omit<Kept, "state">): Result {
    const mine = [...this.kept.values()].filter((p) => p.state === "waiting" && p.extension.id === fields.extension.id).length;
    if (mine >= WAITING_MAX) return refuse(409, `${WAITING_MAX} of this extension's proposals wait already: withdraw one first.`);
    const p = this.keep({ ...fields, state: "waiting", expiresAt: fields.createdAt + PROPOSAL_TTL_MS });
    this.changed();
    return { status: 200, body: { proposal: publicOf(p) } };
  }

  private keep(p: Kept): Kept {
    this.kept.set(p.id, p);
    this.prune();
    return p;
  }

  private decide(p: Kept, to: { state: Kept["state"]; error?: string }): void {
    p.state = to.state;
    p.decidedAt = this.deps.now();
    delete p.expiresAt;
    if (to.error) p.error = to.error;
    this.changed();
  }

  /** Waiting ones past their time read `expired`; true when any did. */
  private expire(): boolean {
    const now = this.deps.now();
    let any = false;
    for (const p of this.kept.values()) {
      if (p.state === "waiting" && p.expiresAt !== undefined && p.expiresAt <= now) {
        p.state = "expired";
        p.decidedAt = p.expiresAt;
        delete p.expiresAt;
        any = true;
      }
    }
    if (any) this.changed(false);
    return any;
  }

  /** Decided ones go after an hour, and the oldest decided beyond KEEP_MAX. */
  private prune(): void {
    const now = this.deps.now();
    for (const [id, p] of this.kept) if (p.state !== "waiting" && (p.decidedAt ?? 0) + DECIDED_KEEP_MS <= now) this.kept.delete(id);
    const decidedOldest = [...this.kept.values()].filter((p) => p.state !== "waiting").sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0));
    while (this.kept.size > KEEP_MAX && decidedOldest.length) this.kept.delete(decidedOldest.shift()!.id);
  }

  /** Tell every page, and keep the one timer that expires the next waiting proposal (none while none waits). */
  private changed(expireFirst = true): void {
    if (expireFirst) this.expire();
    const waiting = [...this.kept.values()].filter((p) => p.state === "waiting").sort((a, b) => a.createdAt - b.createdAt);
    this.deps.publish(waiting.map(publicOf));
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = Math.min(...waiting.map((p) => p.expiresAt ?? Infinity));
    if (Number.isFinite(next)) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.expire();
      }, Math.max(0, next - this.deps.now()) + 50);
      this.timer.unref?.();
    }
  }

  /** Stop the timer (tests, shutdown). */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ---- which extension made which link ------------------------------------------------------------

  /** The file, with every note whose link is gone (however it went) forgotten; written only when that changed it. */
  private readLinks(): LinksFile {
    let file: LinksFile = { version: 1, links: {} };
    try {
      const raw = JSON.parse(readFileSync(this.deps.linksFile(), "utf8")) as unknown;
      if (isObj(raw) && isObj(raw.links)) file = { version: 1, links: raw.links as LinksFile["links"] };
    } catch {
      return file;
    }
    const peers = this.deps.peers();
    const kept = Object.fromEntries(Object.entries(file.links).filter(([id, l]) => isObj(l) && peers.some((p) => p.id === id && p.nodeId === l.nodeId)));
    if (Object.keys(kept).length !== Object.keys(file.links).length) this.writeLinks({ version: 1, links: kept });
    return { version: 1, links: kept };
  }

  private writeLinks(file: LinksFile): void {
    mkdirSync(dirname(this.deps.linksFile()), { recursive: true });
    writeFileAtomic(this.deps.linksFile(), `${JSON.stringify(file, null, 2)}\n`);
  }

  private noteLink(peer: string, extension: string, nodeId: string): void {
    const file = this.readLinks();
    this.writeLinks({ version: 1, links: { ...file.links, [peer]: { extension, nodeId } } });
  }

  private forgetLink(peer: string): void {
    const file = this.readLinks();
    if (!(peer in file.links)) return;
    const { [peer]: _gone, ...links } = file.links;
    this.writeLinks({ version: 1, links });
  }
}

const decided = (r: Result, now: number): Pick<Kept, "state" | "decidedAt" | "error"> => (r.status === 200 ? { state: "applied", decidedAt: now } : { state: "failed", decidedAt: now, error: errorOf(r) });

function pairingOf(p: { peer: string; label: string; role: "dial" | "accept"; pin: string; host?: string; port?: number; grant: MeshPreset }): LanPairingAdd {
  return { id: p.peer, label: p.label, role: p.role, pin: p.pin, grant: p.grant, ...(p.role === "dial" ? { host: p.host!.trim(), port: p.port! } : {}) };
}

function publicOf(p: Kept): MeshProposal {
  const { pin: _pin, ...rest } = p;
  return { ...rest, extension: { ...rest.extension }, ...(rest.relay ? { relay: { ...rest.relay } } : {}) };
}

// ---- the routes -----------------------------------------------------------------------------------

export const PROPOSE_REFUSAL = "Only an extension's program proposes a link. Pair a host on the Mesh page instead. Nothing changed.";
export const DIALOG_FROM_EXTENSION_PAGE = "An extension's page can't answer Sova's dialog. Answer it in Sova's own page. Nothing changed.";

/** The extension whose key sent this, or null. */
function keyExtension(c: Context): string | null {
  return notPage(c) === "extension" ? extensionCaller(c.req.header(TOKEN_HEADER)) : null;
}

/** The routes; `store` is made on first use, so a server no extension asks makes nothing. */
export function proposalRoutes(app: Hono, store: () => MeshProposals): void {
  const local = (h: (c: Context) => Response | Promise<Response>) => (c: Context) => (localRequest(c) ? h(c) : c.json({ error: "Not found" }, 404));
  const send = (c: Context, r: Result) => c.json(r.body as object, r.status as 200);

  app.post(
    "/api/mesh/proposals",
    local(async (c) => {
      const ext = keyExtension(c);
      if (!ext) return c.json({ error: PROPOSE_REFUSAL }, 403);
      const body = (await c.req.json().catch(() => null)) as unknown;
      return send(c, await store().propose(ext, body));
    }),
  );
  app.get(
    "/api/mesh/proposals",
    local((c) => {
      const ext = keyExtension(c);
      return c.json(ext ? { proposals: store().list(ext), links: store().links(ext) } : { proposals: store().list(null) });
    }),
  );
  app.get(
    "/api/mesh/proposals/:id",
    local((c) => {
      const p = store().get(keyExtension(c), c.req.param("id") ?? "");
      return p ? c.json({ proposal: p }) : c.json({ error: "No such proposal." }, 404);
    }),
  );
  app.delete(
    "/api/mesh/proposals/:id",
    local((c) => {
      const ext = keyExtension(c);
      if (!ext) return c.json({ error: "Only the extension that made a proposal withdraws it: the person answers Sova's dialog. Nothing changed." }, 403);
      return send(c, store().withdraw(ext, c.req.param("id") ?? ""));
    }),
  );
  // The person's answer, in Sova's own page only (§app.access/your-click).
  const answer = (act: (id: string) => Result | Promise<Result>) =>
    local(async (c) => {
      const refused = yourClickRefusal(c, "meshProposal") ?? pageFrameRefusal(c, DIALOG_FROM_EXTENSION_PAGE);
      if (refused) return refused;
      return send(c, await act(c.req.param("id") ?? ""));
    });
  app.post("/api/mesh/proposals/:id/confirm", answer((id) => store().confirm(id)));
  app.post("/api/mesh/proposals/:id/decline", answer((id) => store().decline(id)));
}
