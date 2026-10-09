// The one-time import of what an org already has into its history (adapter `import` v1). It reads the
// org's statecharts (the current state, never changed here) for the facts they identify: the org, each
// placed project, gap, gathering, decision and build. Each becomes one `history.imported` event keyed by
// the fact's kind and id, carrying the live capture's handles as aliases (so a later act names it), the
// source's own time only where the source records it, the import time apart, and only the links the
// source declares. Who started or decided it, who was there and why are not recorded, so they read
// unknown; nothing is matched by title or words, and no About text, profile, contact value, statement,
// quote or transcript is read. A snapshot imported now is what was observed at import.
//
// The facts and the receipt (`import:baseline:<org>`) are one journal step, so all of it or none: the very
// step in which this host's residence comes to hold the org (an attach, a create), so they are in the commit
// it makes on entering `held-here`; or, for an org this host already held when its history began, one
// `record` call at the engine's boot. The receipt is in `history/`, so the import runs once: again, on this
// host or a clone, nothing new. Only a host holding the org (its residence `held-here`) imports.
import type { ActorRef, EntityRef, EvidenceRef, EventId, HistoryInput, Unknown } from "../../shared/org-history";
import type { ComposeContext, OrgHost } from "../org-host";
import type { Step } from "../statecharts";

export const IMPORT_ADAPTER = { adapter: "import", version: 1 } as const;

type Host = Pick<OrgHost, "configuration" | "data" | "sessions" | "record" | "history">;

export const receiptKey = (orgId: string): string => `import:baseline:${orgId}`;

const SOVA: ActorRef = { kind: "sova" };
const NOT_RECORDED: Unknown = { unknown: true, why: "Not recorded before history began." };
const UNCHECKED = "Imported: the quote and its speaker weren't checked.";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const last = (sid: string): string => sid.slice(sid.lastIndexOf("/") + 1);
const link = (d: Record<string, unknown>, name: string): string | undefined => (isObj(d["sova/links"]) ? str(d["sova/links"][name]) : undefined);

/** Whether this host holds the org now (§app.organizations/holder), read at the call. */
export function holdsOrg(host: Pick<Host, "configuration">, orgId: string): boolean {
  return host.configuration(`residence/${orgId}`)?.includes("held-here") === true;
}

export type ImportOutcome = { ran: false; why: "not-held" | "done-before" } | { ran: true; facts: number; ids: EventId[] };

const ACTORS = { initiatedBy: NOT_RECORDED, decidedBy: NOT_RECORDED, recordedBy: SOVA, executedBy: SOVA, authorization: NOT_RECORDED };

/** A new org's receipt: nothing to import, recorded live (not partial coverage). */
const freshReceipt = (orgId: string): HistoryInput => ({
  kind: "history.imported",
  outcome: "recorded",
  projects: { primary: null },
  actors: { recordedBy: SOVA, executedBy: SOVA },
  source: { ...IMPORT_ADAPTER, key: receiptKey(orgId) },
  capture: { origin: "live" },
});

/**
 * Import the org's existing facts, once, as one `record` (the engine's boot, for an org this host already
 * holds). `fresh`: an org created on this version: only its receipt. Throws what `record` throws (nothing
 * written).
 */
export async function importBaseline(host: Host, orgId: string, opts: { fresh?: boolean; now?: number } = {}): Promise<ImportOutcome> {
  if (!holdsOrg(host, orgId)) return { ran: false, why: "not-held" };
  host.history.index.refresh();
  if (host.history.index.byKey.has(receiptKey(orgId))) return { ran: false, why: "done-before" };
  const inputs = opts.fresh ? [freshReceipt(orgId)] : baselineInputs(host, orgId, opts.now ?? Date.now());
  const ids = await host.record(inputs);
  return { ran: true, facts: inputs.length - 1, ids };
}

/**
 * The history composer's part (server/orgs.ts openHost): in the step where this org's residence enters
 * `held-here` (an attach confirmed or read, a create), the import's inputs, so they are written in that
 * step's journal, before the commit it makes on entering. Never throws: one it can't make is a workspace
 * problem, and the import waits for the engine's next boot.
 */
export function baselineOnHold(host: Host, orgId: string, steps: readonly Step[], ctx: Pick<ComposeContext, "at" | "onProblem">): HistoryInput[] {
  const sid = `residence/${orgId}`;
  if (!steps.some((s) => s.sessionId === sid && s.after.includes("held-here") && !s.before.includes("held-here"))) return [];
  try {
    fault?.();
    host.history.index.refresh();
    if (host.history.index.byKey.has(receiptKey(orgId))) return [];
    return host.data(sid)?.created === true ? [freshReceipt(orgId)] : baselineInputs(host, orgId, ctx.at);
  } catch (err) {
    ctx.onProblem(`the import of existing records waits for the next start: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

let fault: (() => void) | null = null;
/** Tests only: a throw inside baselineOnHold (null: none). */
export function setBaselineFaultForTest(fn: (() => void) | null): void {
  fault = fn;
}

/** Every fact not yet in the history, then the receipt (last). */
function baselineInputs(host: Host, orgId: string, importedAt: number): HistoryInput[] {
  const index = host.history.index;
  const actors = ACTORS;
  /** A fact already in the history (captured live, or imported) by its key or any handle. */
  const known = (...keys: string[]): boolean => keys.some((k) => index.byKey.has(k));
  const inputs: HistoryInput[] = [];
  const fact = (kind: string, id: string, primary: string | null, entity: EntityRef, more: Partial<HistoryInput>): void => {
    inputs.push({
      kind: "history.imported",
      outcome: "observed",
      projects: { primary },
      entities: [entity],
      actors,
      source: { ...IMPORT_ADAPTER, key: `import:${kind}:${id}` },
      capture: { origin: "imported", importedAt, importOf: { kind, id } },
      ...more,
    });
  };

  const org = host.sessions("org").find((s) => s.id === `org/${orgId}`);
  if (org && !known(`import:org:${orgId}`)) fact("org", orgId, null, { type: "org", id: orgId }, { occurredAt: num(org.data.createdAt) });

  for (const s of host.sessions("placement")) {
    const pid = str(s.data.projectId);
    if (!pid || known(`import:project:${pid}`)) continue;
    fact("project", pid, pid, { type: "project", id: pid }, { occurredAt: num(s.data.placedAt) });
  }

  // A gap's item has no creation time of its own.
  for (const s of host.sessions("item")) {
    const gid = str(s.data.id);
    if (!gid || known(`import:gap:${gid}`, `gap:${gid}`)) continue;
    fact("gap", gid, str(s.data.projectId) ?? null, { type: "gap", id: gid }, { aliases: [`gap:${gid}`] });
  }

  for (const s of host.sessions("baton")) {
    const sid = str(s.data.sessionId);
    if (!sid || known(`import:gathering:${sid}`, `sc:${s.id}`, `session:${sid}`)) continue;
    const item = link(s.data, "item");
    const conflict = isObj(s.data.conflict) ? str(s.data.conflict.id) : undefined;
    fact("gathering", sid, str(s.data.projectId) ?? null, { type: "gathering", id: sid }, {
      occurredAt: num(s.data.createdAt),
      aliases: [`sc:${s.id}`],
      ...(item ? { relationKeys: [{ key: `gap:${last(item)}`, type: "named-target", entity: { type: "gap", id: last(item) } }] } : {}),
      ...(conflict ? { relations: [{ type: "related", target: { entity: { type: "conflict", id: conflict } } }] } : {}),
    });
  }

  // Oldest first, so a newer decision's `supersedes` finds the one it superseded in the same step.
  const decisions = host.sessions("decision").sort((a, b) => (num(a.data.recordedAt ?? a.data.at) ?? 0) - (num(b.data.recordedAt ?? b.data.at) ?? 0));
  const supersedes = new Map<string, string[]>();
  for (const s of decisions) {
    const old = str(s.data.id);
    const by = str(s.data.supersededBy);
    if (old && by) supersedes.set(by, [...(supersedes.get(by) ?? []), old]);
  }
  for (const s of decisions) {
    const did = str(s.data.id);
    if (!did || known(`import:decision:${did}`, `decision:${did}`)) continue;
    const session = str(s.data.sessionId);
    const entry = str(s.data.entryId);
    const baton = link(s.data, "baton") ?? (session ? `baton/${orgId}/${session}` : undefined);
    const resolves = str(s.data.resolves);
    const evidence: EvidenceRef[] = session && entry ? [{ n: 1, kind: "transcript", session, entry, check: "unchecked", why: UNCHECKED }] : [];
    fact("decision", did, str(s.data.projectId) ?? null, { type: "decision", id: did }, {
      occurredAt: num(s.data.recordedAt ?? s.data.at),
      aliases: [`decision:${did}`, `sc:${s.id}`],
      relationKeys: [
        ...(session && baton ? [{ key: `sc:${baton}`, type: "recorded-in" as const, entity: { type: "gathering" as const, id: session } }] : []),
        ...(supersedes.get(did) ?? []).map((old) => ({ key: `decision:${old}`, type: "supersedes" as const, entity: { type: "decision" as const, id: old } })),
      ],
      ...(resolves ? { relations: [{ type: "related", target: { entity: { type: "conflict", id: resolves } } }] } : {}),
      ...(evidence.length ? { evidence } : {}),
    });
  }

  for (const s of host.sessions("build")) {
    const sid = str(s.data.sessionId);
    const pid = str(s.data.projectId) ?? null;
    if (!sid || known(`import:build:${sid}`, `sc:${s.id}`, `session:${sid}`)) continue;
    const item = str(s.data.item) ?? (link(s.data, "item") ? last(link(s.data, "item")!) : undefined);
    const ds = Array.isArray(s.data.decisions) ? s.data.decisions.filter((x): x is string => typeof x === "string" && !!x) : [];
    const commit = isObj(s.data.merged) ? str(s.data.merged.commit) : undefined;
    fact("build", sid, pid, { type: "build", id: sid }, {
      occurredAt: num(s.data.createdAt),
      aliases: [`sc:${s.id}`],
      relationKeys: [
        ...(item ? [{ key: `gap:${item}`, type: "named-target" as const, entity: { type: "gap" as const, id: item } }] : []),
        ...ds.map((d) => ({ key: `decision:${d}`, type: "named-target" as const, entity: { type: "decision" as const, id: d } })),
      ],
      ...(commit ? { evidence: [{ n: 1, kind: "git", repo: "project", ...(pid ? { project: pid } : {}), commit }] } : {}),
    });
  }

  // The receipt: that the import ran, from the snapshot as observed now; earlier acts, holds, sends and
  // reasons are not recorded (its headline says so), never "it never happened".
  inputs.push({
    kind: "history.imported",
    outcome: "recorded",
    projects: { primary: null },
    actors,
    source: { ...IMPORT_ADAPTER, key: receiptKey(orgId) },
    capture: { origin: "imported", importedAt, importOf: { kind: "baseline", id: orgId } },
  });
  return inputs;
}
