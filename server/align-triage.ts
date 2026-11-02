import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ALIGN_STAKES, type AlignStakes, type AlignTriage, type DecisionProviderId, type DecisionSettings, type SessionSummary } from "../shared/protocol";
import { openDocsOf, openQuestionsOf, type AlignDocument } from "../pi-config/extensions/mode/align.ts";
import { withUsageContext } from "../pi-config/extensions/llm-inflight/attribution.ts";
import type { HEntry } from "../shared/harness";
import { alignDocsIn } from "./align-state";
import { exclusionReason } from "./attention-signals";
import { DecisionError, type DecisionProvider, type JsonObject, type Question } from "./decide";
import { stateRoot } from "./state-root";

/**
 * Triage on an alignment card (§app.decisions/align-triage): ONE decision per card version (`al_N`
 * at its `rev`), a `stakes_{qN}` choice per open question — low-risk, or flagged as deleting data,
 * costing money, or changing architecture or a shared contract. Shown as a chip per question; it
 * never changes what accepting does. Stored per session, document and rev in
 * `<stateRoot>/align-triage.json`, so a version is asked once. Only with attention signals on and
 * through the same exclusions as the turn card; the request goes through the redacting provider.
 */

const STAKES_OPTIONS = {
  "low-risk": "Cosmetic, easy to undo, or confined to this piece of work.",
  "deletes-data": "Something is deleted, overwritten or lost for good (files, records, history, branches).",
  "costs-money": "It spends money or paid quota (a paid model, a service, hardware, a subscription).",
  "changes-architecture-or-contract": "It changes the architecture, a shared contract, an API, a data format, or other people's code.",
};

/** The stakes choice for ONE open question, naming it by id and topic so the provider judges only it. Pure. */
export const stakesQuestion = (q: { id: string; topic: string }): Question => ({
  type: "choice",
  instructions:
    `Judge only question ${q.id} (topic: ${JSON.stringify(q.topic)}) in \`questions\`. Ignore the card's title, summary and other questions except as background. ` +
    "What does its recommended answer put at stake if accepted without a second look? Judge from that question's `ask`, its `options` (each with the consequence of picking it) and its `recommendation`.",
  options: { ...STAKES_OPTIONS },
});

export const triageFile = () => join(stateRoot(), "align-triage.json");

interface TriageRecord {
  rev: number;
  at: number;
  provider: DecisionProviderId;
  model: string;
  stakes: Record<string, AlignStakes>;
}

const isRec = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function load(file: string): Record<string, TriageRecord> {
  const out: Record<string, TriageRecord> = Object.create(null);
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    if (!isRec(v) || !isRec(v.cards)) return out;
    for (const [k, r] of Object.entries(v.cards)) {
      if (!isRec(r) || typeof r.rev !== "number" || !isRec(r.stakes)) continue;
      const stakes: Record<string, AlignStakes> = {};
      for (const [q, st] of Object.entries(r.stakes)) if ((ALIGN_STAKES as readonly string[]).includes(st as string)) stakes[q] = st as AlignStakes;
      out[k] = { rev: r.rev, at: Number(r.at) || 0, provider: r.provider, model: String(r.model ?? ""), stakes };
    }
  } catch {
    // missing or corrupt: empty
  }
  return out;
}

function save(file: string, cards: Record<string, TriageRecord>): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, cards }));
    renameSync(tmp, file);
  } catch (err) {
    console.warn("[align-triage] write failed:", err instanceof Error ? err.message : String(err));
  }
}

/** The state of one card: its title, summary and open questions, never findings, notes or code. Pure. */
export function triageState(doc: AlignDocument): JsonObject {
  return {
    title: doc.title,
    summary: doc.summary,
    questions: openQuestionsOf(doc).map((q) => ({
      id: q.id,
      topic: q.topic,
      ask: q.ask,
      ...(q.options?.length ? { options: q.options.map((o) => ({ label: o.label, consequence: o.tradeoff })) } : {}),
      recommendation: q.recommendation.choice,
    })),
  };
}

/** The questions of one card: a stakes choice per open question. Pure. */
export const triageQuestions = (doc: AlignDocument): Record<string, Question> =>
  Object.fromEntries(openQuestionsOf(doc).map((q) => [`stakes_${q.id}`, stakesQuestion(q)]));

export interface TriageDeps {
  settings: () => DecisionSettings;
  provider: () => DecisionProvider | null;
  held: (path: string) => boolean;
  file?: string;
  now?: () => number;
  home?: string;
}

/**
 * The triage of a session's open alignment cards, asking for any version not answered yet. Never
 * throws: a refused or failed request leaves that card without chips.
 */
export async function alignTriage(s: SessionSummary, branch: readonly HEntry[], deps: TriageDeps): Promise<AlignTriage> {
  const file = deps.file ?? triageFile();
  const docs = openDocsOf(alignDocsIn(branch)).filter((d) => openQuestionsOf(d).length > 0);
  const out: AlignTriage = { docs: {} };
  if (!docs.length) return out;
  const settings = deps.settings();
  const allowed = settings.features.attention && !exclusionReason(s, settings, deps.held(s.path), deps.home);
  let cards = load(file);
  for (const doc of docs) {
    const key = `${s.id}:${doc.id}`;
    let rec = cards[key]?.rev === doc.rev ? cards[key] : undefined;
    if (!rec && allowed) {
      const provider = deps.provider();
      if (!provider) continue;
      try {
        const r = await withUsageContext({ owner: s.id, cwd: s.cwd, kind: "oneshot" }, () =>
          provider.decide({ purpose: "align-triage", state: triageState(doc), questions: triageQuestions(doc), dedupeKey: `align-triage:${key}:${doc.rev}` }),
        );
        const stakes: Record<string, AlignStakes> = {};
        for (const q of openQuestionsOf(doc)) {
          const a = r.answers[`stakes_${q.id}`];
          if (a?.type === "choice" && (ALIGN_STAKES as readonly string[]).includes(a.choice)) stakes[q.id] = a.choice as AlignStakes;
        }
        rec = { rev: doc.rev, at: (deps.now ?? Date.now)(), provider: r.provider, model: r.model, stakes };
        cards = load(file);
        cards[key] = rec;
        save(file, cards);
      } catch (err) {
        if (err instanceof DecisionError && err.failure === "bad-request") console.error("[align-triage] question rejected:", err.message);
        continue;
      }
    }
    if (rec) out.docs[doc.id] = { rev: rec.rev, provider: rec.provider, model: rec.model, stakes: { ...rec.stakes } };
  }
  return out;
}
