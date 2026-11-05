// Run: pnpm test -- server/settings-limits-parity.test.ts
// Settings' forms check each server limit before Save (§app.settings-dialog/save-bar: a value the
// server would refuse is red and Save waits; one it takes is never red). For every numeric or length
// limit a settings route enforces, both sides of it go to both checks: the form's own validator (the
// pure function its draft store asks) and the route's strict parse (a PUT on the real app, in-process,
// throwaway PI_CODING_AGENT_DIR). Each must take the value at the limit and refuse the one past it,
// so the two agree. A form that lets through what the server refuses (Overseer limits up to 1000 vs a
// server max of 500, D1) or refuses what the server takes fails here, naming the limit.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { readdirSync } from "node:fs";
import type { Rule } from "../shared/form-rules";
import { scratchRoot } from "./test-scratch";

const agentDir = scratchRoot("sova-settings-parity-");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
// No program but git in the unit tier: with no `claude` on PATH a claude-code pick's version check
// answers without a spawn, and the drift list is primed empty (as src/lib/settings-forms-roundtrip.test.ts).
process.env.PATH = (process.env.PATH ?? "").split(":").filter((d) => !existsSync(join(d, "claude"))).join(":");
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const { cachedClaudeModels } = await import("./delegate");
const primeClaude = () => cachedClaudeModels(async () => []);

const overseer = await import("../src/lib/overseer-draft");
const providerLimits = await import("../src/lib/provider-limits");
const baton = await import("../src/lib/baton-settings-draft");
const titles = await import("../src/lib/session-title-settings-form");
const profiles = await import("../src/lib/subagent-profiles-draft");
const decisionForm = await import("../src/lib/decision-form");
const decision = await import("../src/lib/decision-draft");
const push = await import("../src/lib/push-draft");
const links = await import("../src/lib/public-links");
const meshDraft = await import("../src/lib/mesh-draft");
const { MB } = await import("../shared/baton");

type Json = any;
async function get(url: string): Promise<Json> {
  const res = await app.request(url);
  assert.equal(res.status, 200, `GET ${url}`);
  return res.json();
}
/** The route's verdict: taken (2xx) or refused (4xx, with its words). Never a 5xx. */
async function putStatus(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  await primeClaude();
  const res = await app.request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.ok(res.status < 500, `PUT ${url} answered ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return res.ok ? { ok: true } : { ok: false, error: json.error };
}

interface Limit {
  name: string;
  /** The shared rule both sides read (shared/*-limits.ts): its edges are the values below, and the
      server refuses in the rule's own words. */
  rule?: Rule;
  /** No rule, but the server still refuses in the form's sentence. */
  sameWords?: boolean;
  /** Values at the limit (taken) and past it (refused). `v` is what the user types or the list they build. */
  takes: unknown[];
  refuses: unknown[];
  /** The form's check: its problem sentence, or null. */
  client(v: unknown): string | null | Promise<string | null>;
  server(v: unknown): Promise<{ ok: boolean; error?: string }>;
  known?: string;
}

const long = (n: number) => "x".repeat(n);
const limits = await import("../shared/overseer-limits");
const batonLimits = await import("../shared/baton-limits");
const titleLimits = await import("../shared/session-title-limits");
const decisionLimits = await import("../shared/decision-limits");
const { firstIssue } = await import("../shared/form-rules");
/** A rule's edges: the values at it (taken) and just past it (refused). */
function ruled(rule: Rule): Pick<Limit, "name" | "rule" | "takes" | "refuses"> {
  if (rule.kind === "whole") return { name: `${rule.label} (${rule.min} to ${rule.max}, whole)`, rule, takes: [rule.min, rule.max], refuses: [rule.min - 1, rule.max + 1, rule.min + 0.5] };
  if (rule.kind === "text") {
    const min = rule.min ?? 0;
    return { name: `${rule.label} (${min} to ${rule.max} characters)`, rule, takes: [long(Math.max(min, 1)), long(rule.max), ...(min ? [] : [""])], refuses: [long(rule.max + 1), ...(min ? [""] : [])] };
  }
  throw new Error(`no edges for a ${rule.kind} rule (${rule.label}): give takes and refuses`);
}
const fresh = { mesh: await get("/api/mesh/settings"), overseer: await get("/api/settings/overseer"), baton: await get("/api/baton/settings"), titles: await get("/api/settings/session-titles"), subagents: await get("/api/settings/subagents"), decisions: await get("/api/settings/decisions"), push: await get("/api/push"), links: await get("/api/public-links") };
const subLimits = await import("../shared/subagent-limits");
const teamSeed = (await get("/api/settings/team")).defaults;
/** Subagents profile 0 with its teams on (on Claude Code picks, which this process can verify), edited by `edit`. */
const subProfile = (edit: (p: Json) => void): Json => {
  const p: Json = JSON.parse(JSON.stringify(fresh.subagents.settings.profiles[0]));
  const claude = { primary: { backend: "claude-code", model: "claude-sonnet-5-5", effort: "low" }, fallback: null };
  p.teams = JSON.parse(JSON.stringify({ coordinator: { ...teamSeed.coordinator, ...claude }, monitor: { ...teamSeed.monitor, ...claude, role: "monitor" }, handover: teamSeed.handover }));
  edit(p);
  return p;
};
const subClient = (edit: (p: Json) => void) => firstIssue(profiles.profilesFields({ version: 1, default: fresh.subagents.default, profiles: [subProfile(edit)] }))?.message ?? null;
const subServer = (edit: (p: Json) => void) => putStatus("/api/settings/subagents", { version: 1, profiles: [subProfile(edit)] });
const ovSettings = (): Json => JSON.parse(JSON.stringify(fresh.overseer.settings));
/** The Overseer's form check over settings `s` (its boxes hold text, as the form keeps them). */
const ovClient = (s: Json, notes = "") => overseer.overseerDraftProblem(overseer.toOverseerForm({ settings: s, notes }));
const ovServer = (s: Json) => putStatus("/api/settings/overseer", s);
const withAction = (patch: Json) => {
  const s = ovSettings();
  s.quickActions[0] = { ...s.quickActions[0], ...patch };
  return s;
};
const withActions = (n: number) => {
  const s = ovSettings();
  s.quickActions = Array.from({ length: n }, (_, i) => s.quickActions[i] ?? { id: `custom-${i}`, label: `Action ${i}`, description: "", prompt: "Go." });
  return s;
};

const LIMITS: Limit[] = [
  ...overseer.CAP_KEYS.map(
    (k): Limit => ({
      ...ruled(limits.CAP_RULES[k]),
      // The box holds what was typed: the text of the number.
      client: (v) => ovClient({ ...ovSettings(), caps: { ...ovSettings().caps, [k]: v } }),
      server: (v) => ovServer({ ...ovSettings(), caps: { ...ovSettings().caps, [k]: v } }),
    }),
  ),
  ...(["label", "description", "prompt"] as const).map(
    (k): Limit => ({ ...ruled(limits.QA_RULES[k]), client: (v) => ovClient(withAction({ [k]: v })), server: (v) => ovServer(withAction({ [k]: v })) }),
  ),
  { name: "Overseer quick actions (at most 12)", sameWords: true, takes: [1, 12], refuses: [13], client: (v) => ovClient(withActions(v as number)), server: (v) => ovServer(withActions(v as number)) },
  { ...ruled(limits.EXTRA_PROMPT_RULE), client: (v) => ovClient({ ...ovSettings(), extraSystemPrompt: v }), server: (v) => ovServer({ ...ovSettings(), extraSystemPrompt: v }) },
  {
    ...ruled(limits.NOTES_RULE),
    client: (v) => ovClient(ovSettings(), v as string),
    server: async (v) => putStatus("/api/overseer/notes", { text: v, base: (await get("/api/overseer/notes")).text }),
  },
  {
    name: "Request limits At once (1 to 999, whole)",
    takes: [1, 999],
    refuses: [0, 1000, 1.5],
    client: (v) => providerLimits.limitsProblem({ zai: String(v) }),
    server: (v) => putStatus("/api/settings/provider-limits", { limits: { zai: v } }),
  },
  ...(["messagesMax", "perMessage", "mb", "perConversation", "fileMb"] as const).map((key): Limit => {
    const { assistant: _, ...file } = fresh.baton;
    const draft = baton.batonDraftOf(file);
    const put = (v: number) =>
      key === "messagesMax" ? { ...file, messagesMax: v } : key === "fileMb" ? { ...file, files: { maxBytes: v * MB } } : { ...file, photos: { ...file.photos, [key === "mb" ? "maxBytes" : key]: key === "mb" ? v * MB : v } };
    return {
      ...ruled(batonLimits.BATON_RULES[key]),
      client: (v) => firstIssue(baton.batonFields({ ...draft, [key]: String(v) }))?.message ?? null,
      // The PUT body as baton-settings-draft.ts sends it: no `assistant` (its own route).
      server: (v) => putStatus("/api/baton/settings", put(v as number)),
    };
  }),
  ...(["intervalMinutes", "quietMinutes"] as const).map(
    (key): Limit => ({
      ...ruled(titleLimits.TITLE_RULES[key]),
      client: (v) => titles.titleDraftProblem({ ...titles.toTitleDraft(fresh.titles.settings), [key]: String(v) }),
      server: (v) => putStatus("/api/settings/session-titles", { ...fresh.titles.settings, [key]: v }),
    }),
  ),
  {
    ...ruled(subLimits.PROFILE_NAME_RULE),
    client: (v) => subClient((p) => (p.name = v)),
    server: (v) => subServer((p) => (p.name = v)),
  },
  ...([["coordinator", "Coordinator"], ["monitor", "Monitor"]] as const).flatMap(([r, name]) => [
    { ...ruled(subLimits.ROLE_RULE), name: `${name} role name`, refuses: [long(65), ""], client: (v: unknown) => subClient((p) => (p.teams[r].role = v)), server: (v: unknown) => subServer((p) => (p.teams[r].role = v)) },
    { ...ruled(subLimits.INSTRUCTIONS_RULE), name: `${name} instructions`, client: (v: unknown) => subClient((p) => (p.teams[r].instructions = v)), server: (v: unknown) => subServer((p) => (p.teams[r].instructions = v)) },
  ]),
  ...(Object.keys(subLimits.TEAM_RULES) as (keyof typeof subLimits.TEAM_RULES)[]).map((f) => {
    const set = (v: unknown) => (p: Json) => {
      const path = subLimits.TEAM_NUMBERS[f].path;
      path.slice(0, -1).reduce((o: Json, k) => o[k], p.teams)[path.at(-1)!] = v;
    };
    return { ...ruled(subLimits.TEAM_RULES[f]), client: (v: unknown) => subClient(set(typeof v === "number" ? String(v) : v)), server: (v: unknown) => subServer(set(v)) };
  }),
  {
    name: `Decisions excluded folders (at most ${decisionForm.MAX_EXCLUSIONS})`,
    rule: decisionLimits.EXCLUSIONS_RULE,
    takes: [1, decisionForm.MAX_EXCLUSIONS],
    refuses: [decisionForm.MAX_EXCLUSIONS + 1],
    client: (v) => {
      const list = Array.from({ length: v as number }, (_, i) => `/srv/p${i}`);
      return decision.decisionDraftProblem({ ...decisionForm.draftOf(fresh.decisions.settings), exclusions: list.join("\n") });
    },
    server: (v) => putStatus("/api/settings/decisions", { ...fresh.decisions.settings, exclusions: Array.from({ length: v as number }, (_, i) => `/srv/p${i}`) }),
  },
  {
    name: "Phone Notifications quiet hours start (HH:MM, 00:00 to 23:59)",
    takes: ["00:00", "23:59"],
    refuses: ["24:00", "23:60", "7:00"],
    client: (v) => push.pushDraftProblem({ ...push.toPushDraft(fresh.push.settings), quietHours: { enabled: true, start: v as string, end: "06:00" } }),
    server: (v) => putStatus("/api/push/settings", { ...fresh.push.settings, quietHours: { enabled: true, start: v, end: "06:00" } }),
  },
  {
    name: "Public links share port (1 to 65535)",
    takes: [1, 65535],
    refuses: [0, 65536],
    client: (v) => links.draftIssue({ ...links.publicLinksDraftOf(fresh.links.file), route: "self", publicUrl: "https://share.example.com", sharePort: String(v) })?.text ?? null,
    server: (v) => putStatus("/api/public-links", { route: "self", gateway: { publicUrl: "https://share.example.com", front: "vhost", sharePort: v, acceptFrom: "all" } }),
  },
  {
    name: "Mesh host name (1 to 80 characters)",
    takes: ["a", "n".repeat(80)],
    refuses: ["", "   ", "n".repeat(81)],
    client: (v) => meshDraft.meshDraftIssue({ ...meshDraft.meshDraftOf(fresh.mesh), hostLabel: v as string }),
    server: (v) => putStatus("/api/mesh/settings", { hostLabel: v }),
  },
  {
    name: "Mesh front door (a scheme, host and port only)",
    takes: ["", "https://sova.example.ts.net", "http://10.0.0.1:4800"],
    refuses: ["not a url", "ftp://x.example.com", "https://x.example.com/path"],
    client: (v) => meshDraft.meshDraftIssue({ ...meshDraft.meshDraftOf(fresh.mesh), frontDoor: v as string }),
    server: (v) => putStatus("/api/mesh/settings", { frontDoor: v === "" ? null : v }),
  },
];

describe("each settings limit: the form and the server agree on both sides of it", () => {
  for (const limit of LIMITS) {
    test(limit.name, { todo: limit.known }, async () => {
      const shown = (v: unknown) => (typeof v === "string" && v.length > 12 ? `${v.length} characters` : JSON.stringify(v));
      for (const v of limit.takes) {
        assert.equal(await limit.client(v), null, `${limit.name}: the form refuses ${shown(v)}, a value at the limit`);
        const s = await limit.server(v);
        assert.ok(s.ok, `${limit.name}: the server refuses ${shown(v)}, a value at the limit: ${s.error}`);
      }
      for (const v of limit.refuses) {
        const said = await limit.client(v);
        assert.notEqual(said, null, `${limit.name}: the form takes ${shown(v)}, past the limit (it would fail only at Save)`);
        const s = await limit.server(v);
        assert.ok(!s.ok, `${limit.name}: the server takes ${shown(v)}, past the limit`);
        if (limit.rule || limit.sameWords) assert.equal(s.error, said, `${limit.name}: the server refuses ${shown(v)} in other words than the form`);
      }
    });
  }
  test("every rule in a shared limits table (shared/*-limits.ts) has a row above", async () => {
    const tested = new Set(LIMITS.map((l) => l.rule));
    const rulesIn = (v: unknown): Rule[] =>
      v && typeof v === "object" ? ("kind" in v && "label" in v ? [v as Rule] : Object.values(v).flatMap(rulesIn)) : [];
    for (const file of readdirSync(join(import.meta.dirname, "../shared")).filter((f) => f.endsWith("-limits.ts"))) {
      for (const rule of rulesIn(await import(`../shared/${file}`))) assert.ok(tested.has(rule), `${file}: "${rule.label}" has no row in LIMITS`);
    }
  });
  test("MCP Servers: the Add form's secret-name rule is the route's (D12)", async () => {
    const { secretNameIssue } = await import("../src/lib/mcp");
    const { isSecretName } = await import("./mcp/values");
    for (const n of ["API_KEY", "_x", "a1", "A", "bad-name x", "1KEY", "a.b", "KEY ", "é", "A_B_C9"]) {
      assert.equal(secretNameIssue(n.trim()) === null, isSecretName(n.trim()), `"${n}": the form and the route disagree`);
    }
  });
  test("Merge Queue: a time limit box's whole minutes are the project file's seconds the save takes, and its cap is the server's (D13)", async () => {
    const mq = await import("../src/lib/merge-queue-settings");
    const { check } = await import("../shared/form-rules");
    const typed = (t: string) => {
      const r = check(mq.minutesRule(cap), t);
      return r.ok ? r.value : null;
    };
    const { parseChange } = await import("./merge-queue/settings-edit");
    const { HOOK_TIMEOUT_MAX } = await import("../shared/project-contract");
    const cap = Math.round(HOOK_TIMEOUT_MAX / 60);
    const server = (sec: number) => {
      try {
        parseChange({ checks: { unit: { timeoutSec: sec } } });
        return true;
      } catch {
        return false;
      }
    };
    for (const m of [1, cap]) {
      assert.equal(typed(String(m)), m, `the form refuses ${m} minutes`);
      assert.equal(server(m * 60), true, `the save refuses ${m} minutes`);
    }
    for (const m of [0, cap + 1]) {
      assert.equal(typed(String(m)), null, `the form takes ${m} minutes`);
      assert.equal(server(m * 60), false, `the save takes ${m} minutes`);
    }
    for (const t of ["", "-", "1e", "1.", "2.5", "-3", "a5", " ", "99999"]) assert.equal(typed(t), null, `the form takes "${t}"`);
  });
  test("a refusal names the field in words, never an internal key (D1's 'caps.concurrentSessions')", async () => {
    const s = ovSettings();
    s.caps.concurrentSessions = 1001;
    const r = await ovServer(s);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error ?? "", /caps\.|quickActions\[|extraSystemPrompt/, r.error);
  });
});
