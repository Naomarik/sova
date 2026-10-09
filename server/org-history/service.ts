// One org's history: its files, its index and its reads. The org host owns writing
// (OrgHost.commit puts a step's events in the step's own journal); this holds what the host needs for
// that (prepare, the open capture gap, the index refreshed after a commit) and serves every read.
import type { ActorRef, EventId, HistoryInput, HistoryReader } from "../../shared/org-history";
import { HistoryIndex } from "./index";
import { prepareHistory, type Prepared } from "./record";
import { HistoryReads, type HistoryLabels, type HistorySources } from "./query";
import { historyPaths, readGap, sweepTemps, writeGap, writerEpoch, type HistoryPaths, type OpenGap } from "./store";

const open = new Map<string, OrgHistory>();

/** The open history of an attached org, or null when its engine isn't open here. */
export function historyOf(orgId: string): OrgHistory | null {
  return open.get(orgId) ?? null;
}

export class OrgHistory {
  readonly paths: HistoryPaths;
  readonly index: HistoryIndex;
  readonly reads: HistoryReads;
  private epoch = "";
  isOpen = false;
  /** The index missed a commit's lines: rebuilt before the next prepare. */
  stale = false;

  constructor(
    readonly orgId: string,
    workspaceDir: string,
    stateDir: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.paths = historyPaths(orgId, workspaceDir, stateDir);
    this.index = new HistoryIndex(orgId, this.paths, clock);
    this.reads = new HistoryReads(this.index, this.paths);
  }

  /** At the host's open, after its journals were replayed and before any step: temp files swept, the
      index loaded or rebuilt (so a source key is never taken for new while the index is unknown). */
  open(): void {
    sweepTemps(this.paths);
    this.epoch = writerEpoch(this.paths);
    this.index.open();
    open.set(this.orgId, this);
    this.isOpen = true;
  }

  close(): void {
    this.index.flush();
    if (open.get(this.orgId) === this) open.delete(this.orgId);
  }

  prepare(inputs: readonly HistoryInput[], at: number, txn: string): Prepared {
    // a stale index is rebuilt before any key is checked against it (a throw here is a save failure);
    // anything appended outside this process (an import beside it) is indexed first too
    if (this.stale) {
      this.index.rebuild();
      this.stale = false;
    } else this.index.refresh();
    return prepareHistory(inputs, { orgId: this.orgId, at, txn, epoch: this.epoch, index: this.index, paths: this.paths });
  }

  /** After the step's journal committed: index the new lines (and persist at once after a purge). A
      failure leaves the index stale: the next prepare rebuilds it first. */
  afterCommit(p: Prepared): void {
    if (!p.events.length) return;
    try {
      this.index.refresh();
      if (p.events.some((e) => e.kind === "rationale.purged")) this.index.flush(true);
    } catch (err) {
      this.stale = true;
      throw err;
    }
  }

  // ---- capture gaps ------------------------------------------------

  openGap(): OpenGap | null {
    return readGap(this.paths);
  }

  /** A safety act ran while history couldn't be saved: the gap covers it (host-local until recorded). */
  extendGap(since: number, at: number): void {
    const g = readGap(this.paths);
    try {
      writeGap(this.paths, { from: g?.from ?? since, to: at, acts: (g?.acts ?? 0) + 1 });
    } catch (err) {
      console.warn(`[org-history] ${this.orgId}: capture gap not noted: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The gap's own event, recorded with the first step once saving works again. */
  gapInput(g: OpenGap, at: number): HistoryInput {
    const sova: ActorRef = { kind: "sova" };
    return {
      kind: "history.gap",
      outcome: "recorded",
      projects: { primary: null },
      actors: { recordedBy: sova, executedBy: sova },
      source: { adapter: "history", version: 1, key: `gap:${g.from}` },
      capture: { origin: "gap" },
      gap: { from: g.from, to: Math.max(g.to, at) },
    };
  }

  closeGap(): void {
    writeGap(this.paths, null);
  }

  // ---- reads -------------------------------------------------------------------------------------

  search(reader: HistoryReader, q: Parameters<HistoryReads["search"]>[1], labels?: HistoryLabels) {
    this.index.refresh();
    return this.reads.search(reader, q, labels);
  }

  event(reader: HistoryReader, id: EventId, opts: { asOf?: number } = {}, labels?: HistoryLabels, sources?: HistorySources) {
    this.index.refresh();
    return this.reads.detail(reader, id, opts, labels, sources);
  }

  trace(reader: HistoryReader, id: EventId, opts: Parameters<HistoryReads["trace"]>[2] = {}, labels?: HistoryLabels) {
    this.index.refresh();
    return this.reads.trace(reader, id, opts, labels);
  }

  packet(reader: HistoryReader, what: Parameters<HistoryReads["packet"]>[1], labels?: HistoryLabels, sources?: HistorySources) {
    this.index.refresh();
    return this.reads.packet(reader, what, labels, sources);
  }

  evidence(reader: HistoryReader, id: EventId, n: number, sources?: HistorySources, labels?: HistoryLabels) {
    this.index.refresh();
    return this.reads.evidence(reader, id, n, sources, labels);
  }

  coverage(reader: HistoryReader) {
    this.index.refresh();
    return this.reads.coverage(reader, this.openGap());
  }

  /** Purge Reason…'s input (the host records it: `host.record([...])`): removes the rationale file and
      its words in the same step. Throws when there is nothing to purge. */
  purgeInput(id: EventId, by: ActorRef): HistoryInput {
    const e = this.index.entry(id);
    if (!e || !e.ok) throw new Error("No such event in this organization.");
    if (!e.rationale) throw new Error("This event has no recorded reason.");
    if (this.index.later.get(id)?.some((l) => this.index.entry(l)?.kind === "rationale.purged")) throw new Error("This event's reason is already purged.");
    return {
      kind: "rationale.purged",
      outcome: "done",
      projects: { primary: e.primary, affected: e.affected },
      actors: { initiatedBy: by, decidedBy: by, recordedBy: by, executedBy: { kind: "sova" }, authorization: { kind: "operator-act" } },
      source: { adapter: "history", version: 1, key: `purge:${id}` },
      about: id,
    };
  }
}
