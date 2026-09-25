import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionChainStatus, DecisionKeyInfo, DecisionSettings } from "../../shared/protocol";
import { decisionDirty, decisionDraft, resetDecisionDraft, setDecisionDraft, setDecisionSaved } from "./decision-draft";
import {
  backfillBlocked,
  backfillLine,
  chainLine,
  failedPhrase,
  jevChip,
  keyAfterProbe,
  newerProgress,
  offeredSuggestions,
  decisionDraftComplete,
  draftOf,
  draftProviders,
  exclusionIssue,
  fallbackOn,
  keyInputIssue,
  keyLine,
  parseExclusions,
  probeLine,
  sameDecision,
  settingsOf,
  unansweredIssue,
} from "./decision-form";

const haiku = { backend: "claude-code" as const, model: "haiku", effort: "low" };
const defaults: DecisionSettings = {
  version: 1,
  jev: { enabled: true },
  fallback: null,
  features: { attention: false, tags: false },
  exclusions: [],
  neverSendTui: false,
};
const noKey: DecisionKeyInfo = { present: false, status: "absent" };
const goodKey: DecisionKeyInfo = { present: true, last4: "ab12", source: "file", status: "ok" };
const ready: DecisionChainStatus = { ready: true, providers: [{ id: "jev", label: "Jev", state: "ok" }] };

test("the draft round-trips: what loads is what saves, and loading changes nothing", () => {
  const s: DecisionSettings = { ...defaults, fallback: haiku, exclusions: ["~/work", "/srv/x"], neverSendTui: true };
  const d = draftOf(s);
  assert.equal(d.exclusions, "~/work\n/srv/x");
  assert.deepEqual(settingsOf(d), s);
  assert.ok(sameDecision(d, s));
  d.fallback!.model = "sonnet";
  assert.equal(s.fallback!.model, "haiku", "the draft is a copy, never the loaded object");
});

test("exclusions: blank lines, stray spaces and repeats don't make a draft dirty; each line must be a full path", () => {
  const s: DecisionSettings = { ...defaults, exclusions: ["~/work", "/srv/x"] };
  assert.ok(sameDecision({ ...draftOf(s), exclusions: "  ~/work\n\n/srv/x \n~/work\n" }, s));
  assert.ok(!sameDecision({ ...draftOf(s), exclusions: "/srv/x\n~/work" }, s), "order is kept, so a reorder is an edit");
  assert.deepEqual(parseExclusions(" a \n\n a\nb"), ["a", "b"]);
  assert.equal(exclusionIssue("~/work\n/srv\n~"), null);
  assert.match(exclusionIssue("~/work\nwork/client")!, /"work\/client" isn't a full path/);
  assert.match(exclusionIssue("~work")!, /~work/, "~user is not a home prefix");
  const many = (n: number) => Array.from({ length: n }, (_, i) => `/srv/${i}`).join("\n");
  assert.equal(exclusionIssue(many(100)), null);
  assert.equal(exclusionIssue(many(101)), "That's 101 folders. Use at most 100.");
});

test("complete: a half-chosen fallback or a bad exclusion holds Save", () => {
  assert.ok(decisionDraftComplete(draftOf(defaults)));
  assert.ok(!decisionDraftComplete({ ...draftOf(defaults), fallback: fallbackOn(true) }));
  assert.ok(!decisionDraftComplete({ ...draftOf(defaults), fallback: { ...haiku, effort: "" } }));
  assert.ok(decisionDraftComplete({ ...draftOf(defaults), fallback: haiku }));
  assert.ok(!decisionDraftComplete({ ...draftOf(defaults), exclusions: "relative" }));
});

test("the fallback switch picks no model", () => {
  assert.deepEqual(fallbackOn(true), { backend: "claude-code", model: "", effort: "" });
  assert.equal(fallbackOn(false), null);
});

test("who answers: Jev only when on with a key it hasn't rejected, then a chosen fallback; the switch and the key are independent", () => {
  const d = draftOf(defaults);
  assert.deepEqual(draftProviders(d, goodKey), ["jev"]);
  assert.deepEqual(draftProviders(d, noKey), []);
  assert.deepEqual(draftProviders(d, { ...goodKey, status: "rejected" }), []);
  assert.deepEqual(draftProviders(d, { ...goodKey, status: "error" }), ["jev"], "a failed check may be the network; the key is still tried");
  assert.deepEqual(draftProviders({ ...d, jev: { enabled: false } }, goodKey), [], "Jev off with a working key: Jev is not asked");
  assert.deepEqual(draftProviders({ ...d, jev: { enabled: false }, fallback: haiku }, goodKey), ["fallback"]);
  assert.deepEqual(draftProviders({ ...d, fallback: haiku }, goodKey), ["jev", "fallback"]);
  assert.deepEqual(draftProviders({ ...d, fallback: fallbackOn(true) }, noKey), [], "a fallback with no model yet answers nothing");
});

test("unanswered: a feature on with nobody to answer says which gap to fill; features off say nothing", () => {
  const d = draftOf(defaults);
  assert.equal(unansweredIssue(d, noKey), null, "both features off: nothing is sent, nothing to warn about");
  const on = { ...d, features: { attention: true, tags: false } };
  assert.equal(unansweredIssue(on, noKey), "Unavailable: Jev can't answer (no key) and no fallback model is set. Nothing is checked until one of them can.");
  assert.match(unansweredIssue(on, { ...goodKey, status: "rejected" })!, /\(key rejected\)/);
  assert.equal(unansweredIssue({ ...on, jev: { enabled: false } }, goodKey), "Unavailable: Jev is off and no fallback model is set. Nothing is checked.");
  assert.equal(unansweredIssue(on, goodKey), null);
  assert.equal(unansweredIssue({ ...on, jev: { enabled: false }, fallback: haiku }, noKey), null);
});

test("the key line shows the last 4 and when it was checked, and nothing a longer key could leak", () => {
  const now = 10 * 3_600_000;
  assert.equal(keyLine(noKey, now), "No key stored.");
  assert.equal(keyLine({ ...goodKey, checkedAt: now - 2 * 3_600_000 }, now), "Key ending ab12 · checked 2h ago.");
  assert.equal(keyLine({ ...goodKey, checkedAt: now - 10_000 }, now), "Key ending ab12 · checked just now.");
  assert.equal(keyLine({ ...goodKey, status: "unverified" }, now), "Key ending ab12 · not checked yet.");
  assert.equal(keyLine({ ...goodKey, source: "env", status: "unverified" }, now), "Key ending ab12 (from SOVA_JEV_KEY) · not checked yet.");
  assert.equal(keyLine({ ...goodKey, status: "rejected" }, now), "Jev rejected this key. Replace it, or turn Jev off.");
  assert.equal(keyLine({ ...goodKey, status: "error", message: "timed out." }, now), "Key ending ab12 · couldn't check it: timed out.");
});

test("Jev's chip: the switch and the key are independent, and a paused Jev says why and when", () => {
  const now = 1_000_000;
  assert.equal(jevChip(false, goodKey, undefined, now).word, "Off", "off with a working key is still Off");
  assert.equal(jevChip(true, noKey, undefined, now).word, "No key");
  assert.deepEqual(jevChip(true, { ...goodKey, status: "rejected" }, undefined, now).tone, "error");
  assert.equal(jevChip(true, { ...goodKey, checkedAt: now }, { id: "jev", label: "Jev", state: "ok" }, now).word, "Working");
  assert.equal(jevChip(true, { ...goodKey, status: "unverified" }, undefined, now).word, "Not checked");
  const quota = jevChip(true, goodKey, { id: "jev", label: "Jev", state: "skipped", until: now + 60_000, lastFailure: { failure: "quota", message: "", at: now } }, now);
  assert.deepEqual([quota.word, quota.tone], ["Out of credit", "error"]);
  const paused = jevChip(true, goodKey, { id: "jev", label: "Jev", state: "skipped", until: now + 30_000, lastFailure: { failure: "rate-limit", message: "", at: now } }, now);
  assert.deepEqual([paused.word, paused.fact], ["Paused", "Jev was rate-limited. Trying again in 30 s."]);
  const expired = jevChip(true, { ...goodKey, checkedAt: now }, { id: "jev", label: "Jev", state: "skipped", until: now - 1 }, now);
  assert.equal(expired.word, "Working", "a breaker whose time has passed no longer pauses it");
});

test("key input: trimmed, no spaces, a plausible length", () => {
  assert.equal(keyInputIssue("  "), "Paste a key.");
  assert.equal(keyInputIssue("ts_" + "x".repeat(30) + " y"), "A key has no spaces.");
  assert.match(keyInputIssue("short")!, /doesn't look like/);
  assert.equal(keyInputIssue(`  ts_${"x".repeat(30)}\n`), null, "surrounding whitespace from a paste is fine");
});

test("failures read as plain words, never the raw id", () => {
  const ids = ["unavailable", "auth", "quota", "rate-limit", "overloaded", "timeout", "network", "too-large", "bad-request", "malformed-answer", "server"] as const;
  const phrases = ids.map((f) => failedPhrase("jev", f));
  assert.equal(new Set(phrases).size, ids.length, "every failure has its own words");
  for (const [i, phrase] of phrases.entries()) {
    assert.ok(phrase.startsWith("Jev "), phrase);
    assert.ok(!phrase.endsWith(" failed"), `"${phrase}" is the catch-all`);
    assert.ok(!new RegExp(`${ids[i]}(?![a-z])`).test(phrase) || !ids[i]!.includes("-"), `"${phrase}" shows the raw id ${ids[i]}`);
  }
  assert.equal(failedPhrase("jev", "auth"), "Jev rejected the key");
  assert.equal(failedPhrase("haiku", "auth"), "haiku had no auth");
});

test("the probe line names who answered, how fast, and who fell back", () => {
  assert.equal(probeLine({ ok: true, provider: "jev", latencyMs: 912, chain: ready }), "Answered by Jev in 0.9 s.");
  assert.equal(
    probeLine({ ok: true, provider: "claude-code", model: "haiku", latencyMs: 4140, fellBackFrom: { provider: "jev", failure: "rate-limit", message: "429" }, chain: ready }),
    "Answered by haiku in 4.1 s, after Jev was rate-limited.",
  );
  assert.equal(probeLine({ ok: false, provider: "jev", failure: "timeout", message: "No answer in 8 s.", chain: ready }), "No answer. Jev timed out. No answer in 8 s.");
  assert.equal(probeLine({ ok: false, failure: "unavailable", message: "Nothing can answer.", chain: ready }), "No answer. Nothing can answer.");
});

test("the chain line: in order, paused providers marked, and the unavailable sentence when nobody can answer", () => {
  assert.equal(chainLine(defaults, goodKey, ready), "Asks Jev.");
  assert.equal(
    chainLine(
      { ...defaults, fallback: haiku },
      goodKey,
      { ready: true, providers: [{ id: "jev", label: "Jev", state: "skipped", until: 31_000 }, { id: "claude-code", label: "Claude Code · haiku", state: "ok" }] },
      1000,
    ),
    "Asks Jev (paused, retrying in 30 s), then Claude Code · haiku.",
  );
  assert.equal(chainLine({ ...defaults, jev: { enabled: false } }, goodKey, { ready: false, providers: [] }), "Unavailable: Jev is off and no fallback model is set. Nothing is checked.");
  assert.equal(chainLine({ ...defaults, fallback: haiku }, noKey, { ready: false, providers: [], reason: "Model policy denies haiku." }), "Model policy denies haiku.", "with a fallback set, the server's reason");
});

test("backfill: held while the edit is unsaved or nobody can answer; its line counts; the newer report wins", () => {
  assert.match(backfillBlocked(true, ready)!, /Save your changes/);
  assert.match(backfillBlocked(false, { ready: false, providers: [] })!, /Nothing can answer/);
  assert.equal(backfillBlocked(false, ready), null);
  assert.equal(backfillLine(undefined), null);
  assert.equal(backfillLine({ running: false, done: 0, total: 0, failed: 0 }), null, "never run: no line");
  assert.equal(backfillLine({ running: true, done: 40, total: 147, failed: 2, startedAt: 1 }), "Tagged 40 of 147 · 2 failed.");
  assert.equal(backfillLine({ running: true, done: 0, total: 0, failed: 0, startedAt: 1 }), "Finding sessions to tag…", "the first push, before the list is read");
  assert.equal(backfillLine({ running: false, done: 147, total: 147, failed: 2, startedAt: 1, finishedAt: 5 }), "Tagged 147 sessions · 2 failed. New sessions are tagged as they finish.");
  assert.equal(backfillLine({ running: false, scope: "recent", done: 0, total: 0, failed: 0, startedAt: 1, finishedAt: 2 }), "Every session from the last 30 days is tagged.");
  assert.equal(backfillLine({ running: false, done: 10, total: 147, failed: 0, startedAt: 1, finishedAt: 5, stoppedReason: "Stopped." }), "Stopped at 10 of 147.", "a cancel doesn't say it twice");
  assert.equal(backfillLine({ running: false, done: 10, total: 147, failed: 5, startedAt: 1, finishedAt: 5, stoppedReason: "5 failures in a row." }), "Stopped at 10 of 147 · 5 failed. 5 failures in a row.");
  const running = { running: true, done: 10, total: 40, failed: 0, startedAt: 100 };
  const finished = { running: false, done: 40, total: 40, failed: 0, startedAt: 100, finishedAt: 200 };
  assert.equal(newerProgress(running, finished), finished);
  assert.equal(newerProgress(finished, running), finished, "a late poll of the same run can't bring back 'running'");
  assert.equal(newerProgress({ ...running, done: 20 }, running)?.done, 20);
  const next = { running: true, done: 1, total: 40, failed: 0, startedAt: 300 };
  assert.equal(newerProgress(finished, next), next, "a new run is newer than the last one's finish");
  assert.equal(newerProgress(null, null), null);
});

test("the draft outlives a tab switch until the dialog resets it, and a reload never overwrites it", () => {
  resetDecisionDraft();
  assert.equal(decisionDirty(), false);
  setDecisionSaved(defaults);
  assert.equal(decisionDirty(), false, "a first load seeds the draft");
  setDecisionDraft({ ...decisionDraft()!, features: { attention: true, tags: false } });
  assert.equal(decisionDirty(), true);
  setDecisionSaved(defaults);
  assert.equal(decisionDraft()!.features.attention, true, "a reload keeps the unsaved edit");
  setDecisionSaved({ ...defaults, features: { attention: true, tags: false } }, { replaceDraft: true });
  assert.equal(decisionDirty(), false, "a save replaces the draft with what was stored");
  resetDecisionDraft();
  assert.equal(decisionDraft(), null);
});

test("suggestions: only what this machine offers; an unlisted backend keeps them; none while loading", () => {
  const ollama = { backend: "pi" as const, model: "ollama-cloud/deepseek-v4.1-flash", effort: "off" };
  const options = (piModels: { id: string; efforts: string[]; denied?: string }[] | null) => ({
    backends: [
      { id: "pi" as const, label: "pi", models: piModels },
      { id: "claude-code" as const, label: "Claude Code", models: [{ id: "haiku", efforts: ["low", "medium"] }] },
    ],
  });
  const both = [haiku, ollama];
  assert.deepEqual(offeredSuggestions(both, undefined), [], "still loading: offer nothing yet");
  assert.deepEqual(offeredSuggestions(both, options([]) as never), [haiku], "pi has no auth for ollama here");
  assert.deepEqual(offeredSuggestions(both, options([{ id: ollama.model, efforts: ["off"] }]) as never), both);
  assert.deepEqual(offeredSuggestions(both, options([{ id: ollama.model, efforts: ["low"] }]) as never), [haiku], "listed, but not with that effort");
  assert.deepEqual(offeredSuggestions(both, options([{ id: ollama.model, efforts: ["off"], denied: "Off by policy" }]) as never), [haiku]);
  assert.deepEqual(offeredSuggestions(both, options(null) as never), both, "pi couldn't list: unverifiable, not wrong");
  assert.deepEqual(offeredSuggestions(both, undefined, true), both, "discovery failed: show them all");
});

test("a Test Decisions result updates what the screen says about the key (e2e D4)", () => {
  const now = 5_000_000;
  const unchecked: DecisionKeyInfo = { present: true, last4: "ed0d", source: "env", status: "unverified" };
  const byJev = keyAfterProbe(unchecked, { ok: true, provider: "jev", latencyMs: 1000, chain: ready }, now);
  assert.deepEqual(byJev, { ...unchecked, status: "ok", checkedAt: now, message: undefined });
  assert.equal(jevChip(true, byJev, undefined, now).word, "Working", "the badge no longer says Not checked");
  assert.equal(keyLine(byJev, now), "Key ending ed0d (from SOVA_JEV_KEY) · checked just now.");
  const errored: DecisionKeyInfo = { ...unchecked, status: "error", message: "Jev did not answer in time" };
  assert.equal(keyAfterProbe(errored, { ok: true, provider: "jev", chain: ready }, now).message, undefined, "an old failure note goes with the old status");
  const fellBack = { ok: true, provider: "claude-code" as const, model: "haiku", chain: ready };
  assert.equal(keyAfterProbe(unchecked, { ...fellBack, fellBackFrom: { provider: "jev", failure: "auth", message: "401" } }, now).status, "rejected");
  assert.equal(keyAfterProbe(unchecked, { ok: false, provider: "jev", failure: "auth", message: "401", chain: ready }, now).status, "rejected");
  assert.equal(keyAfterProbe(unchecked, { ...fellBack, fellBackFrom: { provider: "jev", failure: "rate-limit", message: "429" } }, now), unchecked, "rate-limited says nothing about the key");
  assert.equal(keyAfterProbe(unchecked, fellBack, now), unchecked, "Jev not asked (off): the key is untouched");
  assert.equal(keyAfterProbe(noKey, { ok: true, provider: "jev", chain: ready }, now), noKey, "no key: nothing to mark working");
});
