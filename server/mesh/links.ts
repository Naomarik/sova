import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { formatLinkMessage, LINK_ID_RE, LINK_MESSAGE_ID_RE } from "../../shared/link-message";
import {
  type LinkCreate,
  type LinkDelivery,
  type LinkedAgentInfo,
  type LinkedTransfer,
  type LinkError,
  type LinkInboxRecord,
  type LinkMember,
  type LinkMemberRef,
  type LinkMemberView,
  type LinkMessage,
  type LinkOffer,
  type LinkOfferAnswer,
  type LinkOfferCreate,
  type LinkOfferCreateResult,
  type LinkOfferDecline,
  type LinkOfferDelivery,
  type LinkOfferEvent,
  type LinkOfferRecipient,
  type LinkOutboxEntry,
  type LinkRefusal,
  type LinkSeen,
  type LinkSend,
  type LinkSendResult,
  type LinkThread,
  type MeshLink,
  type MeshLinksFile,
  type MeshLinkView,
  OFFER_FINAL,
  OFFER_ID_RE,
  type OfferRefusal,
  type PeerLinkCopy,
  type PeerLinkEnd,
  type PeerLinkEndResult,
  type PeerLinkMessage,
  type PeerLinkMessageResult,
  type PeerLinkOffer,
  type PeerLinkOfferResult,
  type PeerOfferReport,
} from "../../shared/mesh-links";
import type { PeerState, SessionSummary } from "../../shared/protocol";
import type { LinkSandbox } from "../link-sandbox";
import type { MeshApi } from "./index";
import { LinkTransfers, newOfferId, OFFER_TTL_MS, type OfferListing, TransferError, type TransferEvent } from "./links-offers";
import type { PullTimings } from "./links-transfer";
import type { PeerEntry } from "./peers";

// Linked sessions across mesh peers (§mesh/links; types and routes: shared/mesh-links.ts): the
// durable record every member host keeps, the inboxes, the outbox for a host that is down, and the
// peer hops. Routes: links-routes.ts. While the mesh is off nothing here runs: no timer, no peer
// call, and every act refuses.

export const MAX_INBOX_RECORDS = 200;
/** The outbox is retried on this timer, only while it holds something. */
export const OUTBOX_RETRY_MS = 60_000;
/** A member's by-id answer is reused this long (the state poll). */
export const MEMBER_CACHE_MS = 3_000;
const HOP_TIMEOUT_MS = 5_000;
/** A member's state is read inside the pane's poll, so a host that is down must not hold it up. */
const LOOKUP_TIMEOUT_MS = 2_500;
const SESSION_ID_RE = /^[\w-]{1,100}$/;
/** While a transfer moves, a session's `links` frame goes out at most this often. */
export const PUSH_EVERY_MS = 2_000;

/** What this module needs from the rest of the server; server/index.ts wires it, tests fake it. */
export interface LinksDeps {
  mesh: Pick<MeshApi, "enabled" | "peers" | "self" | "peerFetch" | "onPeerUp" | "onMeshStart" | "onMeshStop" | "selfNode" | "sawPeer">;
  /** `<stateRoot>`, read per call. */
  root(): string;
  /** A session on this host's disk, by id. */
  summary(id: string): Promise<SessionSummary | null>;
  /** The path of a session whose runtime this server holds, by id (server/link-delivery.ts). */
  held(sessionId: string): string | null;
  /** Hand a tagged message to a local member's agent (server/link-delivery.ts). Never throws. */
  deliver(path: string, framed: string): Promise<PeerLinkMessageResult>;
  /** A peer's hello state now (server/mesh/hello.ts probePeer); absent: taken as up. */
  probe?(peer: PeerEntry): Promise<PeerState>;
  /** The listed members of a link changed, or a message landed for them (the `links` frame). */
  notify?(sessionIds: string[]): void;
  now?(): number;
  /** A local session's sandbox (server/link-sandbox.ts linkSandboxOf); absent: off. */
  sandboxOf?(sessionId: string): Promise<LinkSandbox>;
  /** This host's home, for `~` in a dest; absent: os.homedir(). */
  homedir?(): string;
  /** What a transfer never writes into: Sova's state root and the sessions dir. */
  protectedRoots?(): string[];
  /** Tests: the pulls' idle and retry timings. */
  transferTimings?: Partial<PullTimings>;
}

/** A local act's refusal: the route answers `status` with `body`. */
export class LinkActError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 410 | 502,
    readonly body: LinkError,
  ) {
    super(body.error);
  }
}

const hex = (n: number) => randomBytes(n).toString("hex");
export const newLinkId = () => `lk_${hex(8)}`;
export const newLinkMessageId = () => `lm_${hex(8)}`;

/** Why a session can't be a link member, or null (§mesh/links intro). */
export function memberRefusal(s: SessionSummary): { reason: NonNullable<LinkError["reason"]>; why: string } | null {
  if (s.overseer) return { reason: "special", why: "it is an Overseer conversation" };
  if (s.projectOverseer) return { reason: "special", why: "it is a project overseer's session" };
  if (s.baton) return { reason: "special", why: "it is a baton session" };
  if (s.org) return { reason: "special", why: "it is an organization's session" };
  if (s.workerSession) return { reason: "worker", why: "it is a subagent's own session" };
  if (s.live) return { reason: "tui-live", why: `it is open in a terminal (pid ${s.live.pid})` };
  if (s.archived) return { reason: "archived", why: "it is archived" };
  return null;
}

function whyDown(err: unknown): string {
  const e = err as Error & { cause?: { code?: string } };
  return e.name === "TimeoutError" ? "no answer in time" : (e.cause?.code ?? e.message);
}

const refused = (to: LinkMemberRef, reason: LinkRefusal, message: string): LinkDelivery => ({ to, state: "refused", reason, message });
const refOf = (m: LinkMemberRef): LinkMemberRef => ({ nodeId: m.nodeId, sessionId: m.sessionId });

/** Validates one stored or received link; null when it isn't one. */
export function parseLink(v: unknown): MeshLink | null {
  if (!v || typeof v !== "object") return null;
  const l = v as Record<string, unknown>;
  if (typeof l.id !== "string" || !LINK_ID_RE.test(l.id)) return null;
  if (typeof l.createdAt !== "number" || typeof l.createdBy !== "string" || !l.createdBy) return null;
  if (!Array.isArray(l.members) || l.members.length < 2) return null;
  const members: LinkMember[] = [];
  for (const m of l.members as Array<Record<string, unknown> | null>) {
    if (!m || typeof m.nodeId !== "string" || !m.nodeId || typeof m.sessionId !== "string" || !SESSION_ID_RE.test(m.sessionId) || typeof m.path !== "string") return null;
    members.push({ nodeId: m.nodeId, sessionId: m.sessionId, path: m.path });
  }
  if (new Set(members.map((m) => m.nodeId)).size !== members.length) return null;
  return { id: l.id, createdAt: l.createdAt, createdBy: l.createdBy, members, ...(typeof l.endedAt === "number" ? { endedAt: l.endedAt } : {}) };
}

/** Validates a received message; null when it isn't one. */
export function parseMessage(v: unknown): LinkMessage | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  const ref = (r: unknown): LinkMemberRef | null => {
    const o = r as Record<string, unknown> | null;
    return o && typeof o.nodeId === "string" && o.nodeId && typeof o.sessionId === "string" && SESSION_ID_RE.test(o.sessionId) ? { nodeId: o.nodeId, sessionId: o.sessionId } : null;
  };
  if (typeof m.id !== "string" || !LINK_MESSAGE_ID_RE.test(m.id) || typeof m.linkId !== "string" || !LINK_ID_RE.test(m.linkId)) return null;
  if (typeof m.at !== "number" || typeof m.text !== "string" || !m.text.trim() || !Array.isArray(m.to) || !m.to.length) return null;
  const from = ref(m.from);
  const to = m.to.map(ref);
  if (!from || to.some((r) => !r)) return null;
  return { id: m.id, linkId: m.linkId, at: m.at, from, to: to as LinkMemberRef[], text: m.text };
}

interface MemberLookup {
  reach: LinkMemberView["reach"];
  peer?: PeerEntry;
  /** The member's session as its host answers for it; null: that host has no such session. */
  summary?: SessionSummary | null;
  error?: string;
}

/** What a hop to a member host came to. */
type HopResult = { state: "sent"; answer: unknown } | { state: "down"; why: string } | { state: "final"; status: number; body: { error?: unknown; reason?: unknown } | null; why: string };

export class MeshLinks {
  private d: LinksDeps | null = null;
  private file: MeshLinksFile | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private readonly memberCache = new Map<string, { at: number; value: Promise<MemberLookup> }>();
  /** The last answer about each member, however old: what a brief view shows. */
  private readonly lastKnown = new Map<string, { at: number; value: MemberLookup }>();
  /** The last summary each member's host gave: its title, model and activity while it is down. */
  private readonly lastSummary = new Map<string, SessionSummary>();
  /** The sender's title an offer arrived with, for its notices (display only). */
  private readonly titles = new Map<string, string>();
  private readonly pushedAt = new Map<string, number>();
  private readonly pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** The file transfers of this host's offers (links-transfer.ts): spools, pulls, the sweeper. */
  readonly transfers = new LinkTransfers();

  /** Wire the module to the server (server/index.ts via mountLinks) or to a test's fakes. */
  configure(deps: LinksDeps): void {
    this.d = deps;
    this.file = null;
    this.transfers.configure({
      root: deps.root,
      homedir: () => deps.homedir?.() ?? homedir(),
      protectedRoots: () => deps.protectedRoots?.() ?? [],
      sandboxOf: async (id) => (await deps.sandboxOf?.(id)) ?? { on: false },
      selfNodeId: () => this.selfNodeId(),
      linkLive: (id) => {
        const l = this.get(id);
        return !!l && l.endedAt === undefined;
      },
      peerGet: (nodeId, path, init) => {
        const peer = this.peerOfNode(nodeId);
        if (!peer) return Promise.reject(new Error("that host is not in this host's peers"));
        return deps.mesh.peerFetch(peer.id, path, init);
      },
      changed: (offer, ev) => this.onTransfer(offer, ev),
      now: () => this.now(),
      ...(deps.transferTimings ? { timings: deps.transferTimings } : {}),
    });
    deps.mesh.onPeerUp((peerId) => {
      // After the outbox: a held accept reaches the sender before its pull asks for the bytes.
      void this.flush(peerId).then(() => {
        const node = deps.mesh.peers().find((p) => p.id === peerId)?.nodeId;
        if (node) this.transfers.onPeerUp(node);
      });
    });
    deps.mesh.onMeshStart(() => {
      if (this.outbox().length) this.arm();
      this.transfers.start();
    });
    deps.mesh.onMeshStop(() => {
      this.disarm();
      this.transfers.stop();
    });
    if (deps.mesh.enabled()) this.transfers.start();
  }

  private get deps(): LinksDeps {
    if (!this.d) throw new LinkActError(409, { error: "Links are not wired on this server yet.", reason: "internal" });
    return this.d;
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private dir(): string {
    return join(this.deps.root(), "mesh-links");
  }
  private notify(sessionIds: string[]): void {
    if (!sessionIds.length) return;
    try {
      this.deps.notify?.(sessionIds);
    } catch (err) {
      console.error("[links] notify failed:", err);
    }
  }
  private assertOn(): void {
    if (!this.deps.mesh.enabled()) throw new LinkActError(409, { error: "The mesh is off on this host, so no link can exist.", reason: "mesh-off" });
  }

  // ---- mesh-links.json ------------------------------------------------------------------------

  private fileName(): string {
    return join(this.deps.root(), "mesh-links.json");
  }

  private load(): MeshLinksFile {
    if (this.file) return this.file;
    let parsed: MeshLinksFile = { version: 1, links: [] };
    try {
      const raw = JSON.parse(readFileSync(this.fileName(), "utf8")) as Partial<MeshLinksFile>;
      const links = Array.isArray(raw.links) ? raw.links.map(parseLink).filter((l): l is MeshLink => !!l) : [];
      parsed = { version: 1, ...(typeof raw.selfNodeId === "string" && raw.selfNodeId ? { selfNodeId: raw.selfNodeId } : {}), links };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[links] mesh-links.json unreadable, starting empty: ${(err as Error).message}`);
    }
    this.file = parsed;
    return parsed;
  }

  /** Written atomically at 0600 (tmp + rename), like peers.json. */
  private save(): void {
    writeAtomic(this.fileName(), `${JSON.stringify(this.load(), null, 2)}\n`);
  }

  /** Tests: forget the in-memory copy, as a restart does. */
  forgetForTest(): void {
    this.file = null;
    this.memberCache.clear();
    this.lastKnown.clear();
    this.lastSummary.clear();
  }

  // ---- identity -------------------------------------------------------------------------------

  /** This host's node identity: the listener's, else what a peer told it. */
  selfNodeId(): string | null {
    return this.deps.mesh.selfNode().nodeId ?? this.load().selfNodeId ?? null;
  }

  /** Learn this host's node identity as a peer names it (a copy's `you`, a whoami answer). */
  private learnSelf(nodeId: string): void {
    if (!nodeId || this.deps.mesh.selfNode().nodeId) return;
    const f = this.load();
    if (f.selfNodeId === nodeId) return;
    f.selfNodeId = nodeId;
    this.save();
  }

  /**
   * Whether `peer` runs a build with links, learning this host's own identity from its answer.
   * "old-build" on a 404, "down" when it can't be reached.
   */
  private async whoami(peer: PeerEntry): Promise<"ok" | "old-build" | "down"> {
    try {
      const res = await this.deps.mesh.peerFetch(peer.id, "/api/peer/links/whoami", { signal: AbortSignal.timeout(HOP_TIMEOUT_MS) });
      if (!res.ok) {
        await res.body?.cancel();
        return res.status === 404 ? "old-build" : "down";
      }
      const got = (await res.json().catch(() => null)) as { nodeId?: unknown } | null;
      if (typeof got?.nodeId === "string" && got.nodeId) this.learnSelf(got.nodeId);
      return "ok";
    } catch {
      return "down";
    }
  }

  /** This host's node identity, asking peers when it doesn't know it. */
  async ensureSelfNodeId(): Promise<string | null> {
    for (const p of this.deps.mesh.peers()) {
      const known = this.selfNodeId();
      if (known) return known;
      await this.whoami(p);
    }
    return this.selfNodeId();
  }

  private peerOfNode(nodeId: string): PeerEntry | null {
    return this.deps.mesh.peers().find((p) => p.nodeId === nodeId) ?? null;
  }

  /** A host's label as this host knows it: its own, a peer's from peers.json, else the node id. */
  hostLabel(nodeId: string): string {
    if (nodeId === this.selfNodeId()) return this.deps.mesh.self().label;
    return this.peerOfNode(nodeId)?.label ?? nodeId;
  }

  // ---- reads ----------------------------------------------------------------------------------

  /** Every link this host holds, ended ones included (history). */
  all(): MeshLink[] {
    return this.load().links;
  }
  get(id: string): MeshLink | null {
    return this.load().links.find((l) => l.id === id) ?? null;
  }
  /** This host's member of a link, or null (the host that made it need not be one). */
  localMember(link: MeshLink): LinkMember | null {
    const self = this.selfNodeId();
    return self ? (link.members.find((m) => m.nodeId === self) ?? null) : null;
  }
  /** The links a local session is a member of, ended ones included. */
  linksOf(sessionId: string): MeshLink[] {
    return this.load().links.filter((l) => this.localMember(l)?.sessionId === sessionId);
  }
  private localSessions(link: MeshLink): string[] {
    const m = this.localMember(link);
    return m ? [m.sessionId] : [];
  }

  /**
   * link_members (with a session) and sova_links (without): each link with how its members are
   * now. `brief` (the per-run prompt section, read before every turn) makes no peer hop: a peer
   * member is what was last learnt of it, its state "unknown" unless that is fresh.
   */
  async list(opts: { sessionId?: string; brief?: boolean } = {}): Promise<MeshLinkView[]> {
    this.assertOn();
    const links = opts.sessionId === undefined ? this.all() : this.linksOf(opts.sessionId);
    return Promise.all(links.map((l) => this.view(l, opts.brief)));
  }

  async view(link: MeshLink, brief = false): Promise<MeshLinkView> {
    return { link, members: await Promise.all(link.members.map((m) => this.memberView(m, brief))) };
  }

  private async memberView(m: LinkMember, brief = false): Promise<LinkMemberView> {
    const self = m.nodeId === this.selfNodeId();
    const key = `${m.nodeId}/${m.sessionId}`;
    const known = this.lastKnown.get(key);
    const fresh = !!known && this.now() - known.at < MEMBER_CACHE_MS;
    const got: MemberLookup =
      brief && !self ? (known?.value ?? { reach: this.peerOfNode(m.nodeId) ? "down" : "unknown-host" }) : await this.lookupMember(m.nodeId, m.sessionId);
    // A host that is down keeps the member as last known (§mesh.links/agents-pane), state offline.
    const s = got.summary ?? (got.reach === "down" || got.reach === "unknown-host" ? this.lastSummary.get(key) : undefined);
    const peer = got.peer ?? this.peerOfNode(m.nodeId) ?? undefined;
    const state: LinkMemberView["state"] =
      brief && !self && !fresh
        ? "unknown"
        : got.reach === "down" || got.reach === "unknown-host"
          ? "offline"
          : !s
            ? "unknown"
            : s.busy || s.activity?.state === "working"
              ? "working"
              : "idle";
    const last = s ? Date.parse(s.lastActiveAt) : NaN;
    return {
      ...m,
      self,
      ...(peer && !self ? { hostId: peer.id } : {}),
      hostLabel: this.hostLabel(m.nodeId),
      reach: got.reach,
      ...(s ? { title: s.title, cwd: s.cwd, model: s.model, archived: s.archived } : {}),
      state,
      ...(Number.isFinite(last) ? { lastActivity: last } : {}),
    };
  }

  /** A member's session as its own host answers for it, cached briefly. */
  private lookupMember(nodeId: string, sessionId: string): Promise<MemberLookup> {
    const key = `${nodeId}/${sessionId}`;
    const hit = this.memberCache.get(key);
    if (hit && this.now() - hit.at < MEMBER_CACHE_MS) return hit.value;
    const value = this.fetchMember(nodeId, sessionId).then((v) => {
      this.lastKnown.set(key, { at: this.now(), value: v });
      if (v.summary) this.lastSummary.set(key, v.summary);
      return v;
    });
    this.memberCache.set(key, { at: this.now(), value });
    return value;
  }

  private async fetchMember(nodeId: string, sessionId: string): Promise<MemberLookup> {
    if (nodeId === this.selfNodeId()) return { reach: "self", summary: await this.deps.summary(sessionId) };
    const peer = this.peerOfNode(nodeId);
    if (!peer) return { reach: "unknown-host" };
    try {
      let res = await this.deps.mesh.peerFetch(peer.id, `/api/sessions/by-id/${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
      if (res.status === 404) {
        const j = (await res.json().catch(() => null)) as { error?: unknown } | null;
        // An older build answers only ?id= (§mesh.links/by-id); its unknown-route 404 says "Not found".
        if (j?.error !== "Not found") return { reach: "up", peer, summary: null };
        res = await this.deps.mesh.peerFetch(peer.id, `/api/sessions/summary?id=${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
        if (res.status === 404) {
          await res.body?.cancel();
          return { reach: "up", peer, summary: null };
        }
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { reach: "down", peer, error: `answered ${res.status}` };
      }
      return { reach: "up", peer, summary: (await res.json()) as SessionSummary };
    } catch (err) {
      return { reach: "down", peer, error: whyDown(err) };
    }
  }

  // ---- the record: make, keep, end --------------------------------------------------------------

  /** Keep a link copy; an existing one only takes an earlier end. True when anything changed. */
  private keep(link: MeshLink): boolean {
    const f = this.load();
    const had = f.links.find((l) => l.id === link.id);
    if (!had) {
      f.links.push(link);
      this.save();
      return true;
    }
    if (link.endedAt !== undefined && (had.endedAt === undefined || link.endedAt < had.endedAt)) {
      had.endedAt = link.endedAt;
      this.save();
      return true;
    }
    return false;
  }

  /**
   * sova_link: resolve every member on its own host, refuse (naming the member) anything that
   * can't be one, write this host's copy and send it to every other member host; one that is down
   * gets it from the outbox.
   */
  async create(req: LinkCreate): Promise<MeshLinkView> {
    this.assertOn();
    const asked = Array.isArray(req?.members) ? req.members : [];
    if (asked.length < 2) throw new LinkActError(400, { error: "A link needs at least two members.", reason: "too-few" });
    const selfId = this.deps.mesh.self().id;
    const members: LinkMember[] = [];
    for (const [i, a] of asked.entries()) {
      const fail = (status: 400 | 404 | 409, reason: LinkError["reason"], why: string): never => {
        throw new LinkActError(status, { error: `Member ${i + 1} (${a?.host ?? "this host"}/${a?.session}): ${why}.`, ...(reason ? { reason } : {}), member: i });
      };
      if (!a || typeof a.session !== "string" || !SESSION_ID_RE.test(a.session)) fail(400, undefined, "name the session by its id");
      const local = a.host === undefined || a.host === "" || a.host === selfId;
      if (local) {
        const s = await this.deps.summary(a.session);
        if (!s) fail(404, "no-session", "no session with that id on this host");
        const no = memberRefusal(s!);
        if (no) fail(409, no.reason, no.why);
        const self = await this.ensureSelfNodeId();
        if (!self) fail(409, "internal", "this host doesn't know its own node identity yet, and no peer answered to tell it");
        members.push({ nodeId: self!, sessionId: a.session, path: s!.path });
        continue;
      }
      const peer = this.deps.mesh.peers().find((p) => p.id === a.host);
      if (!peer) fail(400, "unreachable", `${a.host} is not a peer of this host`);
      const probe = this.deps.probe ? await this.deps.probe(peer!) : "up";
      if (probe === "skewed") fail(409, "skewed", `${peer!.label} runs a different protocol; update it first`);
      if (probe !== "up") fail(409, "unreachable", `${peer!.label} is ${probe}`);
      const has = await this.whoami(peer!);
      if (has === "old-build") fail(409, "old-build", `${peer!.label} runs a build without links`);
      if (has === "down") fail(409, "unreachable", `${peer!.label} didn't answer`);
      this.memberCache.delete(`${peer!.nodeId}/${a.session}`);
      const got = await this.lookupMember(peer!.nodeId, a.session);
      if (got.reach !== "up") fail(409, "unreachable", `${peer!.label} didn't answer (${got.error ?? "down"})`);
      if (!got.summary) fail(404, "no-session", `no session with that id on ${peer!.label}`);
      const no = memberRefusal(got.summary!);
      if (no) fail(409, no.reason, no.why);
      members.push({ nodeId: peer!.nodeId, sessionId: a.session, path: got.summary!.path });
    }
    const seen = new Map<string, number>();
    for (const [i, m] of members.entries()) {
      const j = seen.get(m.nodeId);
      if (j !== undefined)
        throw new LinkActError(400, { error: `Members ${j + 1} and ${i + 1} are on the same host: a link joins one session per host.`, reason: "same-host", member: i });
      seen.set(m.nodeId, i);
    }
    const self = await this.ensureSelfNodeId();
    if (!self) throw new LinkActError(409, { error: "This host doesn't know its own node identity yet, and no peer answered to tell it.", reason: "internal" });
    const link: MeshLink = { id: newLinkId(), createdAt: this.now(), createdBy: self, members };
    this.keep(link);
    await Promise.all(members.filter((m) => m.nodeId !== self).map((m) => this.tell(m.nodeId, { kind: "link", body: { link, you: m.nodeId } })));
    this.notify(this.localSessions(link));
    return this.view(link);
  }

  /** sova_unlink: end a link on every host that holds it; the earliest end wins. */
  async end(linkId: string): Promise<MeshLinkView> {
    this.assertOn();
    const link = this.get(linkId);
    if (!link) throw new LinkActError(404, { error: `No link ${linkId} on this host.`, reason: "unknown-link" });
    if (link.endedAt === undefined) {
      link.endedAt = this.now();
      this.save();
      this.spreadEnd(link);
      this.cancelOffers(link);
      this.notify(this.localSessions(link));
    }
    return this.view(link);
  }

  /** Tell every other host of the link that it ended (the outbox holds it for one that is down). */
  private spreadEnd(link: MeshLink): void {
    const self = this.selfNodeId();
    const hosts = new Set([...link.members.map((m) => m.nodeId), link.createdBy]);
    for (const n of hosts) if (n !== self) void this.tell(n, { kind: "end", linkId: link.id, body: { endedAt: link.endedAt! } });
  }

  /** Archiving a session ends every link it is in (§mesh.links/record). Works while the mesh is
      off too: the end reaches the other hosts from the outbox when it is back on. */
  async endFor(sessionId: string): Promise<void> {
    if (!this.d) return;
    for (const l of this.linksOf(sessionId)) {
      if (l.endedAt !== undefined) continue;
      l.endedAt = this.now();
      this.save();
      this.spreadEnd(l);
      this.cancelOffers(l);
      this.notify([sessionId]);
    }
  }

  // ---- what another host tells this one (links-routes.ts, peer listener) ----------------------

  /** POST /api/peer/links. */
  async takeCopy(caller: PeerEntry, body: unknown): Promise<{ status: 200 | 400 | 403 | 409; body: { ok: true } | LinkError }> {
    const b = body as Partial<PeerLinkCopy> | null;
    const link = parseLink(b?.link);
    if (!link || typeof b?.you !== "string" || !b.you) return { status: 400, body: { error: "Expected {link, you}" } };
    const mine = link.members.find((m) => m.nodeId === b.you);
    if (!mine) return { status: 403, body: { error: "This host is not a member of that link.", reason: "not-member" } };
    if (caller.nodeId !== link.createdBy && !link.members.some((m) => m.nodeId === caller.nodeId))
      return { status: 403, body: { error: "Only a host of that link can send it.", reason: "not-member" } };
    const self = this.selfNodeId();
    if (self && self !== b.you) return { status: 403, body: { error: "That link names another host as this one.", reason: "not-member" } };
    if (!(await this.deps.summary(mine.sessionId))) return { status: 409, body: { error: `No session ${mine.sessionId} on this host.`, reason: "no-session" } };
    this.learnSelf(b.you);
    if (this.keep(link)) this.notify([mine.sessionId]);
    return { status: 200, body: { ok: true } };
  }

  /** POST /api/peer/links/:id/end. */
  takeEnd(caller: PeerEntry, id: string, body: unknown): { status: 200 | 400 | 403 | 404; body: PeerLinkEndResult | LinkError } {
    const endedAt = (body as Partial<PeerLinkEnd> | null)?.endedAt;
    if (typeof endedAt !== "number" || !Number.isFinite(endedAt) || endedAt <= 0) return { status: 400, body: { error: "Expected {endedAt}" } };
    const link = this.get(id);
    if (!link) return { status: 404, body: { error: "No such link on this host.", reason: "unknown-link" } };
    if (caller.nodeId !== link.createdBy && !link.members.some((m) => m.nodeId === caller.nodeId)) return { status: 403, body: { error: "Not a host of that link.", reason: "not-member" } };
    // Never later than this host's clock: a peer's clock can't end a link in the future.
    if (this.keep({ ...link, endedAt: Math.min(endedAt, this.now()) })) {
      this.cancelOffers(link);
      this.notify(this.localSessions(link));
    }
    return { status: 200, body: { ok: true, endedAt: this.get(id)!.endedAt! } };
  }

  /** POST /api/peer/links/:id/message: the caller is the sender's host (never a body field). */
  async takeMessage(caller: PeerEntry, id: string, body: unknown): Promise<{ status: 200 | 400 | 403 | 404; body: PeerLinkMessageResult | LinkError }> {
    const b = body as Partial<PeerLinkMessage> | null;
    const msg = parseMessage(b?.message);
    if (!msg || msg.linkId !== id) return { status: 400, body: { error: "Expected {message, fromTitle?}" } };
    const link = this.get(id);
    if (!link) return { status: 404, body: { error: "No such link on this host.", reason: "unknown-link" } };
    // The {caller, session} pair must be a member, and `to` must name this host's member.
    const sender = link.members.find((m) => m.nodeId === caller.nodeId && m.sessionId === msg.from.sessionId);
    if (!sender || msg.from.nodeId !== caller.nodeId) return { status: 403, body: { error: "The sender is not a member of that link.", reason: "not-member" } };
    const me = this.localMember(link);
    if (!me || !msg.to.some((t) => t.nodeId === me.nodeId && t.sessionId === me.sessionId))
      return { status: 403, body: { error: "The message names no member on this host.", reason: "not-member" } };
    const toMe = refOf(me);
    if (link.endedAt !== undefined) return { status: 200, body: { state: "refused", reason: "ended", message: "The link has ended." } };
    // Taken already (a retry after a lost answer): never delivered twice.
    const had = this.readInbox(link.id, me.sessionId).find((r) => r.dir === "in" && r.id === msg.id);
    if (had?.delivery && had.delivery.state !== "refused" && had.delivery.state !== "outbox") return { status: 200, body: { state: had.delivery.state } };
    // Recorded in the inbox first, then handed to the agent (§mesh.links/delivery).
    const rec: LinkInboxRecord = { ...msg, dir: "in" };
    this.upsertInbox(link.id, me.sessionId, rec);
    let result: PeerLinkMessageResult;
    const s = await this.deps.summary(me.sessionId);
    if (!s) result = { state: "refused", reason: "no-session", message: "The member's session isn't on its host any more." };
    else {
      const fromTitle = typeof b?.fromTitle === "string" && b.fromTitle.trim() ? b.fromTitle.trim().slice(0, 120) : sender.sessionId;
      const framed = formatLinkMessage({ linkId: link.id, messageId: msg.id, fromTitle, fromHost: this.hostLabel(caller.nodeId), fromSessionId: sender.sessionId, text: msg.text });
      try {
        result = await this.deps.deliver(s.path, framed);
      } catch (err) {
        result = { state: "refused", reason: "internal", message: err instanceof Error ? err.message : String(err) };
      }
    }
    this.upsertInbox(link.id, me.sessionId, { ...rec, delivery: result.state === "refused" ? refused(toMe, result.reason, result.message) : { to: toMe, state: result.state } });
    this.notify([me.sessionId]);
    return { status: 200, body: result };
  }

  // ---- sending (link_send) --------------------------------------------------------------------

  /**
   * link_send: a local member's message to other members of its link. The sender must be a
   * session this host holds and a member; each recipient is one hop to its own host, and one whose
   * host can't be reached is held in the outbox.
   */
  async send(req: LinkSend): Promise<LinkSendResult> {
    this.assertOn();
    if (typeof req?.session !== "string" || !SESSION_ID_RE.test(req.session)) throw new LinkActError(400, { error: "session must be the sending session's id" });
    if (typeof req.text !== "string" || !req.text.trim()) throw new LinkActError(400, { error: "text must not be blank" });
    if (!this.deps.held(req.session)) throw new LinkActError(403, { error: "That session isn't running on this host, so it can't send.", reason: "not-member" });
    const link = this.actingLink(req.session, req.link);
    const me = this.localMember(link)!;
    const targets = await this.recipients(link, me, req.to);
    const msg: LinkMessage = { id: newLinkMessageId(), linkId: link.id, at: this.now(), from: refOf(me), to: targets.map(refOf), text: req.text };
    const fromTitle = (await this.deps.summary(me.sessionId))?.title;
    // The sender's record first, so a quick reply never lands in its inbox before it.
    this.upsertInbox(link.id, me.sessionId, { ...msg, dir: "out", deliveries: targets.map((t) => ({ to: refOf(t), state: "outbox" as const })) });
    const deliveries = await Promise.all(
      targets.map((t) => this.tell(t.nodeId, { kind: "message", linkId: link.id, body: { message: msg, ...(fromTitle ? { fromTitle } : {}) } }, link)),
    );
    const out = deliveries.map((d, i) => toDelivery(refOf(targets[i]!), d));
    this.upsertInbox(link.id, me.sessionId, { ...msg, dir: "out", deliveries: out });
    this.notify([me.sessionId]);
    return { linkId: link.id, messageId: msg.id, deliveries: out };
  }

  /** The live link a local session acts in: the one named, else its only live link. */
  private actingLink(session: string, linkId: string | undefined): MeshLink {
    if (linkId !== undefined) {
      const link = this.linksOf(session).find((l) => l.id === linkId);
      if (!link) throw new LinkActError(404, { error: `This session is not in link ${linkId}.`, reason: "not-member" });
      if (link.endedAt !== undefined) throw new LinkActError(409, { error: `Link ${link.id} has ended.`, reason: "ended" });
      return link;
    }
    const live = this.linksOf(session).filter((l) => l.endedAt === undefined);
    if (live.length === 1) return live[0]!;
    if (!live.length) throw new LinkActError(409, { error: "This session is in no link.", reason: "not-member" });
    throw new LinkActError(400, { error: `This session is in ${live.length} links; name one with \`link\` (${live.map((l) => l.id).join(", ")}).` });
  }

  /** `to` resolved against the link's other members: host label or peer id, session id or title. */
  private async recipients(link: MeshLink, me: LinkMember, to: LinkSend["to"]): Promise<LinkMember[]> {
    const others = link.members.filter((m) => m !== me);
    if (to === undefined || to === "all" || (Array.isArray(to) && to.length === 1 && to[0] === "all")) {
      if (to === undefined && others.length > 1) throw new LinkActError(400, { error: `This link has ${others.length} other members; name them in \`to\`, or say "all".` });
      return others;
    }
    const wanted = (Array.isArray(to) ? to : [to]).map((t) => String(t).trim()).filter(Boolean);
    if (!wanted.length) throw new LinkActError(400, { error: "`to` names no member." });
    const picked = new Set<LinkMember>();
    for (const w of wanted) {
      const lw = w.toLowerCase();
      const isHost = (m: LinkMember, h: string) => m.nodeId === h || this.peerOfNode(m.nodeId)?.id === h || this.hostLabel(m.nodeId).toLowerCase() === h.toLowerCase();
      // "<host label or peer id>/<session id>": how link_members and the tag line name a member.
      const slash = w.lastIndexOf("/");
      const pair = slash > 0 ? { host: w.slice(0, slash).trim(), session: w.slice(slash + 1).trim() } : null;
      let hit = others.filter((m) => m.sessionId === w || isHost(m, w) || (pair !== null && m.sessionId === pair.session && isHost(m, pair.host)));
      if (!hit.length) {
        const titled = await Promise.all(others.map(async (m) => ((await this.lookupMember(m.nodeId, m.sessionId)).summary?.title ?? "").toLowerCase() === lw));
        hit = others.filter((_, i) => titled[i]);
      }
      if (!hit.length) throw new LinkActError(400, { error: `No other member of ${link.id} is "${w}". Members: ${others.map((m) => `${this.hostLabel(m.nodeId)}/${m.sessionId}`).join(", ")}.` });
      for (const m of hit) picked.add(m);
    }
    return [...picked];
  }

  // ---- file offers (§mesh.links/offers, §mesh.links/transfer) ----------------------------------
  // The sender's copy of an offer is the source of truth; each recipient's host keeps its own row.
  // links-transfer.ts packs, serves, pulls and extracts, and reports through onTransfer; the
  // protocol acts, the notices and the sender's one wake are here.

  /**
   * link_offer: list the paths (the sender's sandbox binds it), write the offer, start packing,
   * and send it to every recipient's host; one that is down gets it from the outbox. A row whose
   * host refuses is final and in the answer.
   */
  async createOffer(req: LinkOfferCreate): Promise<LinkOfferCreateResult> {
    this.assertOn();
    if (typeof req?.session !== "string" || !SESSION_ID_RE.test(req.session)) throw new LinkActError(400, { error: "session must be the offering session's id" });
    if (!Array.isArray(req.paths) || !req.paths.length || req.paths.some((p) => typeof p !== "string" || !p.trim()))
      throw new LinkActError(400, { error: "paths must name at least one file or directory", reason: "no-path" });
    if (req.exclude !== undefined && (!Array.isArray(req.exclude) || req.exclude.some((x) => typeof x !== "string" || !x)))
      throw new LinkActError(400, { error: "exclude must be a list of patterns" });
    if (req.note !== undefined && typeof req.note !== "string") throw new LinkActError(400, { error: "note must be text" });
    if (!this.deps.held(req.session)) throw new LinkActError(403, { error: "That session isn't running on this host, so it can't offer files.", reason: "not-member" });
    const link = this.actingLink(req.session, req.link);
    const me = this.localMember(link)!;
    const targets = await this.recipients(link, me, req.to);
    const dests = await this.destsOf(link, me, targets, req.dest);
    const s = await this.deps.summary(me.sessionId);
    if (!s) throw new LinkActError(404, { error: "The offering session isn't on this host any more.", reason: "no-session" });
    if (!this.transfers.hasTar()) throw new LinkActError(409, { error: "This host has no tar, so it can't pack files.", reason: "no-tar" });
    const sandbox = (await this.deps.sandboxOf?.(me.sessionId)) ?? { on: false };
    let listing: OfferListing;
    try {
      listing = await this.transfers.list({ cwd: s.cwd, paths: req.paths, ...(req.exclude?.length ? { exclude: req.exclude } : {}), sandbox });
    } catch (err) {
      throw actError(err);
    }
    const at = this.now();
    const note = req.note?.trim().slice(0, 2000);
    const offer: LinkOffer = {
      id: newOfferId(),
      linkId: link.id,
      at,
      expiresAt: at + OFFER_TTL_MS,
      from: refOf(me),
      roots: listing.roots,
      files: listing.files,
      bytes: listing.bytes,
      ...(req.exclude?.length ? { exclude: req.exclude } : {}),
      ...(note ? { note } : {}),
      ...(listing.warnings.length ? { warnings: listing.warnings } : {}),
      packing: { state: "packing", written: 0 },
      recipients: targets.map((t) => {
        const dest = dests.get(t);
        return { to: refOf(t), state: dest ? "accepted" : "offered", ...(dest ? { dest, implicit: true } : {}) } satisfies LinkOfferRecipient;
      }),
    };
    this.transfers.put(offer);
    // Packed once, at offer time, whatever the answers (Q1).
    this.transfers.pack(offer, listing);
    const fromTitle = s.title;
    const text = offerText(offer, (r) => this.rootsLine(r), { kind: "sent" });
    const msgId = offerMessageId(offer.id);
    this.upsertInbox(link.id, me.sessionId, {
      id: msgId,
      linkId: link.id,
      at,
      from: offer.from,
      to: offer.recipients.map((r) => r.to),
      text,
      dir: "out",
      offer: { id: offer.id, event: "offered" },
      deliveries: offer.recipients.map((r) => ({ to: r.to, state: "outbox" as const })),
    });
    const answers = await Promise.all(
      offer.recipients.map((row) => this.tell(row.to.nodeId, { kind: "offer", linkId: link.id, body: { offer: { ...copyOf(offer), recipients: [row] }, fromTitle } }, link)),
    );
    const deliveries: LinkOfferDelivery[] = answers.map((r, i) => ({ to: offer.recipients[i]!.to, ...toOfferAnswer(r) }));
    // The answers move the rows; refusals here are in the tool's result, so they never wake.
    for (const d of deliveries) this.applyOfferAnswer(offer.id, d.to, d, { quiet: true });
    const now = this.transfers.update(offer.id, (o) => {
      if (o.recipients.every((r) => OFFER_FINAL.has(r.state))) o.wokeSender = true;
    });
    this.notify([me.sessionId]);
    return { offer: now ?? offer, deliveries };
  }

  /** `dest` as the member(s) it is for: one for every target, or a map keyed as `to` names them. */
  private async destsOf(link: MeshLink, me: LinkMember, targets: LinkMember[], dest: LinkOfferCreate["dest"]): Promise<Map<LinkMember, string>> {
    const out = new Map<LinkMember, string>();
    if (dest === undefined) return out;
    const ok = (d: unknown): d is string => typeof d === "string" && !!d.trim() && d.length <= 4096 && !d.includes("\0");
    if (typeof dest === "string") {
      if (!ok(dest)) throw new LinkActError(400, { error: "dest must be a directory path", reason: "bad-dest" });
      for (const t of targets) out.set(t, dest);
      return out;
    }
    if (!dest || typeof dest !== "object" || Array.isArray(dest)) throw new LinkActError(400, { error: "dest must be a directory, or a map of member to directory", reason: "bad-dest" });
    for (const [key, d] of Object.entries(dest)) {
      if (!ok(d)) throw new LinkActError(400, { error: `dest for "${key}" must be a directory path`, reason: "bad-dest" });
      for (const m of await this.recipients(link, me, key)) {
        if (!targets.includes(m)) throw new LinkActError(400, { error: `dest names "${key}", which is not a recipient of this offer.`, reason: "bad-dest" });
        out.set(m, d);
      }
    }
    return out;
  }

  /** A recipient host's answer to the offer POST, on the sender's row (and its out record). */
  private applyOfferAnswer(offerId: string, to: LinkMemberRef, a: PeerLinkOfferResult | { state: "outbox" }, opts: { quiet?: boolean } = {}): void {
    const offer = this.transfers.update(offerId, (o) => {
      const row = rowOf(o, to);
      if (!row || OFFER_FINAL.has(row.state)) return;
      if (a.state === "refused") {
        row.state = "refused";
        row.reason = a.reason;
        row.message = a.message;
        row.doneAt = this.now();
      } else if (a.state === "accepted") row.resolvedDest = a.resolvedDest;
    });
    if (!offer) return;
    const delivery: LinkDelivery =
      a.state === "refused"
        ? refused(to, a.reason as LinkRefusal, a.message)
        : a.state === "outbox"
          ? { to, state: "outbox" }
          : { to, state: a.state === "offered" ? a.delivery : "delivered" };
    this.setOutDelivery(offer, delivery);
    if (!opts.quiet) this.maybeWake(offer, to, false);
  }

  /** A held offer reached its host (the outbox drained). */
  private settleOffer(offerId: string, to: LinkMemberRef, a: PeerLinkOfferResult | { state: "outbox" }): void {
    if (a.state !== "outbox") this.applyOfferAnswer(offerId, to, a);
  }

  private setOutDelivery(offer: LinkOffer, d: LinkDelivery): void {
    const file = this.inboxFile(offer.linkId, offer.from.sessionId);
    const records = readJsonl<LinkInboxRecord>(file);
    const rec = records.find((r) => r.dir === "out" && r.id === offerMessageId(offer.id));
    if (!rec) return;
    rec.deliveries = (rec.deliveries ?? []).map((x) => (sameRef(x.to, d.to) ? d : x));
    writeJsonl(file, records);
    this.notify([offer.from.sessionId]);
  }

  /** POST /api/peer/links/:id/offers: the caller is the sender's host (never a body field). */
  async takeOffer(caller: PeerEntry, id: string, body: unknown): Promise<{ status: 200 | 400 | 403 | 404; body: PeerLinkOfferResult | LinkError }> {
    const b = body as Partial<PeerLinkOffer> | null;
    const got = parseOffer(b?.offer);
    if (!got || got.linkId !== id || got.recipients.length !== 1) return { status: 400, body: { error: "Expected {offer, fromTitle?} with this host's one row" } };
    const link = this.get(id);
    if (!link) return { status: 404, body: { error: "No such link on this host.", reason: "unknown-link" } };
    const sender = link.members.find((m) => m.nodeId === caller.nodeId && m.sessionId === got.from.sessionId);
    if (!sender || got.from.nodeId !== caller.nodeId) return { status: 403, body: { error: "The sender is not a member of that link.", reason: "not-member" } };
    const me = this.localMember(link);
    const row = got.recipients[0]!;
    if (!me || !sameRef(row.to, me)) return { status: 403, body: { error: "The offer names no member on this host.", reason: "not-member" } };
    const answer = (o: LinkOffer): PeerLinkOfferResult => {
      const r = o.recipients[0]!;
      if (r.state === "refused" || r.state === "failed" || r.state === "cancelled" || r.state === "expired" || r.state === "declined")
        return { state: "refused", reason: r.reason ?? "ended", message: r.message ?? `The offer is ${r.state} here.` };
      if (r.implicit) return { state: "accepted", resolvedDest: r.resolvedDest ?? "" };
      return { state: "offered", delivery: "delivered" };
    };
    // Taken already (a retry after a lost answer): never delivered twice.
    const had = this.transfers.get(got.id);
    if (had) return { status: 200, body: answer(had) };
    const refuse = (reason: OfferRefusal, message: string): { status: 200; body: PeerLinkOfferResult } => {
      this.transfers.put({ ...got, recipients: [{ ...row, state: "refused", reason, message, doneAt: this.now() }] });
      this.notify([me.sessionId]);
      return { status: 200, body: { state: "refused", reason, message } };
    };
    if (link.endedAt !== undefined) return { status: 200, body: { state: "refused", reason: "ended", message: "The link has ended." } };
    const s = await this.deps.summary(me.sessionId);
    if (!s) return refuse("no-session", "The member's session isn't on its host any more.");
    const fromTitle = typeof b?.fromTitle === "string" && b.fromTitle.trim() ? b.fromTitle.trim().slice(0, 120) : sender.sessionId;
    this.titles.set(got.id, fromTitle);
    const rec = { id: offerMessageId(got.id), linkId: link.id, at: got.at, from: got.from, to: [refOf(me)], dir: "in" as const };
    if (row.dest !== undefined) {
      // dest given: the accept is implicit; the host pulls it with no agent turn.
      let resolvedDest: string;
      try {
        resolvedDest = this.transfers.resolveDest(s.cwd, row.dest);
        await this.transfers.checkDest(resolvedDest, got.roots.map((r) => r.name), (await this.deps.sandboxOf?.(me.sessionId)) ?? { on: false });
      } catch (err) {
        if (!(err instanceof TransferError)) throw err;
        return refuse(err.reason, err.message);
      }
      this.transfers.put({ ...got, recipients: [{ ...row, implicit: true, state: "accepted", resolvedDest }] });
      this.upsertInbox(link.id, me.sessionId, { ...rec, text: offerText(got, (r) => this.rootsLine(r), { kind: "implicit", dest: resolvedDest }), offer: { id: got.id, event: "offered" } });
      this.transfers.queuePull(got.id);
      this.notify([me.sessionId]);
      return { status: 200, body: { state: "accepted", resolvedDest } };
    }
    // No dest: the member's agent decides. A TUI-live member can't answer: refused, final.
    this.transfers.put({ ...got, recipients: [{ ...row, state: "offered" }] });
    const text = offerText(got, (r) => this.rootsLine(r), { kind: "ask", now: this.now() });
    this.upsertInbox(link.id, me.sessionId, { ...rec, text, offer: { id: got.id, event: "offered" } });
    const framed = formatLinkMessage({ linkId: link.id, messageId: rec.id, fromTitle, fromHost: this.hostLabel(caller.nodeId), fromSessionId: sender.sessionId, text });
    const result = await this.deliverSafe(s.path, framed);
    this.upsertInbox(link.id, me.sessionId, {
      ...rec,
      text,
      offer: { id: got.id, event: "offered" },
      delivery: result.state === "refused" ? refused(refOf(me), result.reason, result.message) : { to: refOf(me), state: result.state },
    });
    if (result.state === "refused") return refuse(result.reason, result.message);
    this.notify([me.sessionId]);
    return { status: 200, body: { state: "offered", delivery: result.state } };
  }

  private async deliverSafe(path: string, framed: string): Promise<PeerLinkMessageResult> {
    try {
      return await this.deps.deliver(path, framed);
    } catch (err) {
      return { state: "refused", reason: "internal", message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The local recipient row of an offer for a session this host runs, or a 404/409. */
  private ownRow(offerId: string, session: string): { offer: LinkOffer; row: LinkOfferRecipient } {
    this.assertOn();
    if (typeof session !== "string" || !SESSION_ID_RE.test(session)) throw new LinkActError(400, { error: "session must be the answering session's id" });
    if (!this.deps.held(session)) throw new LinkActError(403, { error: "That session isn't running on this host, so it can't answer.", reason: "not-member" });
    const self = this.selfNodeId();
    const offer = OFFER_ID_RE.test(offerId) ? this.transfers.get(offerId) : null;
    const row = offer?.recipients.find((r) => r.to.sessionId === session && r.to.nodeId === self);
    if (!offer || !row || offer.from.nodeId === self) throw new LinkActError(404, { error: `No file offer ${offerId} for this session.`, reason: "not-member" });
    const link = this.get(offer.linkId);
    if (!link || link.endedAt !== undefined) throw new LinkActError(409, { error: `Link ${offer.linkId} has ended.`, reason: "ended" });
    if (row.state !== "offered") throw new LinkActError(409, { error: `Offer ${offerId} is ${row.state} already; nothing to answer.` });
    if ((row.expiresAt ?? offer.expiresAt) <= this.now()) throw new LinkActError(410, { error: `Offer ${offerId} has expired.` });
    return { offer, row };
  }

  /** link_accept: resolve and check dest on this host, tell the sender, and start pulling. */
  async acceptOffer(offerId: string, req: LinkOfferAnswer): Promise<LinkOffer> {
    const { offer, row } = this.ownRow(offerId, req?.session);
    if (typeof req.dest !== "string" || !req.dest.trim() || req.dest.includes("\0")) throw new LinkActError(400, { error: "dest must be a directory path", reason: "bad-dest" });
    const s = await this.deps.summary(row.to.sessionId);
    if (!s) throw new LinkActError(404, { error: "The session isn't on this host any more.", reason: "no-session" });
    let resolvedDest: string;
    try {
      resolvedDest = this.transfers.resolveDest(s.cwd, req.dest);
      await this.transfers.checkDest(resolvedDest, offer.roots.map((r) => r.name), (await this.deps.sandboxOf?.(row.to.sessionId)) ?? { on: false });
    } catch (err) {
      throw actError(err);
    }
    const next = this.transfers.update(offer.id, (o) => {
      const r = o.recipients[0]!;
      r.state = "accepted";
      r.dest = req.dest;
      r.resolvedDest = resolvedDest;
    })!;
    // The sender records the accept before the first GET (else it answers 403 for a while).
    await this.report(next, { session: row.to.sessionId, state: "accepted", resolvedDest });
    this.transfers.queuePull(offer.id);
    this.notify([row.to.sessionId]);
    return next;
  }

  /** link_decline: the row is final; the sender hears it. */
  async declineOffer(offerId: string, req: LinkOfferDecline): Promise<LinkOffer> {
    const { offer, row } = this.ownRow(offerId, req?.session);
    const why = typeof req.reason === "string" && req.reason.trim() ? req.reason.trim().slice(0, 500) : undefined;
    const next = this.transfers.update(offer.id, (o) => {
      const r = o.recipients[0]!;
      r.state = "declined";
      r.doneAt = this.now();
      if (why) r.message = why;
    })!;
    await this.report(next, { session: row.to.sessionId, state: "declined", ...(why ? { message: why } : {}) });
    this.notify([row.to.sessionId]);
    return next;
  }

  /** link_offers: a local session's offers, both ways, newest first. */
  offersOf(session: string): LinkOffer[] {
    this.assertOn();
    return this.transfers.ofSession(session).sort((a, b) => b.at - a.at);
  }

  /** A recipient's row moved: tell the sender's host (the outbox holds it while that is down). */
  private async report(offer: LinkOffer, body: PeerOfferReport): Promise<void> {
    await this.tell(offer.from.nodeId, { kind: "offer-report", linkId: offer.linkId, offerId: offer.id, body });
  }

  /** GET /api/peer/links/:id/offers/:offer/tar: the spool, to a recipient's host only. */
  serveTar(caller: PeerEntry, linkId: string, offerId: string, h: { range?: string; ifRange?: string }): Promise<Response> | { status: 404; body: LinkError } {
    const offer = OFFER_ID_RE.test(offerId) ? this.transfers.get(offerId) : null;
    if (!offer || offer.linkId !== linkId || offer.from.nodeId !== this.selfNodeId()) return { status: 404, body: { error: "No such offer on this host.", reason: "unknown-link" } };
    return this.transfers.serve(offerId, caller.nodeId, h);
  }

  /** POST /api/peer/links/:id/offers/:offer/result: a recipient's row moved (idempotent). */
  takeReport(caller: PeerEntry, linkId: string, offerId: string, body: unknown): { status: 200 | 400 | 403 | 404; body: { ok: true } | LinkError } {
    const b = body as Partial<PeerOfferReport> | null;
    const states: PeerOfferReport["state"][] = ["accepted", "extracting", "declined", "done", "failed", "refused"];
    if (!b || typeof b.session !== "string" || !states.includes(b.state as PeerOfferReport["state"])) return { status: 400, body: { error: "Expected {session, state}" } };
    const offer = OFFER_ID_RE.test(offerId) ? this.transfers.get(offerId) : null;
    if (!offer || offer.linkId !== linkId || offer.from.nodeId !== this.selfNodeId()) return { status: 404, body: { error: "No such offer on this host.", reason: "unknown-link" } };
    const to = { nodeId: caller.nodeId, sessionId: b.session };
    const was = rowOf(offer, to);
    if (!was) return { status: 403, body: { error: "The caller is not a recipient of that offer.", reason: "not-member" } };
    if (OFFER_FINAL.has(was.state)) return { status: 200, body: { ok: true } };
    const before = was.state;
    const str = (v: unknown, max = 2000) => (typeof v === "string" && v ? v.slice(0, max) : undefined);
    const next = this.transfers.update(offerId, (o) => {
      const r = rowOf(o, to)!;
      r.state = b.state!;
      const dest = str(b.resolvedDest, 4096);
      if (dest) r.resolvedDest = dest;
      if (typeof b.received === "number" && b.received >= 0) r.received = Math.max(r.received ?? 0, b.received);
      if (OFFER_FINAL.has(r.state)) r.doneAt = this.now();
      if (typeof b.took === "number" && b.took >= 0 && r.doneAt) r.startedAt = r.doneAt - b.took;
      if (typeof b.reason === "string") r.reason = b.reason as OfferRefusal;
      const m = str(b.message);
      if (m) r.message = m;
    })!;
    this.pushSoon([offer.from.sessionId], true);
    this.maybeWake(next, to, before !== "offered");
    return { status: 200, body: { ok: true } };
  }

  /**
   * The sender's one wake (§mesh.links/offers): a local delivery at the first of every row final,
   * or the first failure (a refusal after the row was accepted counts; one at the offer POST was
   * in the tool's result and doesn't). `wokeSender` makes it exactly once.
   */
  private maybeWake(offer: LinkOffer, trigger: LinkMemberRef, afterAccept: boolean): void {
    if (offer.wokeSender || offer.from.nodeId !== this.selfNodeId()) return;
    // An ended link's offers are cancelled, and nobody is woken for that.
    if (this.get(offer.linkId)?.endedAt !== undefined) return;
    const row = rowOf(offer, trigger);
    const allFinal = offer.recipients.every((r) => OFFER_FINAL.has(r.state));
    const failure = !!row && (row.state === "failed" || (row.state === "refused" && afterAccept));
    if (!allFinal && !failure) return;
    const woke = this.transfers.update(offer.id, (o) => {
      if (o.wokeSender) return;
      o.wokeSender = true;
    });
    if (!woke) return;
    void this.wakeSender(woke, trigger, allFinal ? "finished" : "failed");
  }

  private async wakeSender(offer: LinkOffer, trigger: LinkMemberRef, event: LinkOfferEvent): Promise<void> {
    const s = await this.deps.summary(offer.from.sessionId);
    const trig = await this.lookupMember(trigger.nodeId, trigger.sessionId).catch(() => null);
    const text = wakeText(offer, event, (r) => `${this.hostLabel(r.nodeId)}/${r.sessionId}`, (r) => this.rootsLine(r));
    const id = newLinkMessageId();
    const rec: LinkInboxRecord = { id, linkId: offer.linkId, at: this.now(), from: trigger, to: [offer.from], text, dir: "in", offer: { id: offer.id, event } };
    this.upsertInbox(offer.linkId, offer.from.sessionId, rec);
    if (s) {
      const framed = formatLinkMessage({
        linkId: offer.linkId,
        messageId: id,
        fromTitle: trig?.summary?.title ?? trigger.sessionId,
        fromHost: this.hostLabel(trigger.nodeId),
        fromSessionId: trigger.sessionId,
        text,
      });
      const r = await this.deliverSafe(s.path, framed);
      this.upsertInbox(offer.linkId, offer.from.sessionId, { ...rec, delivery: r.state === "refused" ? refused(offer.from, r.reason, r.message) : { to: offer.from, state: r.state } });
    }
    this.notify([offer.from.sessionId]);
  }

  /** The receiver's notice when its row ends: landed or failed, one message either way. */
  private async landNotice(offer: LinkOffer): Promise<void> {
    const row = offer.recipients[0];
    if (!row) return;
    const event: LinkOfferEvent = row.state === "done" ? "landed" : "failed";
    const s = await this.deps.summary(row.to.sessionId);
    const title = this.titles.get(offer.id) ?? (await this.lookupMember(offer.from.nodeId, offer.from.sessionId).catch(() => null))?.summary?.title ?? offer.from.sessionId;
    const text = landedText(offer, row, title, (r) => this.rootsLine(r));
    // dest given: the one record the offer wrote moves on; answered: a new one.
    const id = row.implicit ? offerMessageId(offer.id) : newLinkMessageId();
    const rec: LinkInboxRecord = { id, linkId: offer.linkId, at: this.now(), from: offer.from, to: [row.to], text, dir: "in", offer: { id: offer.id, event } };
    this.upsertInbox(offer.linkId, row.to.sessionId, rec);
    if (s) {
      const framed = formatLinkMessage({ linkId: offer.linkId, messageId: id, fromTitle: title, fromHost: this.hostLabel(offer.from.nodeId), fromSessionId: offer.from.sessionId, text });
      const r = await this.deliverSafe(s.path, framed);
      this.upsertInbox(offer.linkId, row.to.sessionId, { ...rec, delivery: r.state === "refused" ? refused(row.to, r.reason, r.message) : { to: row.to, state: r.state } });
    }
    this.notify([row.to.sessionId]);
  }

  /** What links-transfer.ts did to an offer copy (already saved). */
  private onTransfer(offer: LinkOffer, ev: TransferEvent): void {
    try {
      const mine = offer.from.nodeId === this.selfNodeId();
      const sessions = mine ? [offer.from.sessionId] : offer.recipients.map((r) => r.to.sessionId);
      switch (ev.kind) {
        case "packed":
        case "serving":
          this.pushSoon(sessions, true);
          return;
        case "progress":
          this.pushSoon(sessions, false);
          return;
        case "pack-failed": {
          // Every open row failed with it (links-transfer.ts); the sender hears it once.
          const next = this.transfers.update(offer.id, (o) => {
            for (const r of o.recipients)
              if (!OFFER_FINAL.has(r.state)) Object.assign(r, { state: "failed", reason: ev.reason, message: ev.message, doneAt: this.now() } satisfies Partial<LinkOfferRecipient>);
          });
          this.pushSoon(sessions, true);
          if (next?.recipients[0]) this.maybeWake(next, next.recipients[0].to, true);
          return;
        }
        case "row": {
          this.pushSoon(sessions, true);
          if (mine) return;
          const row = offer.recipients.find((r) => sameRef(r.to, ev.to));
          if (!row) return;
          if (ev.state === "extracting" || ev.state === "done" || ev.state === "failed" || ev.state === "refused") {
            void this.report(offer, {
              session: row.to.sessionId,
              state: ev.state,
              ...(row.resolvedDest ? { resolvedDest: row.resolvedDest } : {}),
              ...(row.received !== undefined ? { received: row.received } : {}),
              ...(row.startedAt !== undefined && row.doneAt !== undefined ? { took: row.doneAt - row.startedAt } : {}),
              ...(row.reason ? { reason: row.reason } : {}),
              ...(row.message ? { message: row.message } : {}),
            });
          }
          if (ev.state === "done" || ev.state === "failed" || ev.state === "refused") void this.landNotice(offer);
          return;
        }
        case "expired":
          this.pushSoon(sessions, true);
          if (mine && ev.rows[0]) this.maybeWake(offer, ev.rows[0], false);
          return;
      }
    } catch (err) {
      console.error("[links] transfer event failed:", err);
    }
  }

  /** A link ended: its open offers are cancelled on this host (spool and .part gone, pulls 410). */
  private cancelOffers(link: MeshLink): void {
    try {
      const gone = this.transfers.cancel(link.id);
      if (gone.length) this.notify(this.localSessions(link));
    } catch (err) {
      console.error("[links] cancelling offers failed:", err);
    }
  }

  /** The `links` frame for these sessions: now for a state change, else at most one per 2 s. */
  private pushSoon(sessionIds: string[], now: boolean): void {
    for (const id of sessionIds) {
      const last = this.pushedAt.get(id) ?? 0;
      const wait = PUSH_EVERY_MS - (Date.now() - last);
      if (now || wait <= 0) {
        const t = this.pushTimers.get(id);
        if (t) clearTimeout(t);
        this.pushTimers.delete(id);
        this.pushedAt.set(id, Date.now());
        this.notify([id]);
        continue;
      }
      if (this.pushTimers.has(id)) continue;
      const t = setTimeout(() => {
        this.pushTimers.delete(id);
        this.pushedAt.set(id, Date.now());
        this.notify([id]);
      }, wait);
      t.unref?.();
      this.pushTimers.set(id, t);
    }
  }

  /** "proj/, notes.md": the offered names as they land. */
  private rootsLine(roots: LinkOffer["roots"]): string {
    return roots.map((r) => (r.kind === "dir" ? `${r.name}/` : r.name)).join(", ");
  }

  // ---- hops and the outbox --------------------------------------------------------------------

  /**
   * Send one thing to a member host now; if its host can't be reached, hold it in the outbox. A
   * refusal and a 404 from a build without links are final. A message to a host that doesn't hold
   * the link yet (its copy is still in some outbox) carries the link there first, once.
   */
  private async tell(nodeId: string, item: DistributiveOmit<LinkOutboxEntry, "id" | "toNodeId" | "at" | "tries" | "lastTry">, link?: MeshLink): Promise<HopResult | { state: "queued"; why: string }> {
    const r = await this.hopWithCopy(nodeId, item, link);
    if (r.state !== "down") return r;
    this.enqueue({ id: `ob_${hex(8)}`, toNodeId: nodeId, at: this.now(), tries: 1, lastTry: this.now(), ...item } as LinkOutboxEntry);
    return { state: "queued", why: r.why };
  }

  private async hopWithCopy(nodeId: string, item: { kind: LinkOutboxEntry["kind"]; body: unknown; linkId?: string; offerId?: string }, link?: MeshLink): Promise<HopResult> {
    const r = await this.hop(nodeId, pathOf(item), item.body);
    if ((item.kind !== "message" && item.kind !== "offer") || r.state !== "final" || r.status !== 404 || r.body?.reason !== "unknown-link") return r;
    const l = link ?? this.get(item.linkId!);
    if (!l) return r;
    const copied = await this.hop(nodeId, "/api/peer/links", { link: l, you: nodeId } satisfies PeerLinkCopy);
    if (copied.state !== "sent") return copied;
    return this.hop(nodeId, pathOf(item), item.body);
  }

  /** POST `body` to `path` on the host `nodeId`. */
  private async hop(nodeId: string, path: string, body: unknown): Promise<HopResult> {
    const peer = this.peerOfNode(nodeId);
    if (!peer) return { state: "final", status: 0, body: { reason: "unreachable" }, why: "that host is not in this host's peers" };
    let res: Response;
    try {
      res = await this.deps.mesh.peerFetch(peer.id, path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
      });
    } catch (err) {
      this.deps.mesh.sawPeer(peer.id, false); // its next answer is a comeback: onPeerUp drains the outbox
      return { state: "down", why: `${peer.label} is down (${whyDown(err)})` };
    }
    const json = (await res.json().catch(() => null)) as { error?: unknown; reason?: unknown } | null;
    if (res.ok) return { state: "sent", answer: json };
    // The plain 404 of an unknown route: a build without links. Final, never retried.
    if (res.status === 404 && (!json || json.error === "Not found")) return { state: "final", status: 404, body: { reason: "old-build" }, why: `${peer.label} runs a build without links` };
    // Its gate refusing this host, or the host itself failing: tried again later.
    if (res.status >= 500) return { state: "down", why: `${peer.label} answered ${res.status}` };
    return { state: "final", status: res.status, body: json, why: typeof json?.error === "string" ? json.error : `${peer.label} answered ${res.status}` };
  }

  private outboxFile(): string {
    return join(this.dir(), "outbox.jsonl");
  }
  private outbox(): LinkOutboxEntry[] {
    return readJsonl<LinkOutboxEntry>(this.outboxFile());
  }
  private enqueue(e: LinkOutboxEntry): void {
    mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
    appendFileSync(this.outboxFile(), `${JSON.stringify(e)}\n`, { mode: 0o600 });
    console.log(`[links] outbox: ${e.kind} for ${e.toNodeId} held (its host is down)`);
    this.arm();
  }
  private arm(): void {
    if (this.timer || !this.deps.mesh.enabled()) return;
    this.timer = setInterval(() => void this.flush(), OUTBOX_RETRY_MS);
    this.timer.unref?.();
  }
  private disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  /** Stop the retry timer and the transfers (shutdown, tests). */
  stop(): void {
    this.disarm();
    this.transfers.stop();
    for (const t of this.pushTimers.values()) clearTimeout(t);
    this.pushTimers.clear();
  }
  /** Whether the retry timer runs (tests). */
  armed(): boolean {
    return this.timer !== null;
  }
  /** What waits in the outbox (tests). */
  pending(): LinkOutboxEntry[] {
    return this.outbox();
  }

  /** Retry what waits for `peerId`'s host (every host when omitted), in order per host. */
  flush(peerId?: string): Promise<void> {
    if (!this.d || !this.deps.mesh.enabled()) return Promise.resolve();
    // One drain at a time; a second call waits for it and then runs.
    const run = async () => {
      const node = peerId === undefined ? null : (this.deps.mesh.peers().find((p) => p.id === peerId)?.nodeId ?? null);
      if (peerId !== undefined && !node) return;
      const entries = this.outbox();
      if (!entries.length) return this.disarm();
      const keep: LinkOutboxEntry[] = [];
      const down = new Set<string>();
      let sent = 0;
      for (const e of entries) {
        if ((node && e.toNodeId !== node) || down.has(e.toNodeId)) {
          keep.push(e);
          continue;
        }
        const r = await this.hopWithCopy(e.toNodeId, e);
        if (r.state === "down") {
          down.add(e.toNodeId); // nothing after it goes first: its host sees them in order
          keep.push({ ...e, tries: e.tries + 1, lastTry: this.now() });
          continue;
        }
        sent++;
        if (e.kind === "message") this.settleMessage(e, toDelivery({ nodeId: e.toNodeId, sessionId: recipientOf(e) }, r));
        else if (e.kind === "offer") this.settleOffer(e.body.offer.id, e.body.offer.recipients[0]!.to, toOfferAnswer(r));
        else if (r.state !== "sent") console.warn(`[links] ${e.kind} for ${e.toNodeId} dropped: ${r.why}`);
      }
      if (sent) console.log(`[links] outbox: ${sent} settled (${peerId === undefined ? "timer" : `peer-up ${peerId}`}), ${keep.length} still held`);
      // Anything queued while this ran was appended to the file after what was read: kept too.
      const added = this.outbox().slice(entries.length);
      const next = [...keep, ...added];
      if (next.length) writeJsonl(this.outboxFile(), next);
      else {
        rmSync(this.outboxFile(), { force: true });
        this.disarm();
      }
    };
    const prior = this.flushing ?? Promise.resolve();
    const mine = prior.then(run, run).finally(() => {
      if (this.flushing === mine) this.flushing = null;
    });
    this.flushing = mine;
    return mine;
  }

  /** A held message reached its host (or was refused there): the sender's record says so. */
  private settleMessage(e: Extract<LinkOutboxEntry, { kind: "message" }>, d: LinkDelivery): void {
    const msg = e.body.message;
    const file = this.inboxFile(msg.linkId, msg.from.sessionId);
    const records = readJsonl<LinkInboxRecord>(file);
    const rec = records.find((r) => r.dir === "out" && r.id === msg.id);
    if (!rec) return;
    rec.deliveries = (rec.deliveries ?? []).map((x) => (x.to.nodeId === d.to.nodeId && x.to.sessionId === d.to.sessionId ? d : x));
    writeJsonl(file, records);
    this.notify([msg.from.sessionId]);
  }

  // ---- inboxes, thread, unread ----------------------------------------------------------------

  private inboxFile(linkId: string, sessionId: string): string {
    return join(this.dir(), linkId, `${sessionId}.jsonl`);
  }
  /** Add or replace (by direction and id) one record; the newest MAX_INBOX_RECORDS are kept. */
  private upsertInbox(linkId: string, sessionId: string, rec: LinkInboxRecord): void {
    const file = this.inboxFile(linkId, sessionId);
    const records = readJsonl<LinkInboxRecord>(file);
    const i = records.findIndex((r) => r.dir === rec.dir && r.id === rec.id);
    if (i >= 0) records[i] = rec;
    else records.push(rec);
    writeJsonl(file, records.slice(-MAX_INBOX_RECORDS));
  }
  private readInbox(linkId: string, sessionId: string): LinkInboxRecord[] {
    return readJsonl<LinkInboxRecord>(this.inboxFile(linkId, sessionId));
  }

  /** link_inbox: every link inbox of a local session, merged, newest last (the newest `limit`). */
  inbox(sessionId: string, limit?: number): LinkInboxRecord[] {
    this.assertOn();
    const all = this.linksOf(sessionId)
      .flatMap((l) => this.readInbox(l.id, sessionId))
      .sort((a, b) => a.at - b.at);
    return limit === undefined ? all : all.slice(-Math.max(0, Math.floor(limit)));
  }

  /** GET /api/links/:id/thread: this host's inbox files for the link, merged, deduped, oldest first. */
  thread(linkId: string): LinkThread {
    const link = this.get(linkId);
    if (!link) throw new LinkActError(404, { error: `No link ${linkId} on this host.`, reason: "unknown-link" });
    const byId = new Map<string, LinkInboxRecord>();
    for (const m of link.members) for (const r of this.readInbox(link.id, m.sessionId)) if (!byId.has(r.id) || r.dir === "out") byId.set(r.id, r);
    return { link, messages: [...byId.values()].sort((a, b) => a.at - b.at), offers: this.transfers.ofLink(link.id).sort((a, b) => a.at - b.at) };
  }

  private seenFile(linkId: string): string {
    return join(this.dir(), linkId, "seen.json");
  }
  private readSeen(linkId: string): Record<string, number> {
    try {
      const v = JSON.parse(readFileSync(this.seenFile(linkId), "utf8")) as unknown;
      return v && typeof v === "object" ? (v as Record<string, number>) : {};
    } catch {
      return {};
    }
  }
  /** POST /api/links/:id/seen: messages from `from` up to `at` stop counting as unread for `session`. */
  seen(linkId: string, body: unknown): void {
    const b = body as Partial<LinkSeen> | null;
    const link = this.get(linkId);
    if (!link) throw new LinkActError(404, { error: `No link ${linkId} on this host.`, reason: "unknown-link" });
    if (!b || typeof b.session !== "string" || typeof b.at !== "number" || !b.from || typeof b.from.nodeId !== "string" || typeof b.from.sessionId !== "string")
      throw new LinkActError(400, { error: "Expected {session, from, at}" });
    const marks = this.readSeen(linkId);
    const key = `${b.session}<${b.from.nodeId}/${b.from.sessionId}`;
    if ((marks[key] ?? 0) >= b.at) return;
    marks[key] = b.at;
    writeAtomic(this.seenFile(linkId), JSON.stringify(marks));
    this.notify([b.session]);
  }
  private unread(link: MeshLink, from: LinkMember): number {
    const me = this.localMember(link);
    if (!me) return 0;
    const at = this.readSeen(link.id)[`${me.sessionId}<${from.nodeId}/${from.sessionId}`] ?? 0;
    return this.readInbox(link.id, me.sessionId).filter((r) => r.dir === "in" && r.from.nodeId === from.nodeId && r.from.sessionId === from.sessionId && r.at > at).length;
  }

  /**
   * The Agents tab's "Remotely linked agents" rows (§mesh.links/agents-pane), live links only: a
   * member's pane lists its partners on other hosts; the Overseer's lists every member of every
   * link this host knows.
   */
  async linkedAgents(sessionId: string, opts: { overseer?: boolean } = {}): Promise<LinkedAgentInfo[]> {
    if (!this.d || !this.deps.mesh.enabled()) return [];
    const links = (opts.overseer ? this.all() : this.linksOf(sessionId)).filter((l) => l.endedAt === undefined);
    const rows = await Promise.all(
      links.map(async (l) => {
        const view = await this.view(l);
        const offers = this.transfers.ofLink(l.id).sort((a, b) => b.at - a.at);
        return view.members
          .filter((m) => opts.overseer || !m.self)
          .map(
            (m): LinkedAgentInfo => ({
              key: `link:${l.id}:${m.nodeId}`,
              linkId: l.id,
              nodeId: m.nodeId,
              sessionId: m.sessionId,
              path: m.path,
              self: m.self,
              ...(m.hostId ? { hostId: m.hostId } : {}),
              hostLabel: m.hostLabel,
              title: m.title ?? m.sessionId,
              model: m.model ?? null,
              state: m.state,
              ...(m.lastActivity !== undefined ? { lastActivity: m.lastActivity } : {}),
              unread: m.self ? 0 : this.unread(l, m),
              ...transferOf(offers, m),
            }),
          );
      }),
    );
    return rows.flat();
  }
}

/** The one instance the server runs (server/index.ts configures it through mountLinks). */
export const meshLinks = new MeshLinks();

// ---- helpers ------------------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function pathOf(item: { kind: LinkOutboxEntry["kind"]; linkId?: string; offerId?: string; body: unknown }): string {
  if (item.kind === "link") return "/api/peer/links";
  if (item.kind === "offer") return `/api/peer/links/${item.linkId}/offers`;
  if (item.kind === "offer-report") return `/api/peer/links/${item.linkId}/offers/${item.offerId}/result`;
  return `/api/peer/links/${item.linkId}/${item.kind === "end" ? "end" : "message"}`;
}

/** The recipient a held message is for: the member on the host it waits for. */
function recipientOf(e: Extract<LinkOutboxEntry, { kind: "message" }>): string {
  return e.body.message.to.find((t) => t.nodeId === e.toNodeId)?.sessionId ?? "";
}

/** How one hop reads as a recipient's delivery. */
function toDelivery(to: LinkMemberRef, r: HopResult | { state: "queued"; why: string }): LinkDelivery {
  if (r.state === "queued" || r.state === "down") return { to, state: "outbox" };
  if (r.state === "final") {
    const reason = typeof r.body?.reason === "string" ? (r.body.reason as LinkRefusal) : "internal";
    return refused(to, reason, r.why);
  }
  const a = r.answer as PeerLinkMessageResult | null;
  if (a?.state === "started" || a?.state === "delivered") return { to, state: a.state };
  if (a?.state === "refused") return refused(to, a.reason, a.message);
  return refused(to, "internal", "The host gave no result.");
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600); // an existing tmp keeps its old mode through writeFileSync
  renameSync(tmp, file);
}

function readJsonl<T>(file: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn line: skip it
    }
  }
  return out;
}

function writeJsonl(file: string, rows: unknown[]): void {
  writeAtomic(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

// ---- file offers: helpers ---------------------------------------------------------------------

/** The offer's own message id (its notice on both sides): lm_ plus the offer's hex. */
const offerMessageId = (offerId: string) => `lm_${offerId.slice(3)}`;

const sameRef = (a: LinkMemberRef, b: LinkMemberRef) => a.nodeId === b.nodeId && a.sessionId === b.sessionId;
const rowOf = (o: LinkOffer, to: LinkMemberRef) => o.recipients.find((r) => sameRef(r.to, to));

/** A transfer module refusal as a local act's answer. */
function actError(err: unknown): unknown {
  if (!(err instanceof TransferError)) return err;
  const bad = err.reason === "no-path" || err.reason === "same-name" || err.reason === "bad-dest";
  return new LinkActError(bad ? 400 : 409, { error: err.message, reason: err.reason });
}

/** What goes to a recipient's host: the offer without the sender's bookkeeping. */
function copyOf(o: LinkOffer): LinkOffer {
  const { packing: _p, wokeSender: _w, ...rest } = o;
  return rest;
}

/** How one offer hop reads as that recipient's answer. */
function toOfferAnswer(r: HopResult | { state: "queued"; why: string }): PeerLinkOfferResult | { state: "outbox" } {
  if (r.state === "queued" || r.state === "down") return { state: "outbox" };
  if (r.state === "final") return { state: "refused", reason: typeof r.body?.reason === "string" ? (r.body.reason as OfferRefusal) : "internal", message: r.why };
  const a = r.answer as PeerLinkOfferResult | null;
  if (a?.state === "accepted" && typeof a.resolvedDest === "string") return { state: "accepted", resolvedDest: a.resolvedDest };
  if (a?.state === "offered" && (a.delivery === "started" || a.delivery === "delivered")) return { state: "offered", delivery: a.delivery };
  if (a?.state === "refused") return { state: "refused", reason: a.reason, message: String(a.message ?? "") };
  return { state: "refused", reason: "internal", message: "The host gave no result." };
}

const ROOT_KINDS = new Set(["dir", "file", "symlink", "other"]);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Validates a received offer; null when it isn't one. Root names are single path components. */
export function parseOffer(v: unknown): LinkOffer | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const ref = (r: unknown): LinkMemberRef | null => {
    const x = r as Record<string, unknown> | null;
    return x && typeof x.nodeId === "string" && x.nodeId && typeof x.sessionId === "string" && SESSION_ID_RE.test(x.sessionId) ? { nodeId: x.nodeId, sessionId: x.sessionId } : null;
  };
  if (typeof o.id !== "string" || !OFFER_ID_RE.test(o.id) || typeof o.linkId !== "string" || !LINK_ID_RE.test(o.linkId)) return null;
  if (!num(o.at) || !num(o.expiresAt) || !num(o.files) || !num(o.bytes)) return null;
  const from = ref(o.from);
  if (!from || !Array.isArray(o.roots) || !o.roots.length || !Array.isArray(o.recipients)) return null;
  const roots: LinkOffer["roots"] = [];
  for (const r of o.roots as Array<Record<string, unknown> | null>) {
    const name = r?.name;
    if (typeof name !== "string" || !name || name === "." || name === ".." || /[/\\\0]/.test(name) || !ROOT_KINDS.has(r!.kind as string) || !num(r!.files) || !num(r!.bytes)) return null;
    roots.push({ name, kind: r!.kind as LinkOffer["roots"][number]["kind"], files: r!.files as number, bytes: r!.bytes as number });
  }
  const recipients: LinkOfferRecipient[] = [];
  for (const r of o.recipients as Array<Record<string, unknown> | null>) {
    const to = ref(r?.to);
    if (!to || (r!.dest !== undefined && (typeof r!.dest !== "string" || !r!.dest))) return null;
    recipients.push({ to, state: r!.dest ? "accepted" : "offered", ...(r!.dest ? { dest: r!.dest as string, implicit: true } : {}) });
  }
  const snap = o.snapshot as Record<string, unknown> | undefined;
  const snapshot =
    snap && typeof snap.sha256 === "string" && /^[0-9a-f]{64}$/.test(snap.sha256) && num(snap.size) && num(snap.packedAt)
      ? { sha256: snap.sha256, size: snap.size, encoding: "zstd" as const, packedAt: snap.packedAt }
      : undefined;
  const strs = (x: unknown) => (Array.isArray(x) && x.every((s) => typeof s === "string") ? (x as string[]) : undefined);
  const exclude = strs(o.exclude);
  const warnings = Array.isArray(o.warnings)
    ? (o.warnings as Array<Record<string, unknown> | null>).filter(
        (w): w is Record<string, unknown> =>
          !!w && ((w.kind === "gitlink" && typeof w.root === "string" && typeof w.path === "string" && typeof w.gitdir === "string") || (w.kind === "changed" && typeof w.message === "string")),
      )
    : [];
  return {
    id: o.id,
    linkId: o.linkId,
    at: o.at,
    expiresAt: o.expiresAt,
    from,
    roots,
    files: o.files,
    bytes: o.bytes,
    ...(exclude?.length ? { exclude } : {}),
    ...(typeof o.note === "string" && o.note ? { note: o.note.slice(0, 2000) } : {}),
    ...(warnings.length ? { warnings: warnings as unknown as LinkOffer["warnings"] } : {}),
    ...(snapshot ? { snapshot } : {}),
    recipients,
  };
}

/** 41 MiB, 1.2 GiB, 820 B. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const fmtTook = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

/** "3 paths (proj/, notes.md, data/), 1204 files, 41 MiB. <note>. <warnings>" */
function offerWhat(o: LinkOffer, rootsLine: (r: LinkOffer["roots"]) => string): string {
  const n = o.roots.length;
  const parts = [`${n} path${n === 1 ? "" : "s"} (${rootsLine(o.roots)}), ${o.files} file${o.files === 1 ? "" : "s"}, ${fmtBytes(o.bytes)}.`];
  if (o.note) parts.push(`Note: ${o.note}`);
  for (const w of o.warnings ?? [])
    parts.push(w.kind === "gitlink" ? `Warning: ${w.path} is a git worktree pointer (gitdir: ${w.gitdir}); it carries no history.` : `Warning: ${w.message}`);
  return parts.join(" ");
}

/** The offer notice: as sent, as a recipient to answer it sees it, or as pulled at once (dest given). */
function offerText(o: LinkOffer, rootsLine: (r: LinkOffer["roots"]) => string, mode: { kind: "sent" } | { kind: "ask"; now: number } | { kind: "implicit"; dest: string }): string {
  const what = offerWhat(o, rootsLine);
  if (mode.kind === "sent") return `File offer ${o.id}: ${what}`;
  if (mode.kind === "implicit") return `File offer ${o.id}: ${what} Your host is pulling it into ${mode.dest}; you'll get one message when it lands.`;
  const hours = Math.max(1, Math.round((o.expiresAt - mode.now) / 3_600_000));
  return (
    `File offer ${o.id}: ${what} Accept with link_accept {offer:"${o.id}", dest:"<a directory>"} (relative = under your cwd; each path lands there under its own name), ` +
    `or link_decline {offer:"${o.id}"}. Expires in ${hours} h.`
  );
}

/** The receiver's one message when its row ends. */
function landedText(o: LinkOffer, row: LinkOfferRecipient, fromTitle: string, rootsLine: (r: LinkOffer["roots"]) => string): string {
  if (row.state !== "done") return `File transfer ${o.id} from "${fromTitle}" failed (${row.reason ?? row.state}): ${row.message ?? "no reason given"}.`;
  const took = row.startedAt !== undefined && row.doneAt !== undefined ? `, ${fmtTook(row.doneAt - row.startedAt)}` : "";
  const tail = [o.note ? `Note: ${o.note}` : "", ...(o.warnings ?? []).map((w) => (w.kind === "gitlink" ? `Warning: ${w.path} is a git worktree pointer (gitdir: ${w.gitdir}); it carries no history.` : `Warning: ${w.message}`))]
    .filter(Boolean)
    .join(" ");
  return `File transfer ${o.id} from "${fromTitle}" landed in ${row.resolvedDest ?? row.dest}: ${rootsLine(o.roots)} (${o.files} files, ${fmtBytes(o.bytes)}${took}).${tail ? ` ${tail}` : ""}`;
}

/** The sender's one wake: every recipient's row. */
function wakeText(o: LinkOffer, event: LinkOfferEvent, name: (r: LinkMemberRef) => string, rootsLine: (r: LinkOffer["roots"]) => string): string {
  const head = event === "finished" ? `File offer ${o.id} (${rootsLine(o.roots)}) is finished:` : `File offer ${o.id} (${rootsLine(o.roots)}) failed for a recipient:`;
  const size = o.snapshot?.size;
  const line = (r: LinkOfferRecipient): string => {
    if (r.state === "done") return `done into ${r.resolvedDest ?? r.dest}${r.startedAt !== undefined && r.doneAt !== undefined ? ` (${fmtTook(r.doneAt - r.startedAt)})` : ""}`;
    if (r.state === "declined") return `declined${r.message ? `: ${r.message}` : ""}`;
    if (r.state === "failed" || r.state === "refused") return `${r.state} (${r.reason ?? "?"})${r.message ? `: ${r.message}` : ""}`;
    if (r.state === "pulling" && r.received !== undefined) return `pulling ${fmtBytes(r.received)}${size ? ` / ${fmtBytes(size)}` : ""}`;
    return r.state;
  };
  return [head, ...o.recipients.map((r) => `- ${name(r.to)}: ${line(r)}`)].join("\n");
}

/** A member row's chip: the newest open transfer with that member, either way (`offers` newest first). */
function transferOf(offers: LinkOffer[], m: LinkMemberRef): { transfer: LinkedTransfer } | Record<string, never> {
  for (const o of offers) {
    const size = o.snapshot?.size;
    const open = o.recipients.filter((r) => !OFFER_FINAL.has(r.state));
    if (!open.length) continue;
    const pick = (dir: "in" | "out", r: LinkOfferRecipient): { transfer: LinkedTransfer } => ({
      transfer: { offerId: o.id, dir, state: r.state, ...(r.received !== undefined ? { received: r.received } : {}), ...(size !== undefined ? { size } : {}) },
    });
    if (sameRef(o.from, m)) return pick("out", open.find((r) => r.state !== "offered") ?? open[0]!);
    const mine = open.find((r) => sameRef(r.to, m));
    if (mine) return pick("in", mine);
  }
  return {};
}
