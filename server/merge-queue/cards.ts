import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type MergeCard,
  type MergeCardFailure,
  type MergeCardOutcome,
  type MergeCardRevision,
  type MergeEntry,
  type MergeQueueView,
  type MergeRun,
  newerWords,
} from "../../shared/merge-queue";
import { MERGE_QUEUE_SENT_PREFIX } from "../../shared/senders";
import { countBetween, type Git, realGit } from "./guard";
import { type MergeNoticeKind, noticeText } from "./notices";

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
  wake?: (session: string, text: string) => Promise<void>;
  /** A chat's cards changed. */
  publish?: (session: string, cards: MergeCard[]) => void;
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
};
const LINES_MAX = 50;
const CARDS_MAX = 200;
const short = (sha: string | undefined) => (sha ?? "").slice(0, 7);

export class MergeCards {
  private readonly git: Git;
  /** Keys being raised now (the place is read first): never twice at once. */
  private readonly pending = new Set<string>();
  /** Wakes this process is sending now (their record's `wakes` entry is theirs, not stale). */
  private readonly waking = new Set<string>();

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
        if (Array.isArray(r.cards)) return { session, cards: r.cards, done: r.done ?? {}, lines: r.lines ?? [], ...(r.wakes?.length ? { wakes: r.wakes } : {}) };
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
    const f = this.file(rec.session);
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(rec, null, 1)}\n`);
    renameSync(tmp, f);
  }

  private publish(rec: CardsRecord): void {
    try {
      this.deps.publish?.(rec.session, rec.cards);
    } catch (err) {
      this.deps.log?.(`[merge-queue] cards publish: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** A chat's cards, oldest first. */
  cardsOf(session: string): MergeCard[] {
    return this.read(session).cards;
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
        rec.cards.push(card);
      }
      this.fill(card, e);
      setOpt(card, "head", head);
      if (!rec.done[key]) {
        card.revisions.push(this.revision(card, "approved", after));
        rec.done[key] = this.iso();
      }
      this.write(rec);
      this.publish(rec);
    } finally {
      this.pending.delete(key);
    }
  }

  /** An outcome: a new revision at the chat's end, then its hidden line or its wake. Once per (entry, kind, run). */
  async outcome(kind: MergeCardOutcome | "explained", e: MergeEntry, extra: { run?: MergeRun; root?: string } = {}): Promise<void> {
    if (!e.session) return;
    const session = e.session;
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
    const run = extra.run?.id ?? e.run ?? "";
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
      const card = rec.cards.find((c) => c.entry === e.id)!;
      this.fill(card, e, extra.run);
      setOpt(card, "head", head);
      if (stats) card.stats = stats;
      // Remove from Queue: the card's last revision; a later Land of the branch moves the same card on.
      if (kind === "removed") card.removed = true;
      card.revisions.push(this.revision(card, kind, after, run || undefined));
      rec.done[key] = this.iso();
      let wake: string | null = null;
      if (LINE_KINDS.includes(kind)) rec.lines.push({ key, at: this.iso(), text: lineText(kind as "landed" | "drafts-changed", e, card) });
      if (WAKE_KINDS.includes(kind)) {
        wake = wakeText(kind === "sent-back" ? "sent-back" : "needs-fix", e, extra.run);
        // Pending in the same write as done[key]: a stop before the chat takes it leaves it to become the hidden line.
        rec.wakes = [...(rec.wakes ?? []).filter((w) => w.key !== key), { key, at: this.iso(), text: wake }];
        this.waking.add(key);
      }
      this.write(rec);
      this.publish(rec);
      if (wake) await this.sendWake(session, key, wake);
    } finally {
      this.pending.delete(key);
    }
  }

  private async sendWake(session: string, key: string, text: string): Promise<void> {
    try {
      if (!this.deps.wake) return this.fallback(session, key, text);
      try {
        await this.deps.wake(session, text);
        this.clearWake(session, key);
      } catch (err) {
        this.deps.log?.(`[merge-queue] wake of ${session} not taken (${err instanceof Error ? err.message : err}): it is the hidden line at its next turn`);
        this.fallback(session, key, text);
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
        const run = e.run ?? "";
        if (kind && !rec.done[`${e.id}:${kind}:${run}`] && !(kind === "needs-fix" && rec.done[`${e.id}:sent-back:${run}`])) outcomes.push(e);
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
    setOpt(card, "redrafted", e.state === "needs-fix" && e.redrafted ? true : undefined);
    setOpt(card, "sentBackFor", e.state === "needs-fix" ? e.sentBackFor : undefined);
    setOpt(card, "settled", e.state === "needs-fix" ? e.settled : undefined);
    const thread = e.state === "needs-fix" ? e.notes.find((n) => n.kind === "thread") : undefined;
    setOpt(card, "explanation", thread ? { text: thread.text, at: thread.at } : undefined);
    if (run && e.state === "needs-fix") card.failures = failuresOf(run);
    else if (e.state !== "needs-fix") delete card.failures;
    const changed = JSON.stringify(card) !== before;
    if (changed) card.updatedAt = this.iso();
    return changed;
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

function failuresOf(run: MergeRun): MergeCardFailure[] {
  return run.steps
    .filter((s) => s.result === "failed")
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
  if (e.landed?.pushed === "not-pushed" && e.landed.pushWhy) parts.push(`Not pushed: ${e.landed.pushWhy}.`);
  return parts.join(" ");
}

/** A wake's text: the queue's (MERGE_QUEUE_SENT_PREFIX), never the user's words. */
export function wakeText(kind: Extract<MergeNoticeKind, "needs-fix" | "sent-back">, e: MergeEntry, run?: MergeRun): string {
  const body = noticeText(kind, e, run ? { run } : {});
  return `${MERGE_QUEUE_SENT_PREFIX} ${body}`;
}
