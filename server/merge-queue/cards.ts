import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BranchPlace,
  type MergeCard,
  type MergeCardFailure,
  type MergeCardOutcome,
  type MergeCardRevision,
  type MergeChatRequest,
  type MergeEntry,
  type MergeQueueView,
  type MergeRun,
  newerWords,
  type ReviewCard,
} from "../../shared/merge-queue";
import { MERGE_QUEUE_SENT_PREFIX } from "../../shared/senders";
import { countBetween, type Git, realGit } from "./guard";
import { type MergeNoticeKind, noticeText } from "./notices";
import { reviewNotesLine } from "./review-record";

/**
 * A branch's card in the chat that built it (a Sova built-in card, kind `sova.merge-queue`): one per branch, raised
 * by the server at its approval (Land, or a typed "land it"), never written into the chat's session file. While the
 * branch waits and is checked its data is revised in place; each outcome adds a revision at the chat's current end,
 * so the newest copy is where the user reads and the older ones fold. Landed and Drafts changed never start a turn:
 * the model hears one hidden line at its next turn (the chat's card note). Needs a fix and Send Back start a turn,
 * its text marked as the queue's (MERGE_QUEUE_SENT_PREFIX). Every outcome, line and wake is keyed (entry, kind, run)
 * in the chat's own record, so a restart never repeats one. A chat with an open question, archived, or a worker's
 * keeps its record all the same; a wake that isn't taken becomes the hidden line instead.
 */

export interface CardLine {
  key: string;
  at: string;
  text: string;
}

interface CardsRecord {
  session: string;
  cards: MergeCard[];
  /** (entry, kind, run) keys already done: revisions, lines and wakes. */
  done: Record<string, string>;
  /** Hidden lines for the model's next turn. */
  lines: CardLine[];
  /** The review cards standing in this chat (§chat.merge-queue/review-card), oldest first. */
  reviews?: ReviewCard[];
  /** Wakes written with their outcome and not yet taken by the chat. One no process is sending any more (Sova stopped
   *  between the write and the send) becomes the hidden line; it is never sent again, so it can never be a second turn. */
  wakes?: CardLine[];
}

export interface CardsDeps {
  /** `<state root>/merge-queue/cards`: one file per chat. */
  dir: string;
  /** The chat's last transcript entry that draws a row (the revision's place); null: none yet. */
  lastEntry?: (session: string) => Promise<string | null>;
  /** Start a turn in the chat with this text (a normal message, followUp); throws when not taken. */
  /** A request to the branch's chat (wake.ts sendQueueWake: a note on its merge queue chat queue); throws when it can't take one. */
  wake?: (session: string, text: string, info?: { kind?: string; branch?: string; entry?: string; place?: string }) => Promise<unknown>;
  /** A branch's place in the project at `root` (§chat.worktrees/place). Absent: cards carry none. */
  placeOf?: (root: string, target: string) => BranchPlace;
  /** Remove from Queue: drop the entry's requests not yet delivered, in every chat (topics.ts dropMergeRequests). */
  dropRequests?: (entry: string) => void;
  /** How a request reached its chat: pushed on its chat queue, or the hidden line (ProjectQueue.requestDelivered). */
  delivered?: (request: string, delivery: "queued" | "fallback-line") => void;
  /** A chat's cards changed (its review cards with them). */
  publish?: (session: string, cards: MergeCard[], reviews?: ReviewCard[]) => void;
  /** The chat a branch chat's requests go to: itself, or for a worker the chat that runs it (wake.ts); null: none known. */
  homeOf?: (session: string) => Promise<{ id: string; path: string } | null>;
  /** The reviewer chat of a run (chats.ts), for Open Reviewer Chat. */
  reviewerOf?: (root: string, run: string) => { session: string; path: string; cleared?: true } | undefined;
  git?: Git;
  now?: () => number;
  log?: (line: string) => void;
}

const WAKE_KINDS: readonly MergeCardOutcome[] = ["needs-fix", "sent-back"];
const LINE_KINDS: readonly MergeCardOutcome[] = ["landed", "drafts-changed"];
const OUTCOME_OF_STATE: Partial<Record<MergeEntry["state"], MergeCardOutcome>> = {
  landed: "landed",
  "needs-fix": "needs-fix",
  requested: "requested",
  pushed: "pushed",
  closed: "closed",
  // A conflict the merge thread is still judging is shown in place; its outcome is Behaviour differs or a hand-back.
  "behaviour-differs": "behaviour-differs",
  "review-flagged": "review-flagged",
  unattributed: "unattributed",
  "drafts-changed": "drafts-changed",
  "needs-user": "decision",
};
const LINES_MAX = 50;
const CARDS_MAX = 200;
const REVIEW_CARDS_MAX = 100;
const KEPT_TTL_MS = 10_000;
/** A review card's states that the queue card points to ("Review found {k} issues"). */
const POINTED: readonly ReviewCard["state"][] = ["with-thread", "fixing", "waiting"];
const short = (sha: string | undefined) => (sha ?? "").slice(0, 7);

export class MergeCards {
  private readonly git: Git;
  /** Keys being raised now (the place is read first): never twice at once. */
  private readonly pending = new Set<string>();
  /** Wakes this process is sending now (their record's `wakes` entry is theirs, not stale). */
  private readonly waking = new Set<string>();
  /** Each entry's review cards' chat, as last found (the queue card's pointer names it). */
  private readonly homes = new Map<string, { id: string; path?: string }>();
  /** Recent readings of whether a reviewed commit is kept. */
  private readonly kept = new Map<string, { kept: boolean; at: number }>();

  constructor(private readonly deps: CardsDeps) {
    this.git = deps.git ?? realGit;
  }

  private iso(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString();
  }

  private file(session: string): string {
    return join(this.deps.dir, `${session.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  }

  private read(session: string): CardsRecord {
    const f = this.file(session);
    if (existsSync(f)) {
      try {
        const r = JSON.parse(readFileSync(f, "utf8")) as CardsRecord;
        if (Array.isArray(r.cards)) return { session, cards: r.cards, done: r.done ?? {}, lines: r.lines ?? [], ...(r.wakes?.length ? { wakes: r.wakes } : {}), ...(r.reviews?.length ? { reviews: r.reviews } : {}) };
      } catch (err) {
        this.deps.log?.(`[merge-queue] cards of ${session} unreadable (${err instanceof Error ? err.message : err}); starting over`);
      }
    }
    return { session, cards: [], done: {}, lines: [] };
  }

  private write(rec: CardsRecord): void {
    mkdirSync(this.deps.dir, { recursive: true });
    if (rec.cards.length > CARDS_MAX) rec.cards = rec.cards.slice(-CARDS_MAX);
    if (rec.lines.length > LINES_MAX) rec.lines = rec.lines.slice(-LINES_MAX);
    if (rec.reviews && rec.reviews.length > REVIEW_CARDS_MAX) rec.reviews = rec.reviews.slice(-REVIEW_CARDS_MAX);
    const f = this.file(rec.session);
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(rec, null, 1)}\n`);
    renameSync(tmp, f);
  }

  private publish(rec: CardsRecord): void {
    try {
      this.deps.publish?.(rec.session, rec.cards, rec.reviews ?? []);
    } catch (err) {
      this.deps.log?.(`[merge-queue] cards publish: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** A chat's cards, oldest first. */
  cardsOf(session: string): MergeCard[] {
    return this.read(session).cards;
  }

  /** A chat's review cards, oldest first, as last revised. */
  reviewsOf(session: string): ReviewCard[] {
    return this.read(session).reviews ?? [];
  }

  /** A chat's review cards as the page reads them: whether each reviewed commit is still kept is read now (a commit
   *  goes at a gc, with no queue event, and a finished entry's card is never revised again), cached briefly. */
  async reviewsRead(session: string): Promise<ReviewCard[]> {
    const list = this.reviewsOf(session);
    const out: ReviewCard[] = [];
    for (const c of list) {
      const kept = (await this.commitKept(c.root, c.reviewed.tip)) && (await this.commitKept(c.root, c.reviewed.base));
      out.push(kept === c.reviewed.kept ? c : { ...c, reviewed: { ...c.reviewed, kept } });
    }
    return out;
  }

  /**
   * The entry's review records as cards (§chat.merge-queue/review-card), each in the chat its request goes to: a new
   * one at that chat's end (once per record, keyed by its id), the rest revised in place from their records.
   */
  async reviews(e: MergeEntry, root: string): Promise<void> {
    if (!e.session || !e.reviews?.length) return;
    const found = (await this.deps.homeOf?.(e.session).catch(() => null)) ?? null;
    const home = found?.id ?? e.session;
    this.homes.set(e.id, found ?? { id: home });
    const kept = new Map<string, boolean>();
    for (const r of e.reviews) kept.set(r.tip, (await this.commitKept(root, r.tip)) && (await this.commitKept(root, r.base)));
    const pre = this.read(home);
    const fresh = e.reviews.filter((r) => !pre.reviews?.some((c) => c.id === r.id) && !this.pending.has(`review:${r.id}`));
    for (const r of fresh) this.pending.add(`review:${r.id}`);
    try {
      const after = fresh.length ? await this.place(home) : undefined;
      const rec = this.read(home);
      let changed = false;
      for (const r of e.reviews) {
        const reviewer = this.deps.reviewerOf?.(root, r.run);
        const card: ReviewCard = {
          id: r.id,
          entry: e.id,
          session: home,
          project: e.project,
          root,
          branch: e.branch,
          target: e.target,
          commit: r.commit,
          run: r.run,
          try: r.try,
          of: r.of,
          summary: r.summary,
          findings: structuredClone(r.findings),
          ...(r.note ? { note: { ...r.note } } : {}),
          state: r.state,
          ...(r.stoppedFor ? { stoppedFor: r.stoppedFor } : {}),
          ...(reviewer ? { reviewer: { session: reviewer.session, path: reviewer.path, ...(reviewer.cleared ? { cleared: true as const } : {}) } } : {}),
          reviewed: { base: r.base, tip: r.tip, kept: kept.get(r.tip) ?? false },
          at: r.at,
          updatedAt: r.updatedAt,
        };
        const list = (rec.reviews ??= []);
        const i = list.findIndex((c) => c.id === r.id);
        if (i < 0) {
          if (!fresh.includes(r)) continue; // raised by another call meanwhile
          list.push({ ...card, ...(after !== undefined ? { after } : {}) });
          changed = true;
          continue;
        }
        const old = list[i]!;
        const next = { ...card, ...(old.after !== undefined ? { after: old.after } : {}) };
        const { updatedAt: _a, ...a } = old;
        const { updatedAt: _b, ...b } = next;
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        list[i] = next;
        changed = true;
      }
      if (changed) {
        this.write(rec);
        this.publish(rec);
      }
    } finally {
      for (const r of fresh) this.pending.delete(`review:${r.id}`);
    }
  }

  /** The commit is still in the project's repository (a finding's lines are read against it); a reading is reused for
   *  KEPT_TTL_MS, so a chat's reads never run git per card each time. */
  private async commitKept(root: string, sha: string): Promise<boolean> {
    const key = `${root}\0${sha}`;
    const now = this.deps.now?.() ?? Date.now();
    const hit = this.kept.get(key);
    if (hit && now - hit.at < KEPT_TTL_MS) return hit.kept;
    const r = await this.git(["cat-file", "-e", `${sha}^{commit}`], root).catch(() => null);
    const kept = !!r && r.code === 0;
    if (this.kept.size > 500) this.kept.clear();
    this.kept.set(key, { kept, at: now });
    return kept;
  }

  /** The hidden lines given after `since` (the chat's last card note), once each; null: none. */
  noteFor(session: string, since: string | null): string | null {
    const from = since ? Date.parse(since) || 0 : 0;
    this.settleStaleWakes(session);
    const lines = this.read(session).lines.filter((l) => Date.parse(l.at) > from);
    return lines.length ? lines.map((l) => l.text).join("\n") : null;
  }

  /** A hidden line with no card (a typed "land it" the queue couldn't take), once per key. */
  addLine(session: string, key: string, text: string): void {
    const rec = this.read(session);
    if (rec.done[key]) return;
    rec.done[key] = this.iso();
    rec.lines.push({ key, at: this.iso(), text });
    this.write(rec);
  }

  /** Wakes left pending by a process that no longer sends them: each becomes the hidden line, once; never resent. */
  settleStaleWakes(session: string): void {
    const rec = this.read(session);
    const stale = (rec.wakes ?? []).filter((w) => !this.waking.has(w.key));
    if (!stale.length) return;
    rec.wakes = (rec.wakes ?? []).filter((w) => this.waking.has(w.key));
    if (!rec.wakes.length) delete rec.wakes;
    for (const w of stale) if (!rec.lines.some((l) => l.key === w.key)) rec.lines.push({ key: w.key, at: this.iso(), text: w.text.slice(MERGE_QUEUE_SENT_PREFIX.length).trim() });
    this.write(rec);
  }

  private async place(session: string): Promise<string | null | undefined> {
    if (!this.deps.lastEntry) return undefined;
    try {
      return await this.deps.lastEntry(session);
    } catch {
      return undefined;
    }
  }

  private revision(card: MergeCard, kind: MergeCardRevision["kind"], after: string | null | undefined, run?: string): MergeCardRevision {
    return {
      id: `${card.id}:${card.revisions.length + 1}`,
      kind,
      ...(run ? { run } : {}),
      at: this.iso(),
      ...(after !== undefined ? { after } : {}),
      state: card.state,
      ...(card.position ? { position: card.position } : {}),
    };
  }

  /** The approval: the branch's card, at the chat's current end. Again for the same entry (a re-Land at a newer commit): its data only. */
  async approved(e: MergeEntry, root: string): Promise<void> {
    if (!e.session) return;
    const key = `${e.id}:approved:`;
    if (this.pending.has(key)) return;
    this.pending.add(key);
    try {
      const pre = this.read(e.session);
      const after = pre.done[key] ? undefined : await this.place(e.session);
      const head = await this.headOf(root, e.branch);
      const rec = this.read(e.session);
      // One card per branch: a new approval after a hand-back (or a cancel) moves the same card on; a landed card is a
      // finished trip, so a later approval of the branch starts a new one.
      let card = rec.cards.find((c) => c.entry === e.id) ?? [...rec.cards].reverse().find((c) => c.root === root && c.branch === e.branch && c.state !== "landed");
      if (card && card.entry !== e.id) {
        card.entry = e.id;
        card.approvedBy = e.approval.by;
        delete card.failures;
        delete card.stats;
        delete card.removed;
      }
      if (!card) {
        card = { id: e.id, entry: e.id, session: e.session, project: e.project, root, branch: e.branch, target: e.target, commit: e.commit, approvedBy: e.approval.by, state: e.state, notes: [], revisions: [], updatedAt: this.iso() };
        const place = this.deps.placeOf?.(root, e.target);
        if (place) card.place = place;
        rec.cards.push(card);
      }
      this.fill(card, e);
      setOpt(card, "head", head);
      if (!rec.done[key]) {
        card.revisions.push(this.revision(card, "approved", after));
        rec.done[key] = this.iso();
        // No turn starts: the chat's model reads it at its next one (§chat.merge-queue/chat-turns).
        rec.lines.push({ key, at: this.iso(), text: noticeText("approved", e) });
      }
      this.write(rec);
      this.publish(rec);
    } finally {
      this.pending.delete(key);
    }
  }

  /** An outcome: a new revision at the chat's end, then its hidden line or its wake. Once per (entry, kind, run). */
  async outcome(kind: MergeCardOutcome | "explained", e: MergeEntry, extra: { run?: MergeRun; root?: string; request?: MergeChatRequest } = {}): Promise<void> {
    if (!e.session) return;
    const session = e.session;
    // Its review card first: the request's folded row comes below it (§chat.merge-queue/review-card).
    const rootOf = extra.root ?? this.read(session).cards.find((c) => c.entry === e.id)?.root;
    if (rootOf) await this.reviews(e, rootOf).catch((err) => this.deps.log?.(`[merge-queue] review cards of ${e.id}: ${err instanceof Error ? err.message : err}`));
    if (!this.read(session).cards.some((c) => c.entry === e.id)) return; // no card, no back-fill
    if (kind === "explained") {
      // The merge thread's explanation joins the same card, in place.
      const rec = this.read(session);
      const card = rec.cards.find((c) => c.entry === e.id)!;
      this.fill(card, e);
      this.write(rec);
      this.publish(rec);
      return;
    }
    // A decision's revision is once per decision (a second one on the same run is a new question).
    // A request's outcome is once per request (a second request on the same run, or with none, is a new one).
    // The same outcome told again without its request (a restart, a view) is keyed by the entry's newest request.
    const reqId = extra.request?.id ?? (WAKE_KINDS.includes(kind as MergeCardOutcome) && e.state === "with-chat" ? e.requests?.at(-1)?.id : undefined);
    const run = kind === "decision" && e.decision ? e.decision.id : reqId ? reqId : (extra.run?.id ?? e.run ?? "");
    const key = `${e.id}:${kind}:${run}`;
    if (this.pending.has(key) || this.read(session).done[key]) return this.refresh(e, extra.run);
    // A Send Back is also a needs-fix entry: one revision for it.
    if (kind === "needs-fix" && (this.read(session).done[`${e.id}:sent-back:${run}`] || this.pending.has(`${e.id}:sent-back:${run}`))) return this.refresh(e, extra.run);
    this.pending.add(key);
    try {
      const after = await this.place(session);
      const stats = kind === "landed" && e.landed ? await this.statsOf(extra.root ?? this.read(session).cards.find((c) => c.entry === e.id)!.root, e).catch(() => undefined) : undefined;
      const root = extra.root ?? this.read(session).cards.find((c) => c.entry === e.id)!.root;
      const head = await this.headOf(root, e.branch);
      const rec = this.read(session);
      if (rec.done[key]) return;
      const card = rec.cards.find((c) => c.entry === e.id);
      if (!card) return; // gone meanwhile (its records were cleared while this waited)
      this.fill(card, e, extra.run);
      setOpt(card, "head", head);
      if (stats) card.stats = stats;
      // The checked fixes that went in on the user's one Land (al_3 q6), frozen at landing.
      if (kind === "landed") {
        const fixes = await this.fixesOf(root, e).catch(() => undefined);
        setOpt(card, "fixesLanded", fixes?.length ? fixes : undefined);
      }
      // Remove from Queue: the card's last revision; a later Land of the branch moves the same card on.
      if (kind === "removed") {
        card.removed = true;
        try {
          this.deps.dropRequests?.(e.id);
        } catch (err) {
          this.deps.log?.(`[merge-queue] ${e.id}'s requests not dropped: ${err instanceof Error ? err.message : err}`);
        }
      }
      card.revisions.push(this.revision(card, kind, after, run || undefined));
      rec.done[key] = this.iso();
      let wake: string | null = null;
      if (LINE_KINDS.includes(kind)) rec.lines.push({ key, at: this.iso(), text: lineText(kind as "landed" | "drafts-changed", e, card) });
      if (WAKE_KINDS.includes(kind)) {
        // The queue's request (§chat.merge-queue/requests): its own words when it recorded one, else today's notice.
        wake = extra.request ? requestText(extra.request) : wakeText(kind === "sent-back" ? "sent-back" : "needs-fix", e, extra.run);
        // Pending in the same write as done[key]: a stop before the chat takes it leaves it to become the hidden line.
        rec.wakes = [...(rec.wakes ?? []).filter((w) => w.key !== key), { key, at: this.iso(), text: wake }];
        this.waking.add(key);
      }
      this.write(rec);
      this.publish(rec);
      if (wake) await this.sendWake(session, key, wake, { ...(extra.request ? { id: extra.request.id, kind: extra.request.kind } : { kind }), branch: e.branch, ...this.requestPlace(session, e), entry: e.id });
    } finally {
      this.pending.delete(key);
    }
  }

  /** A request's place, from the branch's card: a card older than the place line still names it in the request. */
  private requestPlace(session: string, e: MergeEntry): { place?: string } {
    const card = this.read(session).cards.find((c) => c.entry === e.id);
    const place = card ? (card.place?.label ?? this.deps.placeOf?.(card.root, card.target).label) : undefined;
    return place ? { place } : {};
  }

  /**
   * A request that is no outcome of its own (what still blocks a branch after Land, the thread's other approach, a
   * trial's end): sent to the branch's chat once per request id, the card refreshed in place, no new revision. A chat
   * that can't take notes gets it as the hidden line.
   */
  async request(e: MergeEntry, request: MergeChatRequest, run?: MergeRun): Promise<void> {
    if (!e.session) return;
    const session = e.session;
    const rootOf = this.read(session).cards.find((c) => c.entry === e.id)?.root;
    if (rootOf) await this.reviews(e, rootOf).catch(() => undefined);
    const key = `${e.id}:request:${request.id}`;
    if (this.pending.has(key) || this.read(session).done[key]) return;
    this.pending.add(key);
    try {
      const rec = this.read(session);
      const text = requestText(request);
      rec.done[key] = this.iso();
      rec.wakes = [...(rec.wakes ?? []).filter((w) => w.key !== key), { key, at: this.iso(), text }];
      this.waking.add(key);
      this.write(rec);
      await this.refresh(e, run);
      await this.sendWake(session, key, text, { id: request.id, kind: request.kind, branch: e.branch, ...this.requestPlace(session, e), entry: e.id });
    } finally {
      this.pending.delete(key);
    }
  }

  private async sendWake(session: string, key: string, text: string, info: { id?: string; kind?: string; branch?: string; entry?: string; place?: string }): Promise<void> {
    try {
      if (!this.deps.wake) return this.fallback(session, key, text);
      try {
        await this.deps.wake(session, text, info);
        this.clearWake(session, key);
        if (info.id) this.deps.delivered?.(info.id, "queued");
      } catch (err) {
        this.deps.log?.(`[merge-queue] wake of ${session} not taken (${err instanceof Error ? err.message : err}): it is the hidden line at its next turn`);
        this.fallback(session, key, text);
        if (info.id) this.deps.delivered?.(info.id, "fallback-line");
      }
    } finally {
      this.waking.delete(key);
    }
  }

  private clearWake(session: string, key: string): void {
    const rec = this.read(session);
    if (!rec.wakes?.some((w) => w.key === key)) return;
    rec.wakes = rec.wakes.filter((w) => w.key !== key);
    if (!rec.wakes.length) delete rec.wakes;
    this.write(rec);
  }

  private fallback(session: string, key: string, text: string): void {
    const rec = this.read(session);
    if (rec.wakes) {
      rec.wakes = rec.wakes.filter((w) => w.key !== key);
      if (!rec.wakes.length) delete rec.wakes;
    }
    if (rec.lines.some((l) => l.key === key)) return this.write(rec);
    rec.lines.push({ key, at: this.iso(), text: text.slice(MERGE_QUEUE_SENT_PREFIX.length).trim() });
    this.write(rec);
  }

  /** The branch's head now (Land Again pins it); undefined: gone or unreadable. */
  private async headOf(root: string, branch: string): Promise<string | undefined> {
    const r = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], root).catch(() => null);
    return r && r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }

  /** The card's live data from the entry, in place (no revision). */
  private async refresh(e: MergeEntry, run?: MergeRun): Promise<void> {
    if (!e.session) return;
    const rec = this.read(e.session);
    const card = rec.cards.find((c) => c.entry === e.id);
    if (!card) return;
    if (!this.fill(card, e, run)) return;
    this.write(rec);
    this.publish(rec);
  }

  /**
   * A queue's view changed: every card whose entry it shows takes its live data in place (place in line, estimate,
   * "4 of 7 steps"); an outcome the queue reached without a notice of its own (conflict, behaviour differs, review
   * flagged) raises its revision here, keyed like the rest.
   */
  async sync(view: MergeQueueView): Promise<void> {
    const entries = [...view.checking, ...view.waiting, ...view.needsYou, ...view.needsFix, ...view.recent.map((r) => r.entry)];
    const seen = new Set<string>();
    const bySession = new Map<string, MergeEntry[]>();
    for (const e of entries) {
      if (!e.session || seen.has(e.id)) continue;
      seen.add(e.id);
      bySession.set(e.session, [...(bySession.get(e.session) ?? []), e]);
    }
    for (const [session, list] of bySession) {
      this.settleStaleWakes(session);
      for (const e of list) if (e.reviews?.length) await this.reviews(e, view.root).catch((err) => this.deps.log?.(`[merge-queue] review cards of ${e.id}: ${err instanceof Error ? err.message : err}`));
      const heads = new Map<string, string | undefined>();
      for (const e of list) if (!heads.has(e.branch)) heads.set(e.branch, await this.headOf(view.root, e.branch));
      const rec = this.read(session);
      let changed = false;
      const outcomes: MergeEntry[] = [];
      for (const e of list) {
        const card = rec.cards.find((c) => c.entry === e.id);
        if (!card) continue;
        if (card.head !== heads.get(e.branch)) {
          setOpt(card, "head", heads.get(e.branch));
          changed = true;
        }
        const progress = view.current && view.current.entry === e.id && e.state === "checking" ? progressOf(view.current) : undefined;
        if (this.fill(card, e, undefined, progress)) changed = true;
        const kind = OUTCOME_OF_STATE[e.state];
        const run = kind === "decision" && e.decision ? e.decision.id : (e.run ?? "");
        // Can't tell whose failure reaches the card only once it is raised to the user (the thread rules first).
        const unraised = e.state === "unattributed" && !(e.decision && !e.decision.answered);
        if (kind && !unraised && !rec.done[`${e.id}:${kind}:${run}`] && !(kind === "needs-fix" && rec.done[`${e.id}:sent-back:${run}`])) outcomes.push(e);
      }
      if (changed) {
        this.write(rec);
        this.publish(rec);
      }
      for (const e of outcomes) await this.outcome(OUTCOME_OF_STATE[e.state]!, e, { root: view.root });
    }
  }

  /** Copy the entry's live fields onto the card; true when anything changed. */
  private fill(card: MergeCard, e: MergeEntry, run?: MergeRun, progress?: { done: number; total: number }): boolean {
    const before = JSON.stringify(card);
    card.commit = e.commit;
    card.state = e.state;
    setOpt(card, "position", e.state === "queued" ? e.position : undefined);
    setOpt(card, "eta", e.state === "queued" || e.state === "checking" ? e.eta : undefined);
    setOpt(card, "reason", e.reason);
    setOpt(card, "newerCommits", e.newerCommits);
    setOpt(card, "newerRewritten", e.state === "needs-fix" ? e.newerRewritten : undefined);
    setOpt(card, "newerBlocked", e.state === "needs-fix" ? e.newerBlocked : undefined);
    setOpt(card, "run", e.run);
    setOpt(card, "progress", e.state === "checking" ? (progress ?? card.progress) : undefined);
    card.notes = structuredClone(e.notes);
    setOpt(card, "conflict", e.conflict ? structuredClone(e.conflict) : undefined);
    setOpt(card, "review", e.review ? structuredClone(e.review) : undefined);
    setOpt(card, "unclear", e.state === "unattributed" && e.unclear?.length ? structuredClone(e.unclear) : undefined);
    setOpt(card, "landed", e.landed ? structuredClone(e.landed) : undefined);
    setOpt(card, "request", e.request ? structuredClone(e.request) : undefined);
    setOpt(card, "worktree", e.worktree);
    // A card with a place keeps it current (a rename, an archive); one written before the line never gets it.
    if (card.place && this.deps.placeOf) card.place = this.deps.placeOf(card.root, card.target);
    setOpt(card, "redrafted", e.state === "needs-fix" && e.redrafted ? true : undefined);
    // Back with its chat under the standing Land (al_3) shows what went back as a final needs-fix does: why, what
    // failed, the thread's word, and that nothing is left to fix once git says so.
    const sentBack = e.state === "needs-fix" || e.state === "with-chat";
    setOpt(card, "sentBackFor", sentBack ? e.sentBackFor : undefined);
    setOpt(card, "settled", sentBack ? e.settled : undefined);
    const thread = sentBack ? e.notes.find((n) => n.kind === "thread") : undefined;
    setOpt(card, "explanation", thread ? { text: thread.text, at: thread.at } : undefined);
    setOpt(card, "decision", e.decision && !e.decision.answered ? structuredClone(e.decision) : undefined);
    setOpt(card, "standing", e.state === "with-chat" && e.standing ? structuredClone(e.standing) : undefined);
    setOpt(card, "tries", e.tries && e.state !== "landed" ? structuredClone(e.tries) : undefined);
    // A blocking review's findings are on its own card: the queue card points there and lists no Review failure.
    const review = e.reviews?.at(-1);
    const pointed = review && POINTED.includes(review.state) && (e.state === "with-chat" || e.state === "needs-user") ? review : undefined;
    setOpt(card, "reviewFound", pointed ? { card: pointed.id, session: this.homes.get(e.id)?.id ?? e.session ?? card.session, ...(this.homes.get(e.id)?.path ? { path: this.homes.get(e.id)!.path } : {}), count: pointed.findings.length } : undefined);
    if (run && sentBack) card.failures = failuresOf(run, !!pointed);
    else if (!sentBack) delete card.failures;
    else if (pointed && card.failures) card.failures = card.failures.filter((f) => !f.step.startsWith("review"));
    const changed = JSON.stringify(card) !== before;
    if (changed) card.updatedAt = this.iso();
    return changed;
  }

  /** The fix commits a standing approval carried that landed (approval.fixes with a commit), with their subjects. */
  private async fixesOf(root: string, e: MergeEntry): Promise<{ sha: string; subject: string }[]> {
    const out: { sha: string; subject: string }[] = [];
    const user = e.approval.userCommit;
    for (const f of e.approval.fixes ?? []) {
      if (!f.commit) continue;
      // Every commit the fix brought past the commit before it (the user's, or the previous fix's).
      const from = out.length ? out[out.length - 1]!.sha : user;
      // The branch side only: a merge of the target into the branch lists as its merge commit, never the target's.
      const r = from ? await this.git(["log", "--reverse", "--first-parent", "--format=%H%x09%s", `${from}..${f.commit}`], root) : null;
      const lines = r?.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
      if (!lines.length) out.push({ sha: f.commit, subject: (await this.git(["log", "-1", "--format=%s", f.commit], root)).stdout.trim() });
      for (const l of lines) {
        const [sha, ...s] = l.split("\t");
        if (sha && !out.some((x) => x.sha === sha)) out.push({ sha, subject: s.join("\t").slice(0, 200) });
      }
    }
    return out;
  }

  /** What the branch brought, frozen at landing: from the target before it to the approved commit. */
  private async statsOf(root: string, e: MergeEntry): Promise<MergeCard["stats"]> {
    const from = e.landed!.from;
    const commits = await countBetween(this.git, root, from, e.commit);
    const s = await this.git(["diff", "--shortstat", `${from}...${e.commit}`], root);
    if (s.code !== 0) return undefined;
    return { commits, added: Number(/(\d+) insertion/.exec(s.stdout)?.[1] ?? 0), removed: Number(/(\d+) deletion/.exec(s.stdout)?.[1] ?? 0) };
  }
}

function setOpt<T extends object, K extends keyof T>(o: T, k: K, v: T[K] | undefined): void {
  if (v === undefined || v === null) delete o[k];
  else o[k] = v;
}

function progressOf(run: MergeRun): { done: number; total: number } | undefined {
  if (!run.steps.length) return undefined;
  return { done: run.steps.filter((s) => s.result === "passed" || s.result === "failed" || s.result === "skipped").length, total: run.steps.length };
}

function failuresOf(run: MergeRun, withoutReview = false): MergeCardFailure[] {
  return run.steps
    .filter((s) => s.result === "failed" && !(withoutReview && s.kind === "review"))
    .slice(0, 6)
    .map((s) => {
      const tests = (s.failures ?? [])
        .filter((f) => f.blame === "branch" || !f.blame)
        .slice(0, 4)
        .map((f) => [f.file, f.name].filter(Boolean).join(" › "))
        .filter(Boolean);
      return { run: run.id, step: s.id, label: s.label, ...(s.detail ? { detail: s.detail } : {}), ...(tests.length ? { tests } : {}) };
    });
}

/** The hidden line the model reads at its next turn: what happened, no instruction to act. */
export function lineText(kind: "landed" | "drafts-changed", e: MergeEntry, card?: Pick<MergeCard, "stats">): string {
  if (kind === "drafts-changed") return `${e.branch}'s spec drafts changed since the user approved it at ${short(e.commit)}, so it waits in the merge queue until they land it again.`;
  const parts = [`${e.branch} landed on ${e.target} at ${short(e.landed?.sha)}${card?.stats ? `, ${card.stats.commits} commit${card.stats.commits === 1 ? "" : "s"}` : ""} (the commit approved, ${short(e.commit)}).`];
  const newer = newerWords(e.newerCommits);
  if (newer) parts.push(`${newer[0]!.toUpperCase()}${newer.slice(1)}.`);
  const note = e.notes.find((n) => n.kind === "thread" || n.kind === "operator");
  if (note) parts.push(`Note: ${note.text}`);
  // A notes-only review, whole: told quietly, starting no turn (§chat.merge-queue/chat-turns).
  const notes = reviewNotesLine(e.review);
  if (notes) parts.push(notes);
  if (e.landed?.pushed === "not-pushed" && e.landed.pushWhy) parts.push(`Not pushed: ${e.landed.pushWhy}.`);
  return parts.join(" ");
}

/** A recorded request's words as its note says them: the queue's (MERGE_QUEUE_SENT_PREFIX, which the note drops). */
export function requestText(r: Pick<MergeChatRequest, "text">): string {
  return `${MERGE_QUEUE_SENT_PREFIX} ${r.text.trim()}`;
}

/** A wake's text: the queue's (MERGE_QUEUE_SENT_PREFIX), never the user's words. */
export function wakeText(kind: Extract<MergeNoticeKind, "needs-fix" | "sent-back">, e: MergeEntry, run?: MergeRun): string {
  const body = noticeText(kind, e, run ? { run } : {});
  return `${MERGE_QUEUE_SENT_PREFIX} ${body}`;
}
