import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatLinkMessage, LINK_ID_RE, LINK_MESSAGE_ID_RE } from "../../shared/link-message";
import type {
  LinkCreate,
  LinkDelivery,
  LinkedAgentInfo,
  LinkError,
  LinkInboxRecord,
  LinkMember,
  LinkMemberRef,
  LinkMemberView,
  LinkMessage,
  LinkOutboxEntry,
  LinkRefusal,
  LinkSeen,
  LinkSend,
  LinkSendResult,
  LinkThread,
  MeshLink,
  MeshLinksFile,
  MeshLinkView,
  PeerLinkCopy,
  PeerLinkEnd,
  PeerLinkEndResult,
  PeerLinkMessage,
  PeerLinkMessageResult,
} from "../../shared/mesh-links";
import type { PeerState, SessionSummary } from "../../shared/protocol";
import type { MeshApi } from "./index";
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
}

/** A local act's refusal: the route answers `status` with `body`. */
export class LinkActError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 502,
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

  /** Wire the module to the server (server/index.ts via mountLinks) or to a test's fakes. */
  configure(deps: LinksDeps): void {
    this.d = deps;
    this.file = null;
    deps.mesh.onPeerUp((peerId) => void this.flush(peerId));
    deps.mesh.onMeshStart(() => {
      if (this.outbox().length) this.arm();
    });
    deps.mesh.onMeshStop(() => this.disarm());
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
    const s = got.summary ?? undefined;
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
    if (this.keep({ ...link, endedAt: Math.min(endedAt, this.now()) })) this.notify(this.localSessions(link));
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
    const live = this.linksOf(req.session).filter((l) => l.endedAt === undefined);
    let link: MeshLink | undefined;
    if (req.link !== undefined) {
      link = this.linksOf(req.session).find((l) => l.id === req.link);
      if (!link) throw new LinkActError(404, { error: `This session is not in link ${req.link}.`, reason: "not-member" });
      if (link.endedAt !== undefined) throw new LinkActError(409, { error: `Link ${link.id} has ended.`, reason: "ended" });
    } else if (live.length === 1) link = live[0];
    else if (!live.length) throw new LinkActError(409, { error: "This session is in no link.", reason: "not-member" });
    else throw new LinkActError(400, { error: `This session is in ${live.length} links; name one with \`link\` (${live.map((l) => l.id).join(", ")}).` });
    const me = this.localMember(link!)!;
    const targets = await this.recipients(link!, me, req.to);
    const msg: LinkMessage = { id: newLinkMessageId(), linkId: link!.id, at: this.now(), from: refOf(me), to: targets.map(refOf), text: req.text };
    const fromTitle = (await this.deps.summary(me.sessionId))?.title;
    // The sender's record first, so a quick reply never lands in its inbox before it.
    this.upsertInbox(link!.id, me.sessionId, { ...msg, dir: "out", deliveries: targets.map((t) => ({ to: refOf(t), state: "outbox" as const })) });
    const deliveries = await Promise.all(
      targets.map((t) => this.tell(t.nodeId, { kind: "message", linkId: link!.id, body: { message: msg, ...(fromTitle ? { fromTitle } : {}) } }, link!)),
    );
    const out = deliveries.map((d, i) => toDelivery(refOf(targets[i]!), d));
    this.upsertInbox(link!.id, me.sessionId, { ...msg, dir: "out", deliveries: out });
    this.notify([me.sessionId]);
    return { linkId: link!.id, messageId: msg.id, deliveries: out };
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
      let hit = others.filter((m) => m.sessionId === w || m.nodeId === w || this.peerOfNode(m.nodeId)?.id === w || this.hostLabel(m.nodeId).toLowerCase() === lw);
      if (!hit.length) {
        const titled = await Promise.all(others.map(async (m) => ((await this.lookupMember(m.nodeId, m.sessionId)).summary?.title ?? "").toLowerCase() === lw));
        hit = others.filter((_, i) => titled[i]);
      }
      if (!hit.length) throw new LinkActError(400, { error: `No other member of ${link.id} is "${w}". Members: ${others.map((m) => `${this.hostLabel(m.nodeId)}/${m.sessionId}`).join(", ")}.` });
      for (const m of hit) picked.add(m);
    }
    return [...picked];
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

  private async hopWithCopy(nodeId: string, item: { kind: LinkOutboxEntry["kind"]; body: unknown; linkId?: string }, link?: MeshLink): Promise<HopResult> {
    const r = await this.hop(nodeId, pathOf(item), item.body);
    if (item.kind !== "message" || r.state !== "final" || r.status !== 404 || r.body?.reason !== "unknown-link") return r;
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
  /** Stop the retry timer (shutdown, tests). */
  stop(): void {
    this.disarm();
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
        if (e.kind === "message") this.settleMessage(e, toDelivery({ nodeId: e.toNodeId, sessionId: recipientOf(e) }, r));
        else if (r.state !== "sent") console.warn(`[links] ${e.kind} for ${e.toNodeId} dropped: ${r.why}`);
      }
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
    return { link, messages: [...byId.values()].sort((a, b) => a.at - b.at) };
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

function pathOf(item: { kind: LinkOutboxEntry["kind"]; linkId?: string; body: unknown }): string {
  if (item.kind === "link") return "/api/peer/links";
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
