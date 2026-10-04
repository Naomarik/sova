import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNTS_DIR_NAME,
  LOCAL_DEVICE_ID,
  clearLeaving,
  isLoginId,
  markLeaving,
  pidAlive,
  planLabel,
  poolAgentPath,
  readAccounts,
  readAccountsState,
  readLeaving,
  readLoginUse,
  readWants,
  updateAccounts,
  type ClaudeLoginIdentity,
  type LeavingReason,
} from "../../pi-config/extensions/claude-code/accounts.ts";
import type { ClaudePoolInfo, ClaudePoolLogin } from "../../shared/protocol";
import { writeFileAtomic } from "../sync/logins-stores";
import {
  activateStaged,
  credentialsHash,
  credentialsText,
  deleteLoginFiles,
  dropStaged,
  hasCredentials,
  hasStaged,
  plausibleFiles,
  readLoginFiles,
  stageLoginFiles,
  storeLoginFiles,
  INCOMING_DIR_NAME,
  type LoginFiles,
} from "./creds";
import { emptyDoc, mergeDocs, newPoolLogin, parseDoc, poolOrder, reg, sameDoc, standingNow, type PoolDoc, type PoolLogin, type PoolStanding, type PoolUsage } from "./doc";
import { readJournal, setOp, type JournalOp } from "./journal";

/**
 * The pool agent (§app.claude-logins/pool … /migration): one per Sova server while the mesh is on.
 * It keeps the pool document, lends free logins while this device is the keeper, borrows for the
 * processes here that need one (their `claude-pool/wants/`), returns logins (limit, sign-in
 * failure, the user's request, a pin elsewhere, 30 minutes idle), and replays its journal after a
 * crash. Transport-agnostic: peers are `PoolPeer`s (HTTP over the peer listener in production,
 * direct calls in tests).
 *
 * Invariants (DESIGN-phase2.md §0): a login runs on at most one device (a second copy exists only
 * staged or leaving, never selected, every process on it drained); a copy is deleted only after
 * the receiver stored its own; `holder.seq` is advanced only by the device that durably has the
 * credentials for the new holder.
 */

export interface LendRequest {
  requestId: string;
  excludeAccounts?: string[];
  excludeLogins?: string[];
  /** Only this login (a pinned one the asker takes proactively). */
  only?: string;
}
export type LendReply =
  | { offer: { id: string; seq: number; files: LoginFiles; identity: ClaudeLoginIdentity | null; addedAt: number } }
  | { none: string };
export interface CommitRequest { requestId: string; id: string; seq: number }
export type CommitReply = { ok: true; doc: PoolDoc } | { cancelled: string };
export interface ReturnRequest {
  id: string;
  /** The holder seq the sender held it at. */
  seq: number;
  files: LoginFiles;
  standing: PoolStanding | null;
  identity: ClaudeLoginIdentity | null;
  addedAt: number;
}
export type ReturnReply = { ok: true; doc: PoolDoc } | { refused: string; superseded?: boolean };

export interface PoolPeer {
  readonly id: string;
  doc(): Promise<PoolDoc>;
  pushDoc(doc: PoolDoc): Promise<PoolDoc>;
  lend(req: LendRequest): Promise<LendReply>;
  commit(req: CommitRequest): Promise<CommitReply>;
  giveBack(req: ReturnRequest): Promise<ReturnReply>;
}

export interface PoolAgentOptions {
  agentDir: string;
  stateDir: string;
  /** This device's mesh id. */
  self: () => string;
  selfLabel?: () => string;
  peers: () => PoolPeer[];
  /** Peer labels and up-state, for the view and for "stuck". */
  peerInfo?: () => Array<{ id: string; label: string; up: boolean }>;
  /** Claude Code's own directory here (a login's shared links point into it). */
  defaultClaudeDir: string;
  /** false: this device syncs API keys only and never holds a subscription login. */
  canHold?: () => boolean;
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  /** Whether a lease's child pid is still a process on that login directory (accounts.ts claudeRunsOn). */
  runsOn?: (pid: number, dir: string, since?: number, now?: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  idleMs?: number;
  offerTtlMs?: number;
  /** Drain bounds: after a limit/auth failure or idleness, and after the user's request or a pin. */
  quickCutMs?: number;
  slowCutMs?: number;
  tickMs?: number;
  syncMs?: number;
  /** Test seam: throws at a named step to simulate a crash there. */
  crash?: (step: string) => void;
  /**
   * Processes that run `claude` with CLAUDE_CONFIG_DIR = a login's directory, by directory: the
   * safety net for processes that keep no lease (started before this version, or by hand).
   * Default: Linux /proc; elsewhere nothing.
   */
  procScan?: () => Map<string, number[]>;
  log?: (message: string) => void;
}

const IDLE_MS = 30 * 60_000;
const OFFER_TTL_MS = 2 * 60_000;
const QUICK_CUT_MS = 2 * 60_000;
const SLOW_CUT_MS = 15 * 60_000;
const TICK_MS = 5_000;
const SYNC_MS = 60_000;
const KILL_GRACE_MS = 10_000;

/**
 * `claude` processes by the CLAUDE_CONFIG_DIR in their environment (Linux /proc; this user's
 * processes only, the rest are unreadable). A process counts when its command is `claude`, or its
 * command line names claude (a node-run CLI). Its own descendants inherit the variable but are
 * not counted, so a tool's shell is never taken for Claude.
 */
export function scanClaudeProcs(): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (process.platform !== "linux") return out;
  let pids: string[] = [];
  try { pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n)); } catch { return out; }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let env: string;
    try { env = readFileSync(`/proc/${pid}/environ`, "latin1"); } catch { continue; }
    const at = env.indexOf("CLAUDE_CONFIG_DIR=");
    if (at < 0 || (at > 0 && env[at - 1] !== "\0")) continue;
    const dir = env.slice(at + "CLAUDE_CONFIG_DIR=".length, env.indexOf("\0", at) < 0 ? undefined : env.indexOf("\0", at));
    let comm = "";
    let cmd = "";
    try { comm = readFileSync(`/proc/${pid}/comm`, "latin1").trim(); } catch { /* gone */ }
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, "latin1"); } catch { /* gone */ }
    if (comm !== "claude" && !/(^|[\/\0 ])claude([\0 .\-]|$)|fake-claude/.test(cmd)) continue;
    const list = out.get(dir) ?? [];
    list.push(Number(pid));
    out.set(dir, list);
  }
  return out;
}

export const poolDocPath = (stateDir: string): string => join(stateDir, "claude-pool.json");

export class PoolAgent {
  private readonly o: Required<Pick<PoolAgentOptions, "idleMs" | "offerTtlMs" | "quickCutMs" | "slowCutMs" | "tickMs" | "syncMs">> & PoolAgentOptions;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private timer?: ReturnType<typeof setInterval>;
  private syncTimer?: ReturnType<typeof setInterval>;
  private pushTimer?: ReturnType<typeof setTimeout>;
  /** Logins with an async step running in this process (one at a time per login). */
  private readonly busyIds = new Set<string>();
  private borrowing = false;
  private readonly startedAt: number;
  private ticking = false;
  /** This pass's /proc view (scanClaudeProcs): read once per tick or incoming call, dropped after. */
  private procs?: { at: number; map: Map<string, number[]> };

  constructor(options: PoolAgentOptions) {
    this.o = { idleMs: IDLE_MS, offerTtlMs: OFFER_TTL_MS, quickCutMs: QUICK_CUT_MS, slowCutMs: SLOW_CUT_MS, tickMs: TICK_MS, syncMs: SYNC_MS, ...options };
    this.now = options.now ?? Date.now;
    this.alive = options.pidAlive ?? pidAlive;
    this.startedAt = this.now();
  }

  private get self(): string { return this.o.self(); }
  private log(message: string): void { (this.o.log ?? ((m) => console.log(`[claude-pool] ${m}`)))(message); }
  private crash(step: string): void { this.o.crash?.(step); }
  private canHold(): boolean { return this.o.canHold?.() ?? true; }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Recover the journal, form or join the pool (migration), start the timers. */
  async start(): Promise<void> {
    this.heartbeat();
    this.migrate();
    await this.tick();
    if (this.o.tickMs > 0) {
      this.timer = setInterval(() => void this.tick(), this.o.tickMs);
      this.timer.unref?.();
    }
    if (this.o.syncMs > 0) {
      this.syncTimer = setInterval(() => void this.syncAll(), this.o.syncMs);
      this.syncTimer.unref?.();
    }
    void this.syncAll();
  }

  stop(): void {
    clearInterval(this.timer);
    clearInterval(this.syncTimer);
    clearTimeout(this.pushTimer);
    this.timer = this.syncTimer = this.pushTimer = undefined;
    try { rmSync(poolAgentPath(this.o.agentDir), { force: true }); } catch { /* gone */ }
  }

  private heartbeat(): void {
    try {
      mkdirSync(join(this.o.agentDir, "claude-pool"), { recursive: true });
      writeFileAtomic(poolAgentPath(this.o.agentDir), JSON.stringify({ v: 1, pid: process.pid, at: this.now(), device: this.self }));
    } catch (err) {
      this.log(`heartbeat: ${String(err)}`);
    }
  }

  // ---- the document -------------------------------------------------------------------------

  doc(): PoolDoc {
    try {
      return parseDoc(JSON.parse(readFileSync(poolDocPath(this.o.stateDir), "utf8"))) ?? emptyDoc();
    } catch {
      return emptyDoc();
    }
  }
  private writeDoc(doc: PoolDoc): void {
    mkdirSync(this.o.stateDir, { recursive: true });
    writeFileAtomic(poolDocPath(this.o.stateDir), `${JSON.stringify(doc)}\n`);
  }
  /** Read, change, write (when changed), and push to the peers soon. */
  updateDoc(change: (doc: PoolDoc) => void): PoolDoc {
    const before = this.doc();
    const next = structuredClone(before);
    change(next);
    if (!sameDoc(before, next)) {
      this.writeDoc(next);
      this.schedulePush();
    }
    return next;
  }
  /** Merge a peer's document in; true when ours changed. */
  mergeIn(theirs: PoolDoc): boolean {
    const ours = this.doc();
    const merged = mergeDocs(ours, theirs);
    if (sameDoc(ours, merged)) return false;
    this.writeDoc(merged);
    return true;
  }
  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      void this.pushAll();
    }, 300);
    this.pushTimer.unref?.();
  }
  async pushAll(): Promise<void> {
    const doc = this.doc();
    await Promise.all(this.o.peers().map(async (peer) => {
      try {
        const back = await peer.pushDoc(doc);
        if (this.mergeIn(back)) this.schedulePush();
      } catch { /* down: it pulls when it comes up */ }
    }));
  }
  /** Pull from and push to every peer (and after a peer comes up: `syncWith`). */
  async syncAll(): Promise<void> {
    await Promise.all(this.o.peers().map((p) => this.syncWith(p)));
  }
  async syncWith(peer: PoolPeer): Promise<void> {
    try {
      const theirs = await peer.doc();
      this.mergeIn(theirs);
      const back = await peer.pushDoc(this.doc());
      this.mergeIn(back);
    } catch { /* down */ }
  }

  /** POST /api/peer/claude-pool/doc: merge theirs, answer the merged document. */
  receiveDoc(theirs: unknown): PoolDoc | null {
    const doc = parseDoc(theirs);
    if (!doc) return null;
    this.mergeIn(doc);
    return this.doc();
  }

  // ---- migration (§app.claude-logins/migration) -----------------------------------------------

  /**
   * Every login already here joins the pool where it is: held by this device (or kept free here,
   * `device: null`), `local` rewritten to the mesh id. A login kept free here that a process still
   * runs on (the mesh was off) is claimed as held first, so it is never lent under it. Nothing is
   * signed out, moved or deleted.
   */
  migrate(): void {
    const self = this.self;
    const now = this.now();
    let accounts;
    try {
      accounts = readAccounts(this.o.agentDir);
    } catch {
      return;
    }
    if (accounts.state === "malformed") return;
    const claimed = new Set<string>();
    const rewrite = accounts.value.logins.some((l) => l.device === LOCAL_DEVICE_ID)
      || accounts.value.logins.some((l) => l.device === null && this.use(l.id).inUse);
    if (rewrite) {
      updateAccounts(this.o.agentDir, (a) => {
        for (const l of a.logins) {
          if (l.device === LOCAL_DEVICE_ID) l.device = self;
          if (l.device === null && this.use(l.id).inUse) { l.device = self; claimed.add(l.id); }
        }
        if (a.devices[LOCAL_DEVICE_ID] && !a.devices[self]) {
          a.devices[self] = a.devices[LOCAL_DEVICE_ID]!;
          delete a.devices[LOCAL_DEVICE_ID];
        }
      });
      accounts = readAccounts(this.o.agentDir);
    }
    const journal = readJournal(this.o.stateDir);
    this.updateDoc((doc) => {
      for (const l of accounts.value.logins) {
        if (journal.ops[l.id]) continue;
        const here = l.device === self;
        const free = l.device === null;
        if (!here && !free) continue;
        const known = doc.logins[l.id];
        if (!known) {
          doc.logins[l.id] = newPoolLogin({ addedAt: l.addedAt, identity: l.identity, ...(l.label ? { label: l.label } : {}), enabled: l.enabled, device: self, free, now });
        } else if (claimed.has(l.id) && known.holder.device === self) {
          known.holder = { device: self, free: false, seq: known.holder.seq + 1, at: now };
        }
      }
      const mine = Object.values(doc.logins).some((l) => l.holder.device === self);
      if (!doc.keeper.value && doc.keeper.at === 0 && mine) doc.keeper = reg(self, now, self);
      if (doc.order.at === 0 && accounts.value.devices[self]?.order.length) {
        doc.order = reg(accounts.value.devices[self]!.order.filter(isLoginId), now, self);
      }
    });
  }

  // ---- the tick -------------------------------------------------------------------------------

  /** One pass: heartbeat, journal, wants, what each login here should do next. Never throws. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.procs = undefined;
    try {
      this.heartbeat();
      await this.recover();
      await this.serveWants();
      this.decide();
      await this.progressLeaves();
      await this.takePinned();
      this.expireOffers();
      this.sweepIncoming();
      this.publishUsage();
      this.followDoc();
    } catch (err) {
      this.log(`tick: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Registry logins here: id → device (self = held, null = kept free). */
  private registry(): Map<string, { device: string | null; identity: ClaudeLoginIdentity | null; addedAt: number }> {
    const out = new Map<string, { device: string | null; identity: ClaudeLoginIdentity | null; addedAt: number }>();
    const read = readAccounts(this.o.agentDir);
    for (const l of read.value.logins) out.set(l.id, { device: l.device, identity: l.identity, addedAt: l.addedAt });
    return out;
  }
  private registryPut(id: string, device: string | null, identity: ClaudeLoginIdentity | null, addedAt: number, label?: string, enabled = true): void {
    updateAccounts(this.o.agentDir, (a) => {
      const existing = a.logins.find((l) => l.id === id);
      if (existing) {
        existing.device = device;
        if (identity) existing.identity = identity;
        return;
      }
      a.logins.push({ id, addedAt, enabled, device, identity, ...(label ? { label } : {}) });
    });
  }
  private registryDrop(id: string): void {
    updateAccounts(this.o.agentDir, (a) => {
      a.logins = a.logins.filter((l) => l.id !== id);
      for (const entry of Object.values(a.devices)) entry.order = entry.order.filter((x) => x !== id);
    });
  }

  /**
   * Who runs on a login here: the leases (accounts.ts), plus any `claude` process whose
   * environment names the login's directory (no lease: started before this version, or by hand).
   * Such a process counts as busy: nothing says when it last worked.
   */
  private use(id: string): { inUse: boolean; busy: boolean; lastActiveAt: number; children: number[] } {
    const leased = readLoginUse(this.o.agentDir, id, this.alive, this.now(), this.o.runsOn);
    this.procs ??= { at: this.now(), map: (this.o.procScan ?? scanClaudeProcs)() };
    const dir = join(this.o.agentDir, ACCOUNTS_DIR_NAME, id);
    const extra = (this.procs.map.get(dir) ?? []).filter((pid) => !leased.children.includes(pid) && this.alive(pid));
    if (!extra.length) return leased;
    return { inUse: true, busy: true, lastActiveAt: this.now(), children: [...leased.children, ...extra] };
  }

  // ---- journal recovery -----------------------------------------------------------------------

  private async recover(): Promise<void> {
    const journal = readJournal(this.o.stateDir);
    for (const [id, op] of Object.entries(journal.ops)) {
      if (this.busyIds.has(id)) continue;
      if (op.op === "lend" && op.state === "committing") await this.guard(id, () => this.finishLend(id, op));
      else if (op.op === "borrow") await this.guard(id, () => this.resumeBorrow(id, op));
    }
  }

  private async guard(id: string, fn: () => Promise<void> | void): Promise<void> {
    if (this.busyIds.has(id)) return;
    this.busyIds.add(id);
    try {
      await fn();
    } catch (err) {
      this.log(`${id}: ${(err as Error).message}`);
    } finally {
      this.busyIds.delete(id);
    }
  }

  // ---- keeper: lending ------------------------------------------------------------------------

  private lendable(doc: PoolDoc, asker: string, req: LendRequest): string[] {
    const reg = this.registry();
    const journal = readJournal(this.o.stateDir);
    const now = this.now();
    const ok = (id: string): boolean => {
      const l = doc.logins[id];
      if (!l || l.removed.value || !l.enabled.value) return false;
      if (l.holder.device !== this.self || !l.holder.free) return false;
      if (reg.get(id)?.device !== null || !hasCredentials(this.o.agentDir, id)) return false;
      if (journal.ops[id] || this.busyIds.has(id)) return false;
      if (l.pin.value && l.pin.value !== asker) return false;
      if (standingNow(doc, id, now)) return false;
      if (req.excludeLogins?.includes(id)) return false;
      const account = l.identity?.accountUuid;
      if (account && req.excludeAccounts?.includes(account)) return false;
      if (req.only && req.only !== id) return false;
      if (this.use(id).inUse) return false;
      return true;
    };
    const order = poolOrder(doc).filter(ok);
    return [...order.filter((id) => doc.logins[id]!.pin.value === asker), ...order.filter((id) => doc.logins[id]!.pin.value !== asker)];
  }

  /** POST /api/peer/claude-pool/lend (at the keeper): offer the first lendable login. */
  async lend(asker: string, req: LendRequest): Promise<LendReply> {
    this.procs = undefined;
    const doc = this.doc();
    if (doc.keeper.value !== this.self) return { none: "not the keeper" };
    if (typeof req?.requestId !== "string" || !req.requestId || req.requestId.length > 64) return { none: "bad request" };
    const id = this.lendable(doc, asker, req)[0];
    if (!id) return { none: "no free login" };
    this.busyIds.add(id);
    try {
      const files = await readLoginFiles(join(this.o.agentDir, ACCOUNTS_DIR_NAME, id));
      const login = doc.logins[id]!;
      const seq = login.holder.seq + 1;
      setOp(this.o.stateDir, id, { op: "lend", state: "offered", peer: asker, seq, requestId: req.requestId, at: this.now(), credentialsHash: credentialsHash(files.credentials) });
      this.crash("lend-offered");
      this.log(`offered ${id} to ${asker}`);
      return { offer: { id, seq, files, identity: login.identity, addedAt: login.addedAt } };
    } finally {
      this.busyIds.delete(id);
    }
  }

  /** POST /api/peer/claude-pool/lend/commit: the asker staged it; drop ours and hand it over. */
  async commit(asker: string, req: CommitRequest): Promise<CommitReply> {
    if (!req || !isLoginId(req.id)) return { cancelled: "bad request" };
    this.procs = undefined;
    const op = readJournal(this.o.stateDir).ops[req.id];
    if (op?.op === "lend" && op.requestId === req.requestId && op.peer === asker && op.seq === req.seq) {
      if (op.state === "offered") {
        // Nothing here may have run on it since the offer (the mesh was off meanwhile, say):
        // a changed copy would make the staged one stale.
        const text = credentialsText(this.o.agentDir, req.id);
        if (!text || credentialsHash(text) !== op.credentialsHash || this.use(req.id).inUse) {
          setOp(this.o.stateDir, req.id, undefined);
          return { cancelled: "the login changed here since the offer" };
        }
        setOp(this.o.stateDir, req.id, { ...op, state: "committing" });
        this.crash("lend-committing");
      }
      await this.finishLend(req.id, { ...op, state: "committing" });
      return { ok: true, doc: this.doc() };
    }
    const holder = this.doc().logins[req.id]?.holder;
    if (holder && holder.device === asker && !holder.free && holder.seq >= req.seq) return { ok: true, doc: this.doc() };
    return { cancelled: "no such offer" };
  }

  private async finishLend(id: string, op: Extract<JournalOp, { op: "lend" }>): Promise<void> {
    // Out of the registry first: from here the copy is never selected, even with the mesh off.
    this.registryDrop(id);
    this.updateDoc((doc) => {
      const l = doc.logins[id];
      if (l && l.holder.seq < op.seq) l.holder = { device: op.peer, free: false, seq: op.seq, at: this.now() };
    });
    this.crash("lend-deleting");
    deleteLoginFiles(this.o.agentDir, id);
    setOp(this.o.stateDir, id, undefined);
    this.log(`lent ${id} to ${op.peer}`);
  }

  /** Offers nobody committed within the TTL go back to free. */
  private expireOffers(): void {
    const journal = readJournal(this.o.stateDir);
    for (const [id, op] of Object.entries(journal.ops)) {
      if (op.op === "lend" && op.state === "offered" && this.now() - op.at > this.o.offerTtlMs && !this.busyIds.has(id)) {
        setOp(this.o.stateDir, id, undefined);
        this.log(`offer of ${id} to ${op.peer} expired`);
      }
    }
  }

  // ---- borrowing ------------------------------------------------------------------------------

  /** Serve this device's borrow requests, one borrow at a time. */
  private async serveWants(): Promise<void> {
    const wants = readWants(this.o.agentDir);
    if (!wants.length) return;
    for (const { file, want } of wants) {
      if (!this.alive(want.pid)) { rmSync(file, { force: true }); continue; }
      // A pick in the composer names one login: answered once that one is here, never by another.
      const satisfied = want.only
        ? readAccounts(this.o.agentDir).value.logins.some((l) => l.id === want.only && l.device === this.self)
        : this.heldUsable(want.excludeAccounts, want.excludeLogins);
      if (satisfied) { rmSync(file, { force: true }); continue; }
      if (this.borrowing) return;
      const got = await this.borrow({ requestId: randomBytes(8).toString("hex"), ...(want.excludeAccounts ? { excludeAccounts: want.excludeAccounts } : {}), ...(want.excludeLogins ? { excludeLogins: want.excludeLogins } : {}), ...(want.only ? { only: want.only } : {}) });
      if (!got) this.log(`borrow for pid ${want.pid}: nothing to borrow`);
      rmSync(file, { force: true });
    }
  }

  /** A login held here that a spawn could take now (enabled, ready, not leaving, not excluded). */
  private heldUsable(excludeAccounts: readonly string[] = [], excludeLogins: readonly string[] = []): boolean {
    const accounts = readAccounts(this.o.agentDir).value;
    const state = readAccountsState(this.o.agentDir);
    const now = this.now();
    return accounts.logins.some((l) => {
      if (l.device !== this.self || !l.enabled || excludeLogins.includes(l.id)) return false;
      if (l.identity?.accountUuid && excludeAccounts.includes(l.identity.accountUuid)) return false;
      if (readLeaving(this.o.agentDir, l.id)) return false;
      const s = state.logins[l.id];
      if (s?.kind === "limit" && (s.until ?? s.at + 15 * 60_000) > now) return false;
      if (s?.kind === "auth") return false;
      return hasCredentials(this.o.agentDir, l.id);
    });
  }

  /** Borrow one login from the keeper (or take one kept here, when this device is the keeper). */
  async borrow(req: LendRequest): Promise<string | undefined> {
    if (!this.canHold() || this.borrowing) return undefined;
    const doc = this.doc();
    const keeper = doc.keeper.value;
    if (!keeper) return undefined;
    this.borrowing = true;
    try {
      if (keeper === this.self) return this.takeLocal(doc, req);
      const peer = this.o.peers().find((p) => p.id === keeper);
      if (!peer) return undefined;
      const reply = await peer.lend(req);
      if (!("offer" in reply)) return undefined;
      const { id, seq, files, identity, addedAt } = reply.offer;
      if (!isLoginId(id) || !plausibleFiles(files) || readJournal(this.o.stateDir).ops[id]) return undefined;
      let result: string | undefined;
      await this.guard(id, async () => {
        stageLoginFiles(this.o.agentDir, id, files);
        setOp(this.o.stateDir, id, { op: "borrow", state: "staged", peer: keeper, seq, requestId: req.requestId, at: this.now() });
        this.crash("borrow-staged");
        // Remember who it is, in case the commit's answer is lost and the doc brings the rest.
        this.pendingIdentity.set(id, { identity, addedAt });
        if (await this.commitBorrow(id, peer, { op: "borrow", state: "staged", peer: keeper, seq, requestId: req.requestId, at: this.now() })) result = id;
      });
      return result;
    } catch (err) {
      this.log(`borrow: ${(err as Error).message}`);
      return undefined;
    } finally {
      this.borrowing = false;
    }
  }
  private readonly pendingIdentity = new Map<string, { identity: ClaudeLoginIdentity | null; addedAt: number }>();

  /** Ask the keeper to commit a staged borrow; activate on its yes, drop the stage on its no. */
  private async commitBorrow(id: string, peer: PoolPeer, op: Extract<JournalOp, { op: "borrow" }>): Promise<boolean> {
    const reply = await peer.commit({ requestId: op.requestId, id, seq: op.seq });
    if ("cancelled" in reply) {
      dropStaged(this.o.agentDir, id);
      setOp(this.o.stateDir, id, undefined);
      this.log(`borrow of ${id} cancelled: ${reply.cancelled}`);
      return false;
    }
    this.mergeIn(reply.doc);
    await this.activate(id, op);
    return true;
  }

  private async activate(id: string, op: Extract<JournalOp, { op: "borrow" }>): Promise<void> {
    setOp(this.o.stateDir, id, { ...op, state: "activating" });
    this.crash("borrow-activating");
    await activateStaged(this.o.agentDir, id, this.o.defaultClaudeDir);
    const known = this.doc().logins[id];
    const pending = this.pendingIdentity.get(id);
    clearLeaving(this.o.agentDir, id);
    this.registryPut(id, this.self, known?.identity ?? pending?.identity ?? null, known?.addedAt ?? pending?.addedAt ?? this.now(), known?.label.value ?? undefined, known?.enabled.value ?? true);
    this.updateDoc((doc) => {
      const l = doc.logins[id];
      if (l && l.holder.seq < op.seq) l.holder = { device: this.self, free: false, seq: op.seq, at: this.now() };
    });
    setOp(this.o.stateDir, id, undefined);
    this.pendingIdentity.delete(id);
    this.log(`borrowed ${id} from ${op.peer}`);
  }

  /** A borrow the journal left open: finish it, retry its commit, or drop it. */
  private async resumeBorrow(id: string, op: Extract<JournalOp, { op: "borrow" }>): Promise<void> {
    if (op.state === "activating") { await this.activate(id, op); return; }
    if (!hasStaged(this.o.agentDir, id)) { setOp(this.o.stateDir, id, undefined); return; }
    const holder = this.doc().logins[id]?.holder;
    if (holder && holder.device === this.self && !holder.free && holder.seq >= op.seq) { await this.activate(id, op); return; }
    if (holder && holder.seq >= op.seq) {
      // Committed to someone else (or superseded): our stage is stale.
      dropStaged(this.o.agentDir, id);
      setOp(this.o.stateDir, id, undefined);
      return;
    }
    const peer = this.o.peers().find((p) => p.id === op.peer);
    if (!peer) return;
    try {
      await this.commitBorrow(id, peer, op);
    } catch { /* unreachable: again later, the copy stays staged and unused */ }
  }

  /** The keeper borrowing for itself: a login kept free here becomes held here. */
  private takeLocal(doc: PoolDoc, req: LendRequest): string | undefined {
    const id = this.lendable(doc, this.self, req)[0];
    if (!id) return undefined;
    clearLeaving(this.o.agentDir, id);
    this.registryPut(id, this.self, doc.logins[id]!.identity, doc.logins[id]!.addedAt);
    this.updateDoc((d) => {
      const l = d.logins[id]!;
      l.holder = { device: this.self, free: false, seq: l.holder.seq + 1, at: this.now() };
    });
    this.log(`took ${id} (kept here)`);
    return id;
  }

  /** A free login pinned to this device, ready, at a reachable keeper: take it. */
  private async takePinned(): Promise<void> {
    if (!this.canHold() || this.borrowing) return;
    const doc = this.doc();
    const now = this.now();
    for (const id of poolOrder(doc)) {
      const l = doc.logins[id]!;
      if (l.pin.value !== this.self || !l.holder.free || !l.enabled.value || standingNow(doc, id, now)) continue;
      if (l.holder.device !== doc.keeper.value) continue;
      await this.borrow({ requestId: randomBytes(8).toString("hex"), only: id });
      return;
    }
  }

  // ---- holding: when a login here must leave --------------------------------------------------

  /** Start the leaves this device owes (limit/auth marks, returnAsk, pin, removal, supersede, keeper, idle). */
  private decide(): void {
    const doc = this.doc();
    const journal = readJournal(this.o.stateDir);
    const now = this.now();
    for (const [id, r] of this.registry()) {
      if (journal.ops[id] || this.busyIds.has(id)) continue;
      const l = doc.logins[id];
      const held = r.device === this.self;
      const kept = r.device === null;
      if (!held && !kept) continue;
      if (!l) continue; // not in the pool (yet): migrate() adds it
      if (l.removed.value) { this.leave(id, "drop", "removed"); continue; }
      if (l.holder.device !== this.self) { this.leave(id, "drop", "superseded"); continue; }
      if (l.holder.free !== kept) {
        // A crash between the registry's write and the document's: the registry (what spawns
        // read) is the truth here; bring the document in line.
        this.updateDoc((d) => { const x = d.logins[id]!; x.holder = { device: this.self, free: kept, seq: x.holder.seq + 1, at: now }; });
      }
      if (kept) {
        const keeper = doc.keeper.value;
        if (keeper && keeper !== this.self) this.leave(id, "return", "keeper");
        continue;
      }
      const mark = readLeaving(this.o.agentDir, id);
      if (mark) { this.leave(id, "return", mark.reason); continue; }
      if (l.returnAsk.value !== null && l.returnAsk.value >= l.holder.seq) { this.leave(id, "return", "user"); continue; }
      if (l.pin.value && l.pin.value !== this.self) { this.leave(id, "return", "pin"); continue; }
      if (l.pin.value === this.self) continue;
      const use = this.use(id);
      const last = Math.max(use.lastActiveAt, l.holder.at, this.startedAt);
      if (!use.busy && now - last >= this.o.idleMs) this.leave(id, "return", "idle");
    }
  }

  /** Mark the login leaving and journal the drain; nothing picks it from here on. */
  leave(id: string, kind: "return" | "drop", reason: LeavingReason): void {
    const now = this.now();
    const slow = reason === "user" || reason === "pin";
    const drainless = reason === "keeper";
    markLeaving(this.o.agentDir, id, reason, now);
    setOp(this.o.stateDir, id, { op: "leave", kind, state: "draining", reason, at: now, cutAt: now + (drainless ? 0 : slow ? this.o.slowCutMs : this.o.quickCutMs) });
    this.log(`${id} leaves (${kind}: ${reason})`);
  }

  private async progressLeaves(): Promise<void> {
    const journal = readJournal(this.o.stateDir);
    for (const [id, op] of Object.entries(journal.ops)) {
      if (op.op !== "leave") continue;
      await this.guard(id, () => this.progressLeave(id, op));
    }
  }

  private async progressLeave(id: string, op: Extract<JournalOp, { op: "leave" }>): Promise<void> {
    if (op.state === "draining") {
      const use = this.use(id);
      if (use.inUse || use.children.length) {
        if (this.now() < op.cutAt) return;
        // The cut: every `claude` still on it stops; each owner continues on its next login.
        const signal: NodeJS.Signals = op.killedAt && this.now() - op.killedAt > KILL_GRACE_MS ? "SIGKILL" : "SIGTERM";
        for (const pid of use.children) {
          try { (this.o.kill ?? process.kill)(pid, signal); } catch { /* gone */ }
        }
        if (!op.killedAt) setOp(this.o.stateDir, id, { ...op, killedAt: this.now() });
        return;
      }
      if (op.kind === "drop") {
        setOp(this.o.stateDir, id, { ...op, state: "deleting" });
        return this.finishLeave(id);
      }
      const doc = this.doc();
      const keeper = doc.keeper.value;
      const l = doc.logins[id];
      if (!l) return this.finishLeave(id);
      if (keeper === this.self || !keeper) {
        if (!keeper) return; // nowhere to go yet; stays leaving, unused
        this.keepHere(id, op.reason);
        return;
      }
      setOp(this.o.stateDir, id, { ...op, state: "sending", peer: keeper, seq: l.holder.seq });
      this.crash("return-sending");
      return this.send(id, { ...op, state: "sending", peer: keeper, seq: l.holder.seq });
    }
    if (op.state === "sending") return this.send(id, op);
    if (op.state === "deleting") return this.finishLeave(id);
  }

  /** This device is the keeper: a held login becomes free here, no transfer. */
  private keepHere(id: string, reason: string): void {
    const standing = this.localStanding(id);
    updateAccounts(this.o.agentDir, (a) => { const l = a.logins.find((x) => x.id === id); if (l) l.device = null; });
    clearLeaving(this.o.agentDir, id);
    this.updateDoc((doc) => {
      const l = doc.logins[id];
      if (!l) return;
      l.holder = { device: this.self, free: true, seq: l.holder.seq + 1, at: this.now() };
      if (standing !== undefined) l.standing = reg(standing, this.now(), this.self);
    });
    setOp(this.o.stateDir, id, undefined);
    this.log(`${id} is free again (${reason})`);
  }

  /** What this device knows of a login's standing, to hand on with it: undefined = nothing to say. */
  private localStanding(id: string): PoolStanding | null | undefined {
    const s = readAccountsState(this.o.agentDir).logins[id];
    if (!s) return null;
    if (s.kind === "auth") return { kind: "auth" };
    const until = s.until ?? s.at + 15 * 60_000;
    return until > this.now() ? { kind: "limit", until, ...(s.window ? { window: s.window } : {}) } : null;
  }

  private async send(id: string, op: Extract<JournalOp, { op: "leave" }>): Promise<void> {
    const doc = this.doc();
    const keeper = doc.keeper.value;
    const target = keeper && keeper !== op.peer ? keeper : op.peer;
    if (!target) return;
    if (target === this.self) { this.keepHere(id, op.reason); return; }
    const peer = this.o.peers().find((p) => p.id === target);
    if (!peer) return;
    const l = doc.logins[id];
    let files: LoginFiles;
    try {
      files = await readLoginFiles(join(this.o.agentDir, ACCOUNTS_DIR_NAME, id));
    } catch (err) {
      if (!hasCredentials(this.o.agentDir, id)) { setOp(this.o.stateDir, id, { ...op, state: "deleting" }); return this.finishLeave(id); }
      throw err;
    }
    let reply: ReturnReply;
    try {
      reply = await peer.giveBack({ id, seq: op.seq ?? l?.holder.seq ?? 0, files, standing: this.localStanding(id) ?? null, identity: l?.identity ?? null, addedAt: l?.addedAt ?? this.now() });
    } catch {
      return; // the keeper is away: the login waits here, unused, and goes when it is back
    }
    if ("refused" in reply) {
      if (reply.superseded) { setOp(this.o.stateDir, id, { ...op, kind: "drop", state: "deleting" }); return this.finishLeave(id); }
      this.log(`return of ${id} refused: ${reply.refused}`);
      return;
    }
    this.mergeIn(reply.doc);
    setOp(this.o.stateDir, id, { ...op, state: "deleting" });
    this.crash("return-deleting");
    return this.finishLeave(id);
  }

  private finishLeave(id: string): void {
    this.registryDrop(id);
    deleteLoginFiles(this.o.agentDir, id);
    setOp(this.o.stateDir, id, undefined);
    this.log(`${id} left this device`);
  }

  /** POST /api/peer/claude-pool/return (at the keeper): store it, then take it over as free. */
  async receiveReturn(from: string, req: ReturnRequest): Promise<ReturnReply> {
    if (!req || !isLoginId(req.id) || !plausibleFiles(req.files) || !Number.isSafeInteger(req.seq)) return { refused: "bad request" };
    if (!this.canHold()) return { refused: "this device holds no subscription login" };
    const doc = this.doc();
    if (doc.keeper.value !== this.self) return { refused: "not the keeper" };
    const l = doc.logins[req.id];
    if (l && l.holder.seq > req.seq) {
      // Already ours (a resend after a lost answer), or it moved on: never overwrite then.
      if (l.holder.device === this.self && l.holder.free) return { ok: true, doc };
      return { refused: "a newer holder has it", superseded: true };
    }
    if (l && l.holder.device !== from) return { refused: "a newer holder has it", superseded: true };
    if (readJournal(this.o.stateDir).ops[req.id]) return { refused: "busy" };
    await this.guard(req.id, async () => {
      await storeLoginFiles(this.o.agentDir, req.id, this.o.defaultClaudeDir, req.files);
      this.registryPut(req.id, null, l?.identity ?? req.identity, l?.addedAt ?? req.addedAt);
      clearLeaving(this.o.agentDir, req.id);
      this.crash("return-stored");
      this.updateDoc((d) => {
        const now = this.now();
        const cur = d.logins[req.id] ?? newPoolLogin({ addedAt: req.addedAt, identity: req.identity, enabled: true, device: this.self, free: true, seq: req.seq, now });
        cur.holder = { device: this.self, free: true, seq: Math.max(cur.holder.seq, req.seq) + 1, at: now };
        cur.standing = reg(req.standing, now, from);
        d.logins[req.id] = cur;
      });
      this.log(`${req.id} returned by ${from}`);
    });
    const after = this.doc().logins[req.id];
    return after && after.holder.device === this.self ? { ok: true, doc: this.doc() } : { refused: "could not store it" };
  }

  /**
   * The usage of each login held here, from this host's usage cache (`cache/usage-status.json`,
   * `claudeAccounts`: numbers only), into the document, so every device's Accounts row shows it.
   * Written only when a figure changed.
   */
  private publishUsage(): void {
    let cache: { claudeAccounts?: Record<string, { data?: { state?: string; fiveHour?: { pct?: unknown; resetsAt?: unknown }; sevenDay?: { pct?: unknown; resetsAt?: unknown } } }> };
    try {
      cache = JSON.parse(readFileSync(join(this.o.agentDir, "cache", "usage-status.json"), "utf8"));
    } catch {
      return;
    }
    const reading = (w: { pct?: unknown; resetsAt?: unknown } | undefined) => ({
      pct: typeof w?.pct === "number" && Number.isFinite(w.pct) ? Math.round(w.pct) : undefined,
      resetsAt: typeof w?.resetsAt === "string" && Number.isFinite(Date.parse(w.resetsAt)) ? Date.parse(w.resetsAt) : undefined,
    });
    const doc = this.doc();
    const held = [...this.registry()].filter(([, r]) => r.device === this.self).map(([id]) => id);
    const changes: Array<[string, PoolUsage]> = [];
    for (const id of held) {
      const data = cache.claudeAccounts?.[id]?.data;
      if (!doc.logins[id] || data?.state !== "ok") continue;
      const five = reading(data.fiveHour);
      const seven = reading(data.sevenDay);
      const usage: PoolUsage = {
        ...(five.pct !== undefined ? { fiveHour: five.pct } : {}),
        ...(five.resetsAt !== undefined ? { fiveHourResetsAt: five.resetsAt } : {}),
        ...(seven.pct !== undefined ? { sevenDay: seven.pct } : {}),
        ...(seven.resetsAt !== undefined ? { sevenDayResetsAt: seven.resetsAt } : {}),
      };
      if (JSON.stringify(usage) !== JSON.stringify(doc.logins[id]!.usage.value)) changes.push([id, usage]);
    }
    if (!changes.length) return;
    this.updateDoc((d) => {
      for (const [id, usage] of changes) if (d.logins[id]) d.logins[id]!.usage = reg(usage, this.now(), this.self);
    });
  }

  /**
   * The registry follows the document for the logins this device has (held, or kept free): their
   * label, Use and the pool's order, edited on any device, reach this device's spawns and chats.
   * Written only when something differs.
   */
  private followDoc(): void {
    const read = readAccounts(this.o.agentDir);
    if (read.state === "malformed") return;
    const doc = this.doc();
    const order = poolOrder(doc);
    const a = read.value;
    const differs = (l: (typeof a.logins)[number]): boolean => {
      const p = doc.logins[l.id];
      return !!p && !p.removed.value && ((p.label.value ?? undefined) !== l.label || p.enabled.value !== l.enabled);
    };
    const mine = a.devices[this.self]?.order ?? [];
    const wanted = [...order.filter((id) => a.logins.some((l) => l.id === id)), ...mine.filter((id) => !order.includes(id))];
    const reorder = wanted.some((id, i) => mine[i] !== id) || mine.length !== wanted.length;
    if (!a.logins.some(differs) && !reorder) return;
    updateAccounts(this.o.agentDir, (next) => {
      for (const l of next.logins) {
        const p = doc.logins[l.id];
        if (!p || p.removed.value) continue;
        if (p.label.value) l.label = p.label.value;
        else delete l.label;
        l.enabled = p.enabled.value;
      }
      if (reorder) next.devices[this.self] = { ...next.devices[this.self], order: wanted };
    });
  }

  /** Staged copies with no journal op are leftovers of a cancelled borrow: delete them. */
  private sweepIncoming(): void {
    const dir = join(this.o.agentDir, ACCOUNTS_DIR_NAME, INCOMING_DIR_NAME);
    if (!existsSync(dir)) return;
    const ops = readJournal(this.o.stateDir).ops;
    for (const name of readdirSync(dir)) {
      if (isLoginId(name) && !ops[name] && !this.busyIds.has(name)) dropStaged(this.o.agentDir, name);
    }
  }

  // ---- the user's actions ---------------------------------------------------------------------

  /** The one list's order (the order the keeper lends in): every live login once. */
  setOrder(order: string[]): boolean {
    const live = poolOrder(this.doc());
    if (order.length !== live.length || new Set(order).size !== order.length || order.some((id) => !live.includes(id))) return false;
    this.updateDoc((doc) => { doc.order = reg([...order], this.now(), this.self); });
    return true;
  }
  setKeeper(device: string): void {
    this.updateDoc((doc) => { doc.keeper = reg(device, this.now(), this.self); });
  }
  setPin(id: string, device: string | null): boolean {
    if (!this.doc().logins[id]) return false;
    this.updateDoc((doc) => { doc.logins[id]!.pin = reg(device, this.now(), this.self); });
    return true;
  }
  /** "Return" pressed: asks the holder at its current holder seq (no clock involved), so a later hold is not affected. */
  askReturn(id: string): boolean {
    const l = this.doc().logins[id];
    if (!l || l.holder.free) return false;
    this.updateDoc((doc) => { doc.logins[id]!.returnAsk = reg(l.holder.seq, this.now(), this.self); });
    return true;
  }
  setLabel(id: string, label: string | null): void {
    this.updateDoc((doc) => { const l = doc.logins[id]; if (l) l.label = reg(label, this.now(), this.self); });
  }
  setEnabled(id: string, enabled: boolean): void {
    this.updateDoc((doc) => { const l = doc.logins[id]; if (l) l.enabled = reg(enabled, this.now(), this.self); });
  }
  clearStanding(id: string): void {
    this.updateDoc((doc) => { const l = doc.logins[id]; if (l) l.standing = reg(null, this.now(), this.self); });
  }
  /** Removed everywhere: its holder deletes its copy (after draining). */
  remove(id: string): void {
    this.updateDoc((doc) => { const l = doc.logins[id]; if (l) l.removed = reg(true, this.now(), this.self); });
  }
  /**
   * A login was just added here, or signed in again here (a new refresh chain): this device holds
   * it now. For one held by an offline device (stuck), that device deletes its old copy when back.
   */
  addedHere(id: string, info: { identity: ClaudeLoginIdentity | null; addedAt: number; label?: string }): void {
    this.updateDoc((doc) => {
      const now = this.now();
      const l = doc.logins[id];
      if (!l) {
        doc.logins[id] = newPoolLogin({ addedAt: info.addedAt, identity: info.identity, ...(info.label ? { label: info.label } : {}), enabled: true, device: this.self, now });
      } else {
        l.holder = { device: this.self, free: false, seq: l.holder.seq + 1, at: now };
        l.standing = reg(null, now, this.self);
        if (info.identity) l.identity = info.identity;
      }
      if (!doc.keeper.value) doc.keeper = reg(this.self, now, this.self);
    });
  }

  // ---- the view (Settings → Accounts, the Mesh page) ------------------------------------------

  view(): ClaudePoolInfo {
    const doc = this.doc();
    const now = this.now();
    const peers = this.o.peerInfo?.() ?? this.o.peers().map((p) => ({ id: p.id, label: p.id, up: true }));
    const label = (id: string): string => id === this.self ? (this.o.selfLabel?.() ?? id) : peers.find((p) => p.id === id)?.label ?? id;
    const up = (id: string): boolean => id === this.self || (peers.find((p) => p.id === id)?.up ?? false);
    const journal = readJournal(this.o.stateDir);
    const logins: ClaudePoolLogin[] = poolOrder(doc).map((id) => {
      const l = doc.logins[id]!;
      const standing = standingNow(doc, id, now);
      const op = journal.ops[id];
      return {
        id,
        ...(l.label.value ? { label: l.label.value } : {}),
        identity: l.identity && planLabel(l.identity) ? { ...l.identity, planLabel: planLabel(l.identity) } : l.identity,
        addedAt: l.addedAt,
        enabled: l.enabled.value,
        holder: { device: l.holder.device, label: label(l.holder.device), free: l.holder.free, stuck: !l.holder.free && !up(l.holder.device), since: l.holder.at },
        pin: l.pin.value,
        standing: standing?.kind === "limit" ? { state: "limited", until: standing.until ?? now, ...(standing.window ? { window: standing.window } : {}) } : standing?.kind === "auth" ? { state: "auth" } : { state: "ready" },
        ...(l.usage.value ? { usage: { ...l.usage.value, at: l.usage.at } } : {}),
        ...(op ? { moving: { op: op.op, state: op.state, ...(op.op === "leave" ? { reason: op.reason } : {}), ...("peer" in op && op.peer ? { peer: op.peer } : {}) } } : {}),
        ...(!l.holder.free && l.returnAsk.value !== null && l.returnAsk.value >= l.holder.seq ? { returnAsked: true } : {}),
      };
    });
    const devices = [{ id: this.self, label: label(this.self), up: true, self: true }, ...peers.map((p) => ({ ...p, self: false }))].map((d) => ({
      ...d,
      logins: logins.filter((l) => l.holder.device === d.id && !l.holder.free).map((l) => l.id),
    }));
    const keeper = doc.keeper.value;
    return {
      self: this.self,
      keeper: { id: keeper, label: keeper ? label(keeper) : "", up: keeper ? up(keeper) : false },
      devices,
      logins,
      ...(this.canHold() ? {} : { apiKeysOnly: true }),
    };
  }
}
