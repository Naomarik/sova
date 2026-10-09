// The offers of linked sessions (§mesh.links/offers, §mesh.links/transfer): each host's copies of
// the offers it sent or received, and what moves them on the byte side. Packing the spool at offer
// time, serving it to a recipient's host (403/404/410/503 here, the bytes in links-transfer.ts),
// pulling it on a recipient's host with resume and the pre-scan, the sweeper (expiry, orphans) and
// cancelling. The protocol acts, notices and the sender's one wake are server/mesh/links.ts, which
// hears every change here through `changed`.
//
// Store: `<stateRoot>/mesh-links/<linkId>/offers.json` (atomic, 0600), a sender's copy with every
// recipient row and a recipient's copy with its own row only. Bytes moving update `received` in
// memory, persisted at most every 5 s; a state change is written at once.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type LinkMemberRef, type LinkOffer, type LinkOfferRecipient, OFFER_FINAL, OFFER_ID_RE, type OfferRefusal, type OfferRowState } from "../../shared/mesh-links";
import { type LinkSandbox, linkSandbox } from "../link-sandbox";
import {
  checkDest,
  listOffer,
  type OfferListing,
  PullCancelled,
  Pulls,
  type PullTimings,
  resolveDest,
  type SandboxRead,
  type SandboxWrite,
  serveTar,
  Spools,
  tarAvailable,
  type TarRunner,
  TransferError,
} from "./links-transfer";

export { TransferError, type OfferListing };

const DAY_MS = 24 * 3_600_000;
/** An offer's life (24 h); SOVA_LINK_OFFER_TTL_MS overrides it for tests and the lab only. */
export const OFFER_TTL_MS = Number(process.env.SOVA_LINK_OFFER_TTL_MS) > 0 ? Number(process.env.SOVA_LINK_OFFER_TTL_MS) : DAY_MS;
/** A pull still moving bytes keeps its row open this long after the last byte. */
export const PULL_GRACE_MS = 3_600_000;
/** The sweeper's period while any offer is open: hourly, sooner under a short test TTL. */
export const SWEEP_EVERY_MS = Math.max(1_000, Math.min(3_600_000, Math.floor(OFFER_TTL_MS / 4)));
/** `received` is written to disk at most this often while bytes move. */
const PERSIST_EVERY_MS = 5_000;
/** A `progress` event per offer at most this often. */
const PROGRESS_EVERY_MS = 2_000;
/** Final offers older than this leave the store. */
const KEEP_FINAL_MS = 30 * DAY_MS;

export const newOfferId = () => `of_${randomBytes(8).toString("hex")}`;

/** What happened to an offer copy (already saved) that server/mesh/links.ts reacts to. */
export type TransferEvent =
  | { kind: "packed" }
  | { kind: "pack-failed"; reason: OfferRefusal; message: string }
  /** The sender: a recipient's first GET moved its row to pulling. */
  | { kind: "serving"; to: LinkMemberRef }
  /** Bytes moved (either side); at most one per offer every 2 s. */
  | { kind: "progress"; to: LinkMemberRef }
  /** The recipient: its row moved (pulling, extracting, done, failed, refused). */
  | { kind: "row"; to: LinkMemberRef; state: OfferRowState }
  | { kind: "expired"; rows: LinkMemberRef[] };

export interface TransferDeps {
  /** `<stateRoot>`, per call. */
  root(): string;
  homedir(): string;
  /** Sova's state root and sessions dir: never written by a transfer. */
  protectedRoots(): string[];
  /** A local session's sandbox now (server/link-sandbox.ts). */
  sandboxOf(sessionId: string): Promise<LinkSandbox>;
  selfNodeId(): string | null;
  /** Whether a node id is one of this host's names (§mesh.links/host-names). */
  isSelf(nodeId: string): boolean;
  /** The link still runs (an ended link's offers are cancelled by the sweeper). */
  linkLive(linkId: string): boolean;
  /** A GET to a member host by nodeId (mesh peerFetch); throws when it can't be reached. */
  peerGet(nodeId: string, path: string, init: RequestInit): Promise<Response>;
  /** Never throws. */
  changed(offer: LinkOffer, ev: TransferEvent): void;
  now?(): number;
  /** Tests: the pull's idle and retry timings. */
  timings?: Partial<PullTimings>;
  /** How tar runs for packs and pulls (default: `tar` on this host, probed once). Tests: in-process. */
  tar?: TarRunner;
}

const open = (o: LinkOffer) => o.recipients.some((r) => !OFFER_FINAL.has(r.state));
/** The sender's copy (it packs); a recipient's copy never carries `packing`. */
const sent = (o: LinkOffer) => o.packing !== undefined;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

export class LinkTransfers {
  private d: TransferDeps | null = null;
  private spools: Spools | null = null;
  private pulls: Pulls | null = null;
  /** linkId → its offers; loaded once from every link dir. */
  private byLink: Map<string, LinkOffer[]> | null = null;
  private tar: boolean | null = null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly jobs = new Set<string>();
  private readonly dirty = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly progressAt = new Map<string, number>();

  configure(deps: TransferDeps): void {
    this.d = deps;
    this.byLink = null;
    this.spools = new Spools({ root: deps.root, now: () => this.now(), ...(deps.tar ? { tar: deps.tar } : {}) });
    this.pulls = new Pulls({
      root: deps.root,
      now: () => this.now(),
      ...(deps.tar ? { tar: deps.tar } : {}),
      ...(deps.timings ? { timings: deps.timings } : {}),
      fetchTar: (o) => deps.peerGet(o.senderNodeId, o.path, { headers: o.headers, signal: o.signal }),
    });
  }

  private get deps(): TransferDeps {
    if (!this.d) throw new Error("link transfers are not configured");
    return this.d;
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The mesh is on: load the offers, fail packs a restart cut short, resume pulls, sweep. Idempotent. */
  start(): void {
    if (!this.d || this.running) return;
    this.running = true;
    void (this.d.tar ? Promise.resolve(true) : tarAvailable()).then((ok) => (this.tar = ok));
    for (const o of this.all()) {
      if (o.packing?.state === "packing") {
        // The pack list lives only in the process that listed it.
        const next = this.update(o.id, (x) => {
          x.packing = { state: "failed", error: "the host restarted while packing" };
        });
        if (next) this.deps.changed(next, { kind: "pack-failed", reason: "internal", message: "This host restarted while packing the offer; offer it again." });
      }
    }
    this.sweep();
    for (const o of this.all()) {
      const r = o.recipients[0];
      if (!sent(o) && r && (r.state === "accepted" || r.state === "pulling" || r.state === "extracting")) this.queuePull(o.id);
    }
  }

  /** The mesh is off: no timer and no new pull. */
  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [id, t] of this.dirty) {
      clearTimeout(t);
      this.saveLink(id);
    }
    this.dirty.clear();
  }

  /** False only once `tar --version` failed on this host. */
  hasTar(): boolean {
    return this.tar !== false;
  }

  // ---- the store ------------------------------------------------------------------------------

  private file(linkId: string): string {
    return join(this.deps.root(), "mesh-links", linkId, "offers.json");
  }

  private load(): Map<string, LinkOffer[]> {
    if (this.byLink) return this.byLink;
    const map = new Map<string, LinkOffer[]>();
    const dir = join(this.deps.root(), "mesh-links");
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    for (const n of names) {
      if (!n.startsWith("lk_")) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, n, "offers.json"), "utf8")) as { offers?: unknown };
        const offers = Array.isArray(raw.offers) ? (raw.offers as LinkOffer[]).filter((o) => o && typeof o.id === "string" && OFFER_ID_RE.test(o.id)) : [];
        if (offers.length) map.set(n, offers);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[links] ${n}/offers.json unreadable: ${(err as Error).message}`);
      }
    }
    this.byLink = map;
    // An offer naming this host by another of its names (made before it joined a tailnet) takes the
    // name it keeps for itself (§mesh.links/host-names).
    const self = this.deps.selfNodeId();
    if (self) {
      for (const [linkId, offers] of map) {
        let changed = false;
        const fix = (r: LinkMemberRef) => {
          if (r.nodeId === self || !this.deps.isSelf(r.nodeId)) return;
          r.nodeId = self;
          changed = true;
        };
        for (const o of offers) {
          fix(o.from);
          for (const r of o.recipients) fix(r.to);
        }
        if (changed) this.saveLink(linkId);
      }
    }
    return map;
  }

  private saveLink(linkId: string): void {
    const t = this.dirty.get(linkId);
    if (t) clearTimeout(t);
    this.dirty.delete(linkId);
    const offers = this.load().get(linkId) ?? [];
    writeAtomic(this.file(linkId), `${JSON.stringify({ version: 1, offers }, null, 2)}\n`);
  }

  /** Written within PERSIST_EVERY_MS (bytes moving). */
  private saveSoon(linkId: string): void {
    if (this.dirty.has(linkId)) return;
    const t = setTimeout(() => this.saveLink(linkId), PERSIST_EVERY_MS);
    t.unref?.();
    this.dirty.set(linkId, t);
  }

  /** Every offer copy on this host. */
  all(): LinkOffer[] {
    return [...this.load().values()].flat();
  }
  get(offerId: string): LinkOffer | null {
    for (const list of this.load().values()) {
      const o = list.find((x) => x.id === offerId);
      if (o) return o;
    }
    return null;
  }
  ofLink(linkId: string): LinkOffer[] {
    return [...(this.load().get(linkId) ?? [])];
  }
  /** As the sender, or as a recipient row. */
  ofSession(sessionId: string): LinkOffer[] {
    const self = (nodeId: string) => this.deps.isSelf(nodeId);
    return this.all().filter((o) => (o.from.sessionId === sessionId && self(o.from.nodeId)) || o.recipients.some((r) => r.to.sessionId === sessionId && self(r.to.nodeId)));
  }
  /** Insert or replace, written at once. */
  put(offer: LinkOffer): void {
    const map = this.load();
    const list = map.get(offer.linkId) ?? [];
    const i = list.findIndex((o) => o.id === offer.id);
    if (i >= 0) list[i] = offer;
    else list.push(offer);
    map.set(offer.linkId, list);
    this.saveLink(offer.linkId);
    if (open(offer)) this.arm(true);
  }
  /** Change an offer in place and write it; null when there is no such offer. */
  update(offerId: string, fn: (o: LinkOffer) => void): LinkOffer | null {
    const o = this.get(offerId);
    if (!o) return null;
    fn(o);
    this.saveLink(o.linkId);
    this.releaseIfDone(o);
    return o;
  }

  /** The sender's spool goes once every row is final. */
  private releaseIfDone(o: LinkOffer): void {
    if (open(o) || !sent(o)) return;
    if (this.spools?.status(o.id)) this.spools.remove(o.id);
  }

  // ---- the sender ------------------------------------------------------------------------------

  /** List what is offered, the sender's sandbox binding it. Throws TransferError. */
  list(req: { cwd: string; paths: string[]; exclude?: string[]; sandbox: LinkSandbox }): Promise<OfferListing> {
    const sb = req.sandbox;
    const read: SandboxRead | null = sb.on ? { readDenial: (c) => linkSandbox.read(sb, c), hiddenBelow: (r) => linkSandbox.hiddenBelow(sb, r) } : null;
    return listOffer({ cwd: req.cwd, home: this.deps.homedir(), paths: req.paths, ...(req.exclude ? { exclude: req.exclude } : {}), sandbox: read });
  }

  /** Pack the spool in the background (one at a time on this host). */
  pack(offer: LinkOffer, listing: OfferListing): void {
    const spools = this.spools!;
    void spools
      .pack(offer.id, listing, (written) => {
        const o = this.get(offer.id);
        if (o?.packing) o.packing.written = written;
      })
      .then(
        (r) => {
          const o = this.update(offer.id, (x) => {
            x.snapshot = { sha256: r.sha256, size: r.size, encoding: "zstd", packedAt: r.packedAt };
            x.packing = { state: "ready", written: r.size };
            if (r.warning) x.warnings = [...(x.warnings ?? []), r.warning];
          });
          if (o) this.deps.changed(o, { kind: "packed" });
        },
        (err) => {
          const reason: OfferRefusal = err instanceof TransferError ? err.reason : "internal";
          const message = err instanceof Error ? err.message : String(err);
          spools.remove(offer.id);
          const was = this.get(offer.id);
          // Withdrawn because every row ended (declined, refused, expired, cancelled): nothing failed.
          const withdrawn = !!was && !open(was);
          const o = this.update(offer.id, (x) => {
            x.packing = { state: "failed", error: withdrawn ? "withdrawn: every recipient is done with it" : message };
          });
          if (o && !withdrawn) this.deps.changed(o, { kind: "pack-failed", reason, message });
        },
      );
  }

  /**
   * GET …/tar for `callerNodeId`: 403 not a recipient (or not accepted yet), 410 its row is final
   * or the spool is gone, 503 still packing; else the spool with Range. The first GET moves the
   * row to pulling; bytes served are its `received`.
   */
  async serve(offerId: string, callerNodeId: string, h: { range?: string; ifRange?: string }): Promise<Response> {
    const o = this.get(offerId);
    if (!o || !sent(o)) return json(404, { error: "No such offer on this host.", reason: "unknown-link" });
    const row = o.recipients.find((r) => r.to.nodeId === callerNodeId);
    if (!row) return json(403, { error: "Your host is not a recipient of that offer.", reason: "not-member" });
    if (OFFER_FINAL.has(row.state)) return json(410, { error: `The offer is ${row.state} for you.`, reason: row.reason ?? (row.state === "cancelled" ? "ended" : "internal") });
    if (row.state === "offered") return json(403, { error: "The offer hasn't been accepted for you yet.", reason: "not-member" });
    if (o.packing?.state === "failed") return json(410, { error: `The offer failed to pack: ${o.packing.error ?? "?"}`, reason: "internal" });
    if (!o.snapshot) return json(503, { state: "packing", written: o.packing?.written ?? 0 }, { "Retry-After": "5" });
    const file = this.spools!.file(o.id);
    const st = this.spools!.status(o.id);
    if (!st || st.state !== "ready" || !existsSync(file)) return json(410, { error: "The offer's spool is gone.", reason: "internal" });
    if (row.state === "accepted") {
      row.state = "pulling";
      row.startedAt = this.now();
      this.saveLink(o.linkId);
      this.deps.changed(o, { kind: "serving", to: row.to });
    }
    return serveTar({
      file,
      sha256: o.snapshot.sha256,
      size: o.snapshot.size,
      ...(h.range ? { range: h.range } : {}),
      ...(h.ifRange ? { ifRange: h.ifRange } : {}),
      onServed: (at) => {
        if (at > (row.received ?? 0)) row.received = at;
        row.lastByteAt = this.now();
        this.saveSoon(o.linkId);
        this.progress(o, row.to);
      },
    });
  }

  private progress(o: LinkOffer, to: LinkMemberRef): void {
    const last = this.progressAt.get(o.id) ?? 0;
    if (Date.now() - last < PROGRESS_EVERY_MS) return;
    this.progressAt.set(o.id, Date.now());
    this.deps.changed(o, { kind: "progress", to });
  }

  // ---- the recipient ---------------------------------------------------------------------------

  /** dest as this host reads it, canonical. Throws TransferError bad-dest. */
  resolveDest(cwd: string, dest: string): string {
    return resolveDest(dest, { cwd, home: this.deps.homedir() });
  }

  /** The checks before anything is pulled (protected roots, the recipient's sandbox). Throws TransferError. */
  checkDest(resolvedDest: string, rootNames: string[], sandbox: LinkSandbox): void {
    const write: SandboxWrite | null = sandbox.on ? { writeDenial: (c, opts) => linkSandbox.write(sandbox, c, opts) } : null;
    checkDest({ resolvedDest, rootNames, protectedRoots: this.deps.protectedRoots(), sandbox: write });
  }

  /** Start (or resume) the pull of an accepted row; its outcome comes back as `row` events. */
  queuePull(offerId: string): void {
    if (!this.running || this.jobs.has(offerId)) return;
    const o = this.get(offerId);
    const row = o?.recipients[0];
    if (!o || sent(o) || !row?.resolvedDest || !(row.state === "accepted" || row.state === "pulling" || row.state === "extracting")) return;
    this.jobs.add(offerId);
    void this.runPull(o, row).finally(() => this.jobs.delete(offerId));
  }

  private setRow(o: LinkOffer, row: LinkOfferRecipient, patch: Partial<LinkOfferRecipient>): void {
    if (OFFER_FINAL.has(row.state)) return;
    Object.assign(row, patch);
    this.saveLink(o.linkId);
    this.releaseIfDone(o);
    this.deps.changed(o, { kind: "row", to: row.to, state: row.state });
  }

  private async runPull(o: LinkOffer, row: LinkOfferRecipient): Promise<void> {
    const dest = row.resolvedDest!;
    const sb = await this.deps.sandboxOf(row.to.sessionId);
    const prot = this.deps.protectedRoots();
    if (row.state === "accepted") this.setRow(o, row, { state: "pulling", startedAt: this.now() });
    try {
      const r = await this.pulls!.pull({
        offerId: o.id,
        linkId: o.linkId,
        from: o.from.nodeId,
        ...(o.snapshot ? { snapshot: { sha256: o.snapshot.sha256, size: o.snapshot.size } } : {}),
        resolvedDest: dest,
        rootNames: o.roots.map((x) => x.name),
        onSnapshot: (s) => {
          o.snapshot = { sha256: s.sha256, size: s.size, encoding: "zstd", packedAt: o.snapshot?.packedAt ?? this.now() };
          this.saveLink(o.linkId);
        },
        onProgress: (p) => {
          row.received = p.received;
          row.retries = p.retries;
          row.lastByteAt = p.lastByteAt;
          this.saveSoon(o.linkId);
          this.progress(o, row.to);
        },
        onExtracting: () => this.setRow(o, row, { state: "extracting" }),
        // Always, sandbox or not: the archive's shape and Sova's state are checked before tar runs.
        prescan: async (members) => {
          const no = await linkSandbox.prescan(members, { dest, roots: o.roots.map((x) => x.name), sandbox: sb, protectedRoots: prot });
          if (no) throw new TransferError(no.reason, no.message);
        },
      });
      const doneAt = this.now();
      this.setRow(o, row, { state: "done", received: r.received, doneAt, startedAt: doneAt - r.took });
    } catch (err) {
      if (err instanceof PullCancelled) return;
      const reason: OfferRefusal = err instanceof TransferError ? err.reason : "internal";
      const refusal = reason === "not-writable" || reason === "protected" || reason === "bad-dest";
      this.setRow(o, row, { state: refusal ? "refused" : "failed", reason, message: err instanceof Error ? err.message : String(err), doneAt: this.now() });
    }
  }

  /** A sender's host came back: its waiting pulls try at once, and rows not started get going. */
  onPeerUp(nodeId: string): void {
    this.pulls?.kick(nodeId);
    for (const o of this.all()) if (!sent(o) && o.from.nodeId === nodeId && o.recipients[0]?.state === "accepted") this.queuePull(o.id);
  }

  // ---- both ------------------------------------------------------------------------------------

  /** A link ended: its open offers are cancelled, spools and downloads deleted. The ones changed. */
  cancel(linkId: string): LinkOffer[] {
    const out: LinkOffer[] = [];
    for (const o of this.ofLink(linkId)) {
      if (!open(o)) continue;
      for (const r of o.recipients)
        if (!OFFER_FINAL.has(r.state)) Object.assign(r, { state: "cancelled", reason: "ended", message: "The link ended.", doneAt: this.now() } satisfies Partial<LinkOfferRecipient>);
      this.pulls?.cancel(o.id);
      this.spools?.remove(o.id);
      out.push(o);
    }
    if (out.length) this.saveLink(linkId);
    return out;
  }

  /**
   * Expire rows past their time (a pull that moved bytes in the last hour gets another hour), cancel
   * the offers of ended links, release finished spools, delete orphaned files, and drop final
   * offers older than 30 days. Runs at start and hourly while anything is open.
   */
  sweep(): void {
    if (!this.d) return;
    const now = this.now();
    for (const [linkId, list] of this.load()) {
      if (!this.deps.linkLive(linkId) && list.some(open)) this.cancel(linkId);
      let changed = false;
      for (const o of list) {
        const gone: LinkMemberRef[] = [];
        for (const r of o.recipients) {
          if (OFFER_FINAL.has(r.state)) continue;
          let until = r.expiresAt ?? o.expiresAt;
          if ((r.state === "pulling" || r.state === "extracting") && r.lastByteAt !== undefined && r.lastByteAt + PULL_GRACE_MS > until) {
            until = r.lastByteAt + PULL_GRACE_MS;
            r.expiresAt = until;
            changed = true;
          }
          if (now < until || r.state === "extracting") continue;
          Object.assign(r, { state: "expired", doneAt: now } satisfies Partial<LinkOfferRecipient>);
          gone.push(r.to);
          changed = true;
        }
        if (gone.length) {
          if (!sent(o)) this.pulls?.cancel(o.id);
          this.releaseIfDone(o);
          this.deps.changed(o, { kind: "expired", rows: gone });
        }
      }
      const keep = list.filter((o) => open(o) || now - o.at < KEEP_FINAL_MS);
      if (keep.length !== list.length) {
        this.load().set(linkId, keep);
        changed = true;
      }
      if (changed) this.saveLink(linkId);
    }
    const openIds = new Set(this.all().filter(open).map((o) => o.id));
    this.spools?.sweep(openIds);
    this.arm(openIds.size > 0);
  }

  private arm(on: boolean): void {
    if (on && !this.timer && this.running) {
      this.timer = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
      this.timer.unref?.();
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Tests: a restart's view (the store re-read, nothing running). */
  forgetForTest(): void {
    this.stop();
    this.byLink = null;
    this.jobs.clear();
  }

  /** Tests: whether a pull runs for this offer. */
  pulling(offerId: string): boolean {
    return this.jobs.has(offerId);
  }
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

