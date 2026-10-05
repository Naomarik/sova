// Run: pnpm test -- server/harness/state-kinds.test.ts. The state kind registry (§app.harness/state): its
// list, pinned; and, for every kind a reader folds, the view's read against today's fold (imported where it
// is exported, else copied verbatim) on a seeded synthetic corpus (malformed records, abandoned branches, an
// id-less file, custom messages that share a state type) and on the golden corpus (golden/README.md:
// synthetic, faux, and the real sample when .agent/golden-real holds one). Each view is read three ways:
// over raw pi entries (`stateViewOf`), over the reader's HEntries (`stateView`), and over HEntries through
// `stateViewOf`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { recordedLogin } from "../../pi-config/extensions/claude-code/accounts.ts";
import { ALIGN_ENTRY_TYPE } from "../../pi-config/extensions/mode/align.ts";
import { restoreActive as restoreMode } from "../../pi-config/extensions/mode/state.ts";
import { restoreActive as restoreSandbox } from "../../pi-config/extensions/sandbox/state.ts";
import { FORK_CACHE_ENTRY, inheritedCacheKey } from "../../pi-config/extensions/subagents/fork/cache.ts";
import { restorePick } from "../../pi-config/extensions/subagents/subagent-profiles.ts";
import { WORKER_SESSION_ENTRY } from "../../pi-config/extensions/subagents/worker-mark.ts";
import { LEGACY_REGISTRY_ENTRY_TYPE } from "../../pi-config/extensions/subagents/worker-transcript.ts";
import { restoreActive as restoreWorktrees } from "../../pi-config/extensions/worktrees/state.ts";
import { BATON_ENTRY, BATON_HANDOFF_ENTRY, BATON_OFFER_ENTRY, BATON_SENT_ENTRY } from "../../shared/baton";
import type { StateKind, StateView } from "../../shared/harness";
import { clickWrote, GRANT_ENTRY, nextPermitId, normalizeGrant, normalizeRevoke, normalizeRule, normalizeUse, REVOKE_ENTRY, RULE_ENTRY, USE_ENTRY } from "../../shared/overseer-grants";
import { OVERSEER_ENTRY, OVERSEER_SENT_ENTRY } from "../../shared/protocol";
import { PROFILE_ENTRY, SESSION_SENT_ENTRY } from "../../shared/profiles";
import { PROJECT_OVERSEER_ENTRY } from "../../shared/project-overseer";
import { loadoutOnBranch, LOADOUT_ENTRY } from "../session-loadout";
import { profileOnBranch } from "../session-profile";
import { fixtureSets, REPO } from "./pi/golden/golden";
import { completionHeaderRef, entryFacts, WORKER_REGISTRY_TYPE, WORKER_SESSION_MARKER } from "../worker-sessions";
import { activeBranch, historyOf, parseLines, toHEntry, type Entry } from "./pi/reader";
import { stateViewOf } from "./pi/state";
import {
  ALIGN_DOC,
  BATON,
  BATON_DECISION,
  BATON_DONE,
  BATON_EFFECT_KINDS,
  BATON_HANDOFF,
  BATON_LEASE,
  BATON_OFFER,
  BATON_PROPOSAL,
  BATON_SENT,
  BATON_WRAPUP,
  CLAUDE_LOGIN,
  FANOUT_MEMBER,
  FORK_CACHE,
  GRANT,
  GRANT_USE,
  LOADOUT,
  MODE,
  OVERSEER,
  OVERSEER_DIALOG_ANSWER,
  OVERSEER_SENT,
  PROFILE,
  PROJECT_OVERSEER,
  REVOKE,
  REWIND,
  RULE,
  SANDBOX,
  SESSION_SENT,
  STATE_KINDS,
  SUBAGENT_PROFILE,
  WORKER_REGISTRY,
  WORKER_SESSION,
  WORKTREES,
} from "./state-kinds";
import { stateView } from "./state-view";

// ---- Today's folds that are not exported (copied, not imported) ------------------------------------

/** server/chat-manager.ts isFanoutMember, over sm.getEntries(). */
const isFanoutMemberRef = (all: readonly any[]) => all.some((e) => e.type === "custom" && e.customType === "sova-fanout-member");
/** server/chat-manager.ts isOverseerFile, its marker half (the id half is overseer-state.json's). */
const overseerMarkerRef = (all: readonly any[]) => all.some((e) => e.type === "custom" && e.customType === OVERSEER_ENTRY);
/** server/baton-loadout.ts isBatonMarked. */
const isBatonMarkedRef = (all: readonly any[]) => all.some((e) => e.type === "custom" && e.customType === BATON_ENTRY);
/** server/baton-loadout.ts hasEntry, over the held chat's getEntries(). */
const hasEntryRef = (all: readonly any[], key: string) => all.some((e: any) => e.type === "custom" && e.data?.key === key);
/** server/project-overseer.ts markerOf. */
function markerOfRef(all: readonly any[]) {
  const e = all.find((x) => x.type === "custom" && x.customType === PROJECT_OVERSEER_ENTRY);
  const d = e?.data;
  return d && typeof d.projectId === "string" ? { v: 1, projectId: d.projectId } : null;
}
/** server/claude-login-state.ts newestLoginEntry, before the view. */
function newestLoginRef(branch: readonly any[]) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    const d = e.data;
    if (e.type === "custom" && e.customType === "claude-login" && typeof d?.login === "string")
      return { login: d.login, ...(typeof d.label === "string" && d.label ? { label: d.label } : {}) };
  }
  return undefined;
}
/** server/project-overseer-store.ts readPoMarker, its check of one parsed line. */
const poLineRef = (e: any) =>
  e?.type === "custom" && e.customType === PROJECT_OVERSEER_ENTRY && typeof e.data?.projectId === "string" ? { v: 1, projectId: e.data.projectId } : null;
/** server/worker-sessions.ts entryFacts over one parsed line, before the view (with its contentText). */
function workerFactsRef(e: any): { self: boolean; refs: string[] } {
  const none = { self: false, refs: [] };
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  if (!e || typeof e !== "object") return none;
  if (e.type === "custom" && e.customType === "subagents-worker-session") return { self: true, refs: [] };
  if (e.type === "custom" && e.customType === "subagents-worker-registry") {
    const d = e.data;
    if (!d || typeof d !== "object") return none;
    return { self: false, refs: [d.backendSessionFile, d.backendSessionId].filter(nonEmpty).map((s) => s.trim()) };
  }
  if (e.type === "custom_message" && e.customType === "subagent-complete") {
    const c = e.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("") : "";
    const ref = completionHeaderRef(text);
    return { self: false, refs: ref ? [ref] : [] };
  }
  return none;
}
/** shared/overseer-grants.ts customOf. */
const customOfRef = (entry: any, type: string): unknown =>
  !entry || typeof entry !== "object" || Array.isArray(entry) || entry.type !== "custom" || entry.customType !== type ? undefined : entry.data;
/** server/insights.ts decodeRewind (its `str` and `isRec`). */
const strRef = (v: unknown) => (typeof v === "string" && v ? v : undefined);
function decodeRewindRef(e: { id: unknown; at?: unknown; data: unknown }) {
  const id = strRef(e.id);
  const timestamp = strRef(e.at);
  if (!id || !timestamp) return null;
  const data: any = e.data && typeof e.data === "object" && !Array.isArray(e.data) ? e.data : {};
  return { id, timestamp, targetId: strRef(data.targetId) ?? "", fromLeafId: strRef(data.fromLeafId) ?? "" };
}
/** The transcript's row checks (server/transcript.ts batonRow, overseerSentRow, sessionSentRow, alignRow's
    entry test, overseerAnswerRow): whether the row reads the record at all. */
const obj = (d: any) => !!d && typeof d === "object";
const s = (v: unknown) => (typeof v === "string" ? v : "");
const ROW_READS: Record<string, (d: any) => boolean> = {
  [BATON_SENT_ENTRY]: (d) => obj(d) && !!s(d.targetId) && !!s(d.by),
  [BATON_HANDOFF_ENTRY]: (d) => obj(d) && typeof d.n === "number",
  [BATON_OFFER_ENTRY]: (d) => obj(d) && typeof d.n === "number" && Array.isArray(d.to),
  "sova-baton-decision": obj,
  "sova-baton-done": obj,
  "sova-baton-lease": obj,
  "sova-baton-proposal": obj,
  "sova-baton-wrapup": obj,
  [OVERSEER_SENT_ENTRY]: (d) => !!d && typeof d.targetId === "string" && !!d.targetId,
  [SESSION_SENT_ENTRY]: (d) => !!d && typeof d.targetId === "string" && !!d.targetId && typeof d.from?.sessionId === "string",
  "sova-overseer-dialog-answer": obj,
  "align-doc": obj,
};

// ---- The synthetic corpus --------------------------------------------------------------------------

const ISO = "2026-01-01T00:00:00.000Z";
const grant = (id: string, extra: object = {}) => ({ v: 1, card: "c_1", option: "a", label: "Later", createdAt: ISO, message: "m1", id, sessions: [{ id: "s1", title: "S" }], at: ISO, until: "2999-01-01T00:00:00.000Z", ...extra });
const rule = (id: string, extra: object = {}) => ({ v: 1, card: "c_2", option: "b", label: "Always", createdAt: ISO, message: "m2", id, text: "do it", acts: ["sova_send"], sessions: "any", ...extra });
const tree = { path: "/w/t", branch: "b", base: "main", session: "s1", at: ISO, status: "active", how: "created" };

/** Each type's samples, well-formed and not. */
const SAMPLES: Record<string, unknown[]> = {
  "sova-rewind": [{ targetId: "aaaa0001", fromLeafId: "aaaa0002" }, { targetId: "aaaa0003" }, null, "x", { targetId: 5, fromLeafId: [] }],
  "sova-topic-delivered": [{ v: 1, targetId: "aaaa0001", topic: "t", batch: 1, items: [] }],
  "sova-fanout-member": [{ v: 1 }, null],
  [PROFILE_ENTRY]: [{ v: 1, profile: null }, { v: 1, profile: { id: "p1", label: "P" } }, { v: 2, profile: null }, { v: 1, profile: {} }, null, "x", { v: 1, profile: { id: "p2" }, by: "start" }],
  [LOADOUT_ENTRY]: [{ v: 1, offContext: ["/a"], offSkills: ["s"] }, { v: 1, offContext: ["rel"], offSkills: [] }, { v: 1, offContext: [], offSkills: [] }, { v: 1 }, null],
  [SESSION_SENT_ENTRY]: [{ v: 1, targetId: "aaaa0001", from: { sessionId: "s", title: "T" }, hop: 1 }, { v: 1, targetId: "", from: { sessionId: "s" } }, { v: 1, targetId: "aaaa0002" }],
  [OVERSEER_ENTRY]: [{ v: 1 }, null],
  [OVERSEER_SENT_ENTRY]: [{ v: 1, targetId: "aaaa0001" }, { v: 1, targetId: "aaaa0002", overseerId: "o" }, { v: 1, targetId: "" }, null],
  "sova-overseer-dialog-answer": [{ v: 1, title: "Q", answer: "A" }, null, 7],
  [GRANT_ENTRY]: [grant("g_1"), grant("g_2"), grant("g_7", { sessions: [] }), grant("g_3", { until: "nope" }), { id: "g_9" }, grant("g_1", { label: "dup" })],
  [RULE_ENTRY]: [rule("r_1"), rule("r_2", { sessions: [{ id: "s2", title: "T" }], from: "old" }), rule("r_5", { acts: ["nope"] }), { id: "r_8" }, rule("r_1", { text: "dup" })],
  [REVOKE_ENTRY]: [{ v: 1, id: "g_1", at: ISO, by: "user" }, { v: 1, id: "r_2", at: "2026-02-01T00:00:00.000Z" }, { v: 1, id: "g_1", at: "2026-03-01T00:00:00.000Z" }, { v: 1, id: "x_1", at: ISO }, null],
  [USE_ENTRY]: [{ v: 1, id: "g_1", tool: "sova_send", sessions: ["s1"], toolCallId: "t1", at: ISO }, { v: 1, id: "r_1", tool: "sova_send", sessions: [], toolCallId: "t2", at: ISO }, { v: 1, id: "g_2", tool: "", sessions: ["s"], toolCallId: "t", at: ISO }],
  [PROJECT_OVERSEER_ENTRY]: [{ v: 1, projectId: "p1" }, { v: 1, projectId: 4 }, { v: 1, projectId: "p2", extra: true }, null],
  [BATON_ENTRY]: [{ v: 1, orgId: "o", projectId: "p" }, null],
  [BATON_SENT_ENTRY]: [{ v: 1, targetId: "aaaa0001", by: "operator" }, { v: 1, targetId: "aaaa0002", by: "" }, { v: 1, targetId: "aaaa0001", by: "p1" }],
  [BATON_HANDOFF_ENTRY]: [{ v: 1, n: 1, from: "operator", to: "p1", question: "q", briefing: "", key: "k1" }, { v: 1, n: "2", key: "k2" }, { v: 1, n: 3, key: "k3" }],
  [BATON_OFFER_ENTRY]: [{ v: 1, n: 1, offerId: "o1", from: "operator", to: ["p1"], question: "q", briefing: "", key: "k4" }, { v: 1, n: 2, to: "p1", key: "k5" }],
  "sova-baton-lease": [{ v: 1, n: 1, offerId: "o1", event: "claimed", by: "p1", key: "k6" }, "x"],
  "sova-baton-decision": [{ v: 1, area: "a", statement: "s", quote: "q", by: "p1" }, null],
  "sova-baton-done": [{ v: 1, summary: "s", key: "k7" }, 3],
  "sova-baton-proposal": [{ v: 1, personId: "x", name: "N", role: "r", why: "w", by: "p1", key: "k8" }],
  "sova-baton-wrapup": [{ v: 1, phase: "start" }, { v: 1, phase: "end", applied: [], refused: [] }, null],
  mode: [{ mode: "delegate", active: { version: 1, mode: "delegate", strict: true, minorModes: [] } }, { mode: "normal", active: { version: 2, mode: "normal" } }, { mode: "nope", active: { version: 1, mode: "normal" } }, { delta: true }, [], null],
  "subagent-profile": [{ v: 1, profile: "off" }, { v: 1, profile: "team-a" }, { v: 1, profile: 5 }, { v: 2, profile: "off" }, null],
  "sova-fork-cache": [{ v: 1, key: "src-1" }, { v: 1, key: "" }, { v: 2, key: "k" }, [], { v: 1, key: "src-2" }],
  sandbox: [{ version: 1, on: true, level: "workspace-write", backend: "bwrap", enforcement: "full" }, { version: 1, on: false, level: "read-only", workers: "off" }, { version: 1, on: "yes", level: "read-only" }, null],
  worktrees: [{ version: 1, trees: [tree] }, { version: 1, trees: [] }, { version: 1, trees: [{ ...tree, path: "rel" }] }, { version: 2, trees: [] }],
  "claude-login": [{ v: 1, login: "a", label: "A" }, { v: 1, login: "b", from: "a", reason: "limit" }, { v: 1 }, { v: 1, login: 3 }],
  "align-doc": [{ doc: { title: "T", markdown: "m", questions: [] } }, null, "x"],
  "topic-outline": [{ v: 1 }],
  "subagents-worker-session": [{ v: 1 }, { v: 1, workerId: "ag_02", teamId: "team_01", role: "dev" }, null],
  "subagents-worker-registry": [{ v: 1, backendSessionFile: "/s/a.jsonl", backendSessionId: "id-1" }, { backendSessionId: " id-2 " }, { backendSessionFile: "/s/b.jsonl" }, { backendSessionFile: "" }, null, "x"],
};
const TYPES = Object.keys(SAMPLES);

/** A seeded PRNG (mulberry32), so the corpus is the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One synthetic session: a header, then messages, state records and custom messages of the registered types,
    usually chained on the one before and sometimes on an earlier entry (an abandoned branch), with an odd
    missing timestamp, duplicate id, or (`idless`) no ids at all. */
function synthetic(seed: number, idless: boolean): string {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const lines: object[] = [{ type: "session", version: 3, id: `0000000${seed}`, timestamp: ISO, cwd: "/w" }];
  const ids: string[] = [];
  const n = 20 + Math.floor(r() * 40);
  for (let i = 0; i < n; i++) {
    const id = r() < 0.03 && ids.length ? pick(ids) : `${seed.toString(16).padStart(4, "0")}${i.toString(16).padStart(4, "0")}`;
    const parentId = ids.length === 0 ? null : r() < 0.15 ? pick(ids) : ids[ids.length - 1]!;
    const base: Record<string, unknown> = idless ? {} : { id, parentId };
    if (r() > 0.05) base.timestamp = ISO;
    const roll = r();
    const type = pick(TYPES);
    if (roll < 0.25) lines.push({ type: "message", ...base, message: { role: pick(["user", "assistant"]), content: [{ type: "text", text: "hi" }] } });
    else if (roll < 0.3) lines.push({ type: "custom_message", ...base, customType: type, content: "note", display: false, details: pick(SAMPLES[type]!) });
    else if (roll < 0.32) lines.push({ type: "custom", ...base, data: { v: 1 } });
    else lines.push({ type: "custom", ...base, customType: type, data: pick(SAMPLES[type]!) });
    ids.push(id);
  }
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

// ---- The corpus ------------------------------------------------------------------------------------

interface Session {
  name: string;
  /** The file's entries, header left out (sm.getEntries()). */
  all: any[];
  /** The active branch, root first (sm.getBranch()). */
  branch: any[];
}

function sessionOf(name: string, text: string): Session {
  const raw = parseLines(text);
  return { name, all: raw.filter((e) => e.type !== "session"), branch: activeBranch(raw) };
}

const SYNTHETIC: Session[] = Array.from({ length: 60 }, (_, i) => sessionOf(`synthetic-${i + 1}`, synthetic(i + 1, i % 15 === 14)));
const GOLDEN: Session[] = fixtureSets().flatMap((set) =>
  set.fixtures.filter((f) => f.format === "pi").map((f) => sessionOf(`${set.name}/${set.private ? f.name.slice(0, 12) : f.name}`, readFileSync(f.path, "utf8"))),
);

/** The three ways to read the same entries. */
function viewsOf(entries: readonly Entry[]): [string, StateView][] {
  const h = historyOf(entries);
  return [
    ["raw", stateViewOf(entries)],
    ["hentry", stateView(h)],
    ["hentry via stateViewOf", stateViewOf(h)],
  ];
}

/** Every fold this file pins, as [name, today's value, the view's value] per way of reading. */
function compare(s: Session): void {
  const branchViews = viewsOf(s.branch);
  const fileViews = viewsOf(s.all);
  for (let w = 0; w < branchViews.length; w++) {
    const [way, b] = branchViews[w]!;
    const f = fileViews[w]![1];
    const at = (what: string) => `${s.name}: ${what} (${way})`;
    // newest-on-branch
    assert.deepEqual(b.latest(PROFILE)?.data ?? null, profileOnBranch(s.branch), at("profileOnBranch"));
    assert.deepEqual(b.latest(LOADOUT)?.data ?? null, loadoutOnBranch(s.branch), at("loadoutOnBranch"));
    assert.deepEqual(b.latest(SUBAGENT_PROFILE)?.data.profile, restorePick(s.branch), at("restorePick"));
    assert.deepEqual(b.latest(MODE)?.data.active, restoreMode(s.branch), at("mode restoreActive"));
    assert.deepEqual(b.latest(SANDBOX)?.data, restoreSandbox(s.branch), at("sandbox restoreActive"));
    assert.deepEqual(b.latest(WORKTREES)?.data, restoreWorktrees(s.branch), at("worktrees restoreActive"));
    assert.equal(b.latest(CLAUDE_LOGIN)?.data.login, recordedLogin(s.branch), at("recordedLogin"));
    const login = b.latest(CLAUDE_LOGIN)?.data;
    assert.deepEqual(login ? { login: login.login, ...(typeof login.label === "string" && login.label ? { label: login.label } : {}) } : undefined, newestLoginRef(s.branch), at("newestLoginEntry"));
    // file folds
    const cache = f.latest(FORK_CACHE)?.data.key;
    assert.equal(cache === undefined ? undefined : Array.from(cache).slice(0, 64).join(""), inheritedCacheKey(s.all), at("inheritedCacheKey"));
    assert.equal(f.has(FANOUT_MEMBER), isFanoutMemberRef(s.all), at("isFanoutMember"));
    assert.equal(f.has(OVERSEER), overseerMarkerRef(s.all), at("isOverseerFile marker"));
    assert.equal(f.has(BATON), isBatonMarkedRef(s.all), at("isBatonMarked"));
    assert.deepEqual(f.first(PROJECT_OVERSEER)?.data ?? null, markerOfRef(s.all), at("markerOf"));
    // approvals: grants and rules on the branch, revokes and uses over the file, as foldPermits reads each
    const norm = <T>(list: readonly Entry[], type: string, n: (v: unknown) => T | undefined) => list.map((e) => n(customOfRef(e, type))).filter((x) => x !== undefined);
    assert.deepEqual(b.list(GRANT).map((r) => r.data), norm(s.branch, GRANT_ENTRY, normalizeGrant), at("grants"));
    assert.deepEqual(b.list(RULE).map((r) => r.data), norm(s.branch, RULE_ENTRY, normalizeRule), at("rules"));
    assert.deepEqual(f.list(REVOKE).map((r) => r.data), norm(s.all, REVOKE_ENTRY, normalizeRevoke), at("revokes"));
    assert.deepEqual(f.list(GRANT_USE).map((r) => r.data), norm(s.all, USE_ENTRY, normalizeUse), at("grant uses"));
    // id allocation and the click check count what any record claims (written, malformed included)
    for (const kind of ["grant", "rule"] as const) {
      let max = 0;
      for (const r of f.written(kind === "grant" ? GRANT : RULE)) {
        const id = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? String((r.data as any).id) : "";
        if (id.startsWith(kind === "grant" ? "g_" : "r_")) max = Math.max(max, Number(id.slice(2)) || 0);
      }
      assert.equal(`${kind === "grant" ? "g_" : "r_"}${max + 1}`, nextPermitId(s.all, kind), at(`nextPermitId ${kind}`));
    }
    for (const message of ["m1", "m2", "m3"]) {
      const viaView = [...f.written(GRANT), ...f.written(RULE)].some((r) => !!r.data && typeof r.data === "object" && !Array.isArray(r.data) && (r.data as any).message === message);
      assert.equal(viaView, clickWrote(s.all, message), at(`clickWrote ${message}`));
    }
    // the baton statechart's key dedupe, for every key its effect records carry
    const keys = new Set(BATON_EFFECT_KINDS.flatMap((k) => f.written(k).map((r) => (r.data as any)?.key).filter((k) => typeof k === "string")));
    for (const key of keys) {
      const viaView = BATON_EFFECT_KINDS.some((k) => f.written(k).some((r) => (r.data as any)?.key === key));
      assert.equal(viaView, hasEntryRef(s.all, key), at(`hasEntry ${key}`));
    }
    // one entry at a time: the project overseer marker's line check and the worker-session scan's
    if (w === 0)
      for (const e of s.all) {
        const h = toHEntry(e);
        const one = h ? stateView([h]) : null;
        assert.deepEqual(one?.latest(PROJECT_OVERSEER)?.data ?? null, poLineRef(e), at("readPoMarker line"));
        assert.deepEqual(entryFacts(h), workerFactsRef(e), at("worker-session entryFacts"));
        assert.equal(one?.has(WORKER_SESSION) ?? false, workerFactsRef(e).self, at("worker-session marker"));
      }
    // insights' rewinds (on the branch)
    const rewinds = b.list(REWIND).map((r) => decodeRewindRef(r)).filter((x) => x !== null);
    const today = s.branch.filter((e) => e.type === "custom" && e.customType === REWIND.type).map((e) => decodeRewindRef({ id: e.id, at: e.timestamp, data: e.data })).filter((x) => x !== null);
    assert.deepEqual(rewinds, today, at("rewinds"));
    // the per-record kinds: the records the transcript's row reads, in order; byTarget = the newest of them
    const perRecord: StateKind<any>[] = [BATON_SENT, BATON_HANDOFF, BATON_OFFER, BATON_LEASE, BATON_DECISION, BATON_DONE, BATON_PROPOSAL, BATON_WRAPUP, OVERSEER_SENT, SESSION_SENT, OVERSEER_DIALOG_ANSWER, ALIGN_DOC];
    for (const kind of perRecord) {
      const reads = ROW_READS[kind.type]!;
      const todayRecords = s.branch.filter((e) => e.type === "custom" && e.customType === kind.type && reads(e.data));
      assert.deepEqual(b.list(kind).map((r) => r.id), todayRecords.map((e) => (typeof e.id === "string" ? e.id : null)), at(`${kind.type} records`));
      assert.ok(b.list(kind).every((r, i) => r.data === todayRecords[i]!.data), at(`${kind.type} data passed through`));
    }
    const targeted: StateKind<any>[] = [BATON_SENT, OVERSEER_SENT, SESSION_SENT];
    for (const kind of targeted) {
      for (const target of new Set(s.branch.map((e) => (e.data as any)?.targetId).filter((t) => typeof t === "string"))) {
        const todayNewest = s.branch.filter((e) => e.type === "custom" && e.customType === kind.type && ROW_READS[kind.type]!(e.data) && e.data.targetId === target).at(-1);
        assert.equal(b.byTarget(kind, target)?.data ?? null, todayNewest?.data ?? null, at(`${kind.type} byTarget`));
      }
    }
  }
}

describe("the state kind registry", () => {
  test("lists exactly these kinds, with their owners and folds", () => {
    const rows = [...STATE_KINDS.values()].map((k) => `${k.type} ${k.owner} ${k.fold}`).sort();
    assert.deepEqual(rows, [
      "align-doc extension:mode branch-list",
      "claude-login extension:claude-code newest-on-branch",
      "mode extension:mode newest-on-branch",
      "overseer-grant sova branch-list",
      "overseer-grant-use sova file-list",
      "overseer-revoke sova file-list",
      "overseer-rule sova branch-list",
      "sandbox extension:sandbox newest-on-branch",
      "sova-baton sova presence",
      "sova-baton-decision sova branch-list",
      "sova-baton-done sova branch-list",
      "sova-baton-handoff sova branch-list",
      "sova-baton-lease sova branch-list",
      "sova-baton-offer sova branch-list",
      "sova-baton-proposal sova branch-list",
      "sova-baton-sent sova branch-list",
      "sova-baton-wrapup sova branch-list",
      "sova-fanout-member sova presence",
      "sova-fork-cache extension:subagents file-list",
      "sova-loadout sova newest-on-branch",
      "sova-overseer sova presence",
      "sova-overseer-dialog-answer sova branch-list",
      "sova-overseer-sent sova branch-list",
      "sova-profile sova newest-on-branch",
      "sova-project-overseer sova marker",
      "sova-rewind sova branch-list",
      "sova-session-sent sova branch-list",
      "sova-topic-delivered sova write-only",
      "subagent-profile extension:subagents newest-on-branch",
      "subagents-worker-registry extension:subagents file-list",
      "subagents-worker-session extension:subagents presence",
      "worktrees extension:worktrees newest-on-branch",
    ]);
  });

  test("the types spelled again here are the writers' own", () => {
    const constant = (file: string, name: string) => {
      const m = new RegExp(`(?:export )?const ${name} = "([^"]+)"`).exec(readFileSync(join(REPO, file), "utf8"));
      assert.ok(m, `${file} declares ${name}`);
      return m![1];
    };
    assert.equal(REWIND.type, constant("server/chat-manager.ts", "REWIND_ENTRY"));
    assert.equal(REWIND.type, constant("server/insights.ts", "REWIND_ENTRY"));
    assert.equal(FANOUT_MEMBER.type, constant("server/chat-manager.ts", "FANOUT_MEMBER_ENTRY"));
    assert.equal(STATE_KINDS.get("sova-topic-delivered")?.type, constant("server/chat-manager.ts", "TOPIC_DELIVERED_ENTRY"));
    assert.equal(LOADOUT.type, LOADOUT_ENTRY);
    assert.equal(FORK_CACHE.type, FORK_CACHE_ENTRY);
    assert.equal(ALIGN_DOC.type, ALIGN_ENTRY_TYPE);
    assert.equal(WORKER_SESSION.type, WORKER_SESSION_ENTRY);
    assert.equal(WORKER_SESSION.type, WORKER_SESSION_MARKER);
    assert.equal(WORKER_REGISTRY.type, LEGACY_REGISTRY_ENTRY_TYPE);
    assert.equal(WORKER_REGISTRY.type, WORKER_REGISTRY_TYPE);
  });

  test("kinds are frozen", () => {
    for (const k of STATE_KINDS.values()) assert.ok(Object.isFrozen(k), k.type);
  });
});

describe("the view gives today's folds", () => {
  test("the synthetic corpus covers each kind well-formed and not", () => {
    const seen = new Map<string, { good: number; bad: number }>();
    for (const s of SYNTHETIC)
      for (const e of s.all) {
        const k = e.type === "custom" ? STATE_KINDS.get(e.customType) : undefined;
        if (!k) continue;
        const c = seen.get(k.type) ?? { good: 0, bad: 0 };
        if (k.parse(e.data) === null) c.bad++;
        else c.good++;
        seen.set(k.type, c);
      }
    for (const k of STATE_KINDS.values()) {
      assert.ok((seen.get(k.type)?.good ?? 0) > 0, `${k.type}: no well-formed sample`);
      if (SAMPLES[k.type]!.some((d) => k.parse(d) === null)) assert.ok((seen.get(k.type)?.bad ?? 0) > 0, `${k.type}: no malformed sample`);
    }
    assert.ok(SYNTHETIC.some((s) => s.branch.length < s.all.length), "an abandoned branch");
    assert.ok(SYNTHETIC.some((s) => s.all.some((e) => typeof e.id !== "string")), "an id-less file");
  });

  test("on the synthetic corpus", () => {
    for (const s of SYNTHETIC) compare(s);
  });

  test("on the golden corpus (the real sample when present)", () => {
    assert.ok(GOLDEN.length > 0);
    for (const s of GOLDEN) compare(s);
  });
});
