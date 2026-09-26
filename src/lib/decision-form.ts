import type {
  DecisionChainStatus,
  DecisionFailure,
  DecisionKeyInfo,
  DecisionProbeResult,
  DecisionProviderId,
  DecisionProviderStatus,
  DecisionSettings,
  DelegateOptions,
  TagsBackfillProgress,
  WorkerChoice,
} from "../../shared/protocol";
import { sameChoice, type DraftChoice } from "./delegate-form";

/**
 * Settings → Decisions' form rules. Pure, so the component only draws. The fallback row is
 * Delegate's (delegate-form.ts, WorkerSlotRow), with its rule: nothing here ever picks a model the
 * user didn't — the server's suggestions are offered as buttons, never preselected. The Jev key is
 * not part of the draft: it is set and removed on its own, and only its last 4 characters and its
 * status ever reach this screen.
 */

/** The draft keeps the exclusion list as typed (one prefix per line), so a half-typed line stays. */
export type DecisionDraft = Omit<DecisionSettings, "fallback" | "exclusions"> & { fallback: DraftChoice | null; exclusions: string };

export const draftOf = (s: DecisionSettings): DecisionDraft => ({
  version: 1,
  jev: { enabled: s.jev.enabled },
  fallback: s.fallback ? { ...s.fallback } : null,
  features: { attention: s.features.attention, tags: s.features.tags },
  exclusions: s.exclusions.join("\n"),
  neverSendTui: s.neverSendTui,
});

export const cloneDecision = (d: DecisionDraft): DecisionDraft => JSON.parse(JSON.stringify(d));

/** The exclusion lines as saved: trimmed, blanks dropped, duplicates once, in typed order. */
export function parseExclusions(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The most folders the server keeps. */
export const MAX_EXCLUSIONS = 100;

/** The first line the server would refuse (not absolute, not `~/`), as one sentence; or null. */
export function exclusionIssue(text: string): string | null {
  const list = parseExclusions(text);
  if (list.length > MAX_EXCLUSIONS) return `That's ${list.length} folders. Use at most ${MAX_EXCLUSIONS}.`;
  const bad = list.find((p) => !(p.startsWith("/") || p === "~" || p.startsWith("~/")));
  return bad === undefined ? null : `"${bad}" isn't a full path. Start it with / or ~/.`;
}

/** What PUT sends: the draft with the exclusions parsed. Only for a complete draft. */
export function settingsOf(d: DecisionDraft): DecisionSettings {
  return {
    version: 1,
    jev: { enabled: d.jev.enabled },
    fallback: d.fallback ? ({ ...d.fallback } as WorkerChoice) : null,
    features: { attention: d.features.attention, tags: d.features.tags },
    exclusions: parseExclusions(d.exclusions),
    neverSendTui: d.neverSendTui,
  };
}

export function sameDecision(a: DecisionDraft, b: DecisionSettings | DecisionDraft): boolean {
  const bx = typeof b.exclusions === "string" ? parseExclusions(b.exclusions) : b.exclusions;
  const ax = parseExclusions(a.exclusions);
  return (
    a.jev.enabled === b.jev.enabled &&
    sameChoice(a.fallback, b.fallback) &&
    a.features.attention === b.features.attention &&
    a.features.tags === b.features.tags &&
    a.neverSendTui === b.neverSendTui &&
    ax.length === bx.length &&
    ax.every((p, i) => p === bx[i])
  );
}

/** The fallback switch: on starts with the backend only (the user picks the model); off is null. */
export const fallbackOn = (on: boolean): DraftChoice | null => (on ? { backend: "claude-code", model: "", effort: "" } : null);

/** A fallback that can be written: off, or backend, model and effort all chosen. */
export const fallbackReady = (f: DraftChoice | null): boolean => f === null || (!!f.model && !!f.effort);

/**
 * What autosave writes: the draft, except the parts that can't be written yet, which keep what is
 * saved — a fallback not fully chosen, a fallback the server refused (`refused`, until it is
 * changed), and exclusions with a line that isn't a full path. So a half-made edit never holds the
 * other controls back, and is never sent half-made.
 */
export function commitOf(d: DecisionDraft, saved: DecisionSettings, refused: DraftChoice | null = null): DecisionSettings {
  const keepFallback = !fallbackReady(d.fallback) || (refused !== null && sameChoice(d.fallback, refused));
  const fallback = keepFallback ? saved.fallback : (d.fallback as WorkerChoice | null);
  return {
    version: 1,
    jev: { enabled: d.jev.enabled },
    fallback: fallback ? { ...fallback } : null,
    features: { attention: d.features.attention, tags: d.features.tags },
    exclusions: exclusionIssue(d.exclusions) === null ? parseExclusions(d.exclusions) : [...saved.exclusions],
    neverSendTui: d.neverSendTui,
  };
}

/**
 * A write failed and the saved settings stand: every field that write tried to change goes back
 * to what is saved, and the rest of the draft (a half-chosen fallback, a line being fixed) stays.
 */
export function revertFailed(d: DecisionDraft, sent: DecisionSettings, saved: DecisionSettings): DecisionDraft {
  const out = cloneDecision(d);
  const back = draftOf(saved);
  if (sent.jev.enabled !== saved.jev.enabled) out.jev = back.jev;
  if (!sameChoice(sent.fallback, saved.fallback)) out.fallback = back.fallback;
  if (sent.features.attention !== saved.features.attention) out.features.attention = back.features.attention;
  if (sent.features.tags !== saved.features.tags) out.features.tags = back.features.tags;
  if (sent.neverSendTui !== saved.neverSendTui) out.neverSendTui = back.neverSendTui;
  if (sent.exclusions.join("\n") !== saved.exclusions.join("\n")) out.exclusions = back.exclusions;
  return out;
}

/** A save's notes, placed under the section each is about; `other` is anything that names none. */
export interface PlacedWarnings {
  fallback: string[];
  features: string[];
  other: string[];
}

export const noWarnings = (): PlacedWarnings => ({ fallback: [], features: [], other: [] });

const FALLBACK_LABEL = "Fallback model: ";

/**
 * Sorts the server's notes: the fallback's own ("Fallback model: …", shown without the label under
 * that row, and "Not verified, because …: Fallback model"), the features' ("… The features stay
 * unavailable …"), and the rest. Then merges them with what was showing: the fallback's notes come
 * only with a changed fallback, so they stay until the next save that changes it; the rest are
 * the server's view at every save and are replaced by each.
 */
export function placeWarnings(prev: PlacedWarnings, warnings: string[], fallbackChanged: boolean): PlacedWarnings {
  const next = noWarnings();
  for (const w of warnings) {
    if (w.startsWith(FALLBACK_LABEL)) next.fallback.push(w.slice(FALLBACK_LABEL.length));
    else if (w.startsWith("Not verified") && w.endsWith("Fallback model")) next.fallback.push(w);
    else if (w.includes("The features stay unavailable")) next.features.push(w);
    else next.other.push(w);
  }
  if (!fallbackChanged && next.fallback.length === 0) next.fallback = prev.fallback;
  return next;
}

/** Who would answer with this draft, in order — the rule the server's chain follows. */
export function draftProviders(d: DecisionDraft, key: DecisionKeyInfo): ("jev" | "fallback")[] {
  const order: ("jev" | "fallback")[] = [];
  if (d.jev.enabled && key.present && key.status !== "rejected") order.push("jev");
  if (d.fallback && d.fallback.model) order.push("fallback");
  return order;
}

/** "Unavailable: …" for settings nobody can answer — Jev off or unable, and no fallback model. */
export function unavailableLine(jevEnabled: boolean, key: DecisionKeyInfo): string {
  if (!jevEnabled) return "Unavailable: Jev is off and no fallback model is set. Nothing is checked.";
  const why = !key.present ? "no key" : key.status === "rejected" ? "key rejected" : "not answering";
  return `Unavailable: Jev can't answer (${why}) and no fallback model is set. Nothing is checked until one of them can.`;
}

/**
 * A warning for a draft whose features are on but that nobody could answer: the features then
 * send nothing and mark nothing. Null when both features are off or someone can answer.
 */
export function unansweredIssue(d: DecisionDraft, key: DecisionKeyInfo): string | null {
  if (!d.features.attention && !d.features.tags) return null;
  if (draftProviders(d, key).length > 0) return null;
  return unavailableLine(d.jev.enabled, key);
}

/** A key as pasted: trimmed; 20 to 512 characters with no spaces, like the server's own rule. */
export function keyInputIssue(text: string): string | null {
  const t = text.trim();
  if (!t) return "Paste a key.";
  if (/\s/.test(t)) return "A key has no spaces.";
  if (t.length < 20 || t.length > 512) return "That doesn't look like a Jev key.";
  return null;
}

/**
 * What a Test Decisions result says about the stored key: Jev answering proves it works, and Jev
 * failing with `auth` means it was rejected. Anything else (Jev not asked, or failing another way)
 * says nothing about the key, so it is returned unchanged. The server's own status replaces this
 * on the next read of the settings.
 */
export function keyAfterProbe(key: DecisionKeyInfo, r: DecisionProbeResult, now = Date.now()): DecisionKeyInfo {
  if (!key.present) return key;
  if (r.ok && r.provider === "jev") return { ...key, status: "ok", checkedAt: now, message: undefined };
  const jevFailure = r.fellBackFrom?.provider === "jev" ? r.fellBackFrom : !r.ok && r.provider === "jev" ? { failure: r.failure, message: r.message } : null;
  if (jevFailure?.failure === "auth") return { ...key, status: "rejected", checkedAt: now, message: jevFailure.message };
  return key;
}

/** Jev's fact line: "Key ending ab12 · checked 2h ago.", never more of the key than its last 4. */
export function keyLine(key: DecisionKeyInfo, now = Date.now()): string {
  if (!key.present) return "No key stored.";
  if (key.status === "rejected") return "Jev rejected this key. Replace it, or turn Jev off.";
  const head = `Key ending ${key.last4 ?? "…"}${key.source === "env" ? " (from SOVA_JEV_KEY)" : ""}`;
  if (key.status === "error") return `${head} · couldn't check it${key.message ? `: ${key.message.replace(/\.$/, "")}` : ""}.`;
  if (key.status === "ok" && key.checkedAt !== undefined) return `${head} · checked ${ago(key.checkedAt, now)}.`;
  return `${head} · not checked yet.`;
}

/** "just now", "5m ago", "2h ago", "3d ago". */
function ago(t: number, now: number): string {
  const m = Math.floor(Math.max(0, now - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** "in 30 s", "in 2 min". */
function inTime(t: number, now: number): string {
  const s = Math.max(1, Math.round((t - now) / 1000));
  return s < 60 ? `in ${s} s` : `in ${Math.round(s / 60)} min`;
}

export type ChipTone = "success" | "warn" | "error" | undefined;

/**
 * Jev's chip, a word for its state as saved: Off, No key, Rejected, Out of credit, Paused (its
 * breaker is open), Working, or Not checked. `status` is the chain's entry for Jev, if it has one.
 */
export function jevChip(enabled: boolean, key: DecisionKeyInfo, status: DecisionProviderStatus | undefined, now = Date.now()): { word: string; tone: ChipTone; fact: string } {
  const fact = keyLine(key, now);
  if (!enabled) return { word: "Off", tone: undefined, fact: key.present ? fact : "No key stored." };
  if (!key.present) return { word: "No key", tone: undefined, fact };
  if (key.status === "rejected") return { word: "Rejected", tone: "error", fact };
  const skipped = status?.state === "skipped" && (status.until === undefined || status.until > now);
  if (skipped && status?.lastFailure?.failure === "quota") return { word: "Out of credit", tone: "error", fact: "Jev says this account is out of credit." };
  if (skipped) {
    const retry = status!.until !== undefined ? ` Trying again ${inTime(status!.until, now)}.` : "";
    return { word: "Paused", tone: "warn", fact: `${sentenceCase(failedPhrase("jev", status!.lastFailure?.failure ?? "unavailable"))}.${retry}` };
  }
  if (key.status === "ok") return { word: "Working", tone: "success", fact };
  if (key.status === "error") return { word: "Paused", tone: "warn", fact };
  return { word: "Not checked", tone: undefined, fact };
}

const sentenceCase = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

const WAS: Partial<Record<DecisionFailure, string>> = {
  unavailable: "couldn't be used",
  auth: "rejected the key",
  quota: "was out of credit",
  "rate-limit": "was rate-limited",
  overloaded: "was overloaded",
  timeout: "timed out",
  network: "was unreachable",
  "too-large": "was sent too much to read",
  "malformed-answer": "gave an unusable answer",
  server: "had a server error",
};

/** A provider's failure in plain words, never the raw id: "Jev was rate-limited", "haiku had no auth". */
export function failedPhrase(who: DecisionProviderId | string, failure: DecisionFailure): string {
  const name = who in PROVIDER ? PROVIDER[who as DecisionProviderId] : who;
  if (failure === "auth" && who !== "jev") return `${name} had no auth`;
  if (failure === "bad-request") return `${name} was asked a malformed question`;
  return `${name} ${WAS[failure] ?? "failed"}`;
}

const PROVIDER: Record<DecisionProviderId, string> = { jev: "Jev", pi: "pi", "claude-code": "Claude Code" };

/** Who answered: "Jev", else the model ("haiku"), else the backend. */
export const answeredBy = (id: DecisionProviderId, model?: string): string => (id === "jev" || !model ? PROVIDER[id] : model);

/** Seconds with one decimal: "0.4 s", "3.1 s". */
export const latency = (ms: number): string => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;

/** The Test button's result as one sentence. */
export function probeLine(r: DecisionProbeResult): string {
  if (!r.ok) {
    const what = r.provider && r.failure ? ` ${failedPhrase(r.provider, r.failure)}.` : "";
    return `No answer.${what}${r.message ? ` ${r.message.replace(/\.$/, "")}.` : ""}`;
  }
  const who = r.provider ? answeredBy(r.provider, r.model) : "the chain";
  const took = r.latencyMs !== undefined ? ` in ${latency(r.latencyMs)}` : "";
  if (r.fellBackFrom) return `Answered by ${who}${took}, after ${failedPhrase(r.fellBackFrom.provider, r.fellBackFrom.failure)}.`;
  return `Answered by ${who}${took}.`;
}

/** The saved chain as one line: who is asked, in order; or why nobody is. */
export function chainLine(saved: DecisionSettings, key: DecisionKeyInfo, chain: DecisionChainStatus, now = Date.now()): string {
  if (!chain.ready || chain.providers.length === 0)
    return saved.fallback === null ? unavailableLine(saved.jev.enabled, key) : (chain.reason ?? "Unavailable: nothing can answer right now. Nothing is checked.");
  const parts = chain.providers.map((p) =>
    p.state === "skipped" && (p.until === undefined || p.until > now) ? `${p.label} (paused${p.until !== undefined ? `, retrying ${inTime(p.until, now)}` : ""})` : p.label,
  );
  return `Asks ${parts.join(", then ")}.`;
}

/** The backfill's one line, or null before any run. */
export function backfillLine(p: TagsBackfillProgress | null | undefined): string | null {
  if (!p || (!p.running && p.finishedAt === undefined && p.startedAt === undefined)) return null;
  const failed = p.failed > 0 ? ` · ${p.failed} failed` : "";
  if (p.running) return p.total === 0 ? "Finding sessions to tag…" : `Tagged ${p.done} of ${p.total}${failed}.`;
  if (p.stoppedReason) {
    const why = p.stoppedReason.trim().replace(/\.$/, "");
    return `Stopped at ${p.done} of ${p.total}${failed}.${why && why.toLowerCase() !== "stopped" ? ` ${why}.` : ""}`;
  }
  if (p.total === 0) return p.scope === "all" ? "Every session is tagged." : "Every session from the last 30 days is tagged.";
  return `Tagged ${p.total} ${p.total === 1 ? "session" : "sessions"}${failed}. New sessions are tagged as they finish.`;
}

/** The later of two progress reports (the poll's and the feed's): the running one, else the one that finished last. */
export function newerProgress(a: TagsBackfillProgress | null | undefined, b: TagsBackfillProgress | null | undefined): TagsBackfillProgress | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const at = (p: TagsBackfillProgress) => Math.max(p.startedAt ?? 0, p.finishedAt ?? 0);
  if (at(a) !== at(b)) return at(a) > at(b) ? a : b;
  if (a.running !== b.running) return a.running ? b : a; // same run: the finished report is the later one
  return a.done >= b.done ? a : b;
}

/** Why the Tag buttons are disabled, or null. Judged on what is saved. */
export function backfillBlocked(chain: DecisionChainStatus): string | null {
  if (!chain.ready) return "Nothing can answer yet, so nothing can be tagged.";
  return null;
}

/** A suggestion button's label: "Use haiku (Claude Code)". A suggestion is only ever applied by its button. */
export const suggestionLabel = (s: WorkerChoice, backends: { id: string; label: string }[]): string =>
  `Use ${s.model} (${backends.find((b) => b.id === s.backend)?.label ?? s.backend})`;

/**
 * The server's suggestions this machine can run: listed by its backend with that effort and not
 * refused by the model policy. A backend that couldn't list its models keeps its suggestions (they
 * can't be checked, not proven wrong); none show while the lists are still loading.
 */
export function offeredSuggestions(suggestions: WorkerChoice[], options: DelegateOptions | undefined, failed = false): WorkerChoice[] {
  if (failed) return suggestions;
  if (!options) return [];
  return suggestions.filter((s) => {
    const models = options.backends.find((b) => b.id === s.backend)?.models;
    if (models === null) return true;
    const m = models?.find((x) => x.id === s.model);
    return !!m && m.efforts.includes(s.effort) && !m.denied;
  });
}
