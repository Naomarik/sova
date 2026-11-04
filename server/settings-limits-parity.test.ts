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
const store = await import("./overseer-store");
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
  /** Values at the limit (taken) and past it (refused). `v` is what the user types or the list they build. */
  takes: unknown[];
  refuses: unknown[];
  /** The form's check: its problem sentence, or null. */
  client(v: unknown): string | null | Promise<string | null>;
  server(v: unknown): Promise<{ ok: boolean; error?: string }>;
  known?: string;
}

const long = (n: number) => "x".repeat(n);
const fresh = { mesh: await get("/api/mesh/settings"), overseer: await get("/api/settings/overseer"), baton: await get("/api/baton/settings"), titles: await get("/api/settings/session-titles"), subagents: await get("/api/settings/subagents"), decisions: await get("/api/settings/decisions"), push: await get("/api/push"), links: await get("/api/public-links") };
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
      name: `Overseer limit ${k} (0 to 1000, whole)`,
      takes: [0, 1, 1000],
      refuses: [1001, -1, 1.5],
      client: (v) => {
        const s = ovSettings();
        s.caps[k] = v;
        // The box holds what was typed: the text of the number.
        const form = overseer.toOverseerForm({ settings: s, notes: "" });
        return overseer.overseerDraftProblem(form);
      },
      server: (v) => {
        const s = ovSettings();
        s.caps[k] = v;
        return ovServer(s);
      },
    }),
  ),
  { name: "Overseer quick action label (1 to 40 characters)", takes: [long(1), long(40)], refuses: ["", long(41)], client: (v) => ovClient(withAction({ label: v })), server: (v) => ovServer(withAction({ label: v })) },
  { name: "Overseer quick action description (at most 120)", takes: ["", long(120)], refuses: [long(121)], client: (v) => ovClient(withAction({ description: v })), server: (v) => ovServer(withAction({ description: v })) },
  { name: "Overseer quick action prompt (1 to 2000)", takes: [long(1), long(2000)], refuses: ["", long(2001)], client: (v) => ovClient(withAction({ prompt: v })), server: (v) => ovServer(withAction({ prompt: v })) },
  { name: "Overseer quick actions (at most 12)", takes: [1, 12], refuses: [13], client: (v) => ovClient(withActions(v as number)), server: (v) => ovServer(withActions(v as number)) },
  {
    name: "Overseer extra instructions (at most 8000)",
    takes: ["", long(8000)],
    refuses: [long(8001)],
    client: (v) => ovClient({ ...ovSettings(), extraSystemPrompt: v }),
    server: (v) => ovServer({ ...ovSettings(), extraSystemPrompt: v }),
  },
  {
    name: "Overseer standing notes (at most 8000)",
    takes: ["", long(8000)],
    refuses: [long(8001)],
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
  ...(
    [
      ["messagesMax", "Organizations message limit", (s: Json, v: number) => ({ ...s, messagesMax: v }), (d: Json, t: string) => baton.parseLimit(t), 1, 1000],
      ["perMessage", "Organizations photos per message", (s: Json, v: number) => ({ ...s, photos: { ...s.photos, perMessage: v } }), (d: Json) => baton.photoFields.perMessage(d), 1, 8],
      ["mb", "Organizations photo size, MB", (s: Json, v: number) => ({ ...s, photos: { ...s.photos, maxBytes: v * MB } }), (d: Json) => baton.photoFields.mb(d), 1, 10],
      ["perConversation", "Organizations photos per conversation", (s: Json, v: number) => ({ ...s, photos: { ...s.photos, perConversation: v } }), (d: Json) => baton.photoFields.perConversation(d), 1, 200],
      ["fileMb", "Organizations largest file, MB", (s: Json, v: number) => ({ ...s, files: { ...s.files, maxBytes: v * MB } }), (d: Json) => baton.parseFileMb(d), 1, 25],
    ] as const
  ).map(
    ([key, name, body, parse, min, max]): Limit => ({
      name: `${name} (${min} to ${max})`,
      takes: [min, max],
      refuses: [min - 1, max + 1],
      client: (v) => (parse({ [key]: String(v) } as Json, String(v)) === null ? `${name}: refused` : null),
      // The PUT body as baton-settings-draft.ts sends it: no `assistant` (its own route).
      server: (v) => {
        const { assistant: _, ...file } = fresh.baton;
        return putStatus("/api/baton/settings", body(file, v as number));
      },
    }),
  ),
  ...(
    [
      ["intervalMinutes", titles.INTERVAL],
      ["quietMinutes", titles.QUIET],
    ] as const
  ).map(
    ([key, range]): Limit => ({
      name: `Session titles ${key} (${range.min} to ${range.max})`,
      takes: [range.min, range.max],
      refuses: [range.min - 1, range.max + 1, 1.5],
      client: (v) => titles.titleDraftProblem({ ...titles.toTitleDraft(fresh.titles.settings), [key]: String(v) }),
      server: (v) => putStatus("/api/settings/session-titles", { ...fresh.titles.settings, [key]: v }),
    }),
  ),
  {
    name: "Subagents profile name (at most 48)",
    takes: [long(1), long(48)],
    refuses: ["", long(49)],
    client: (v) => profiles.profilesProblem({ version: 1, default: fresh.subagents.default, profiles: [{ ...fresh.subagents.settings.profiles[0], name: v }] }),
    server: (v) => putStatus("/api/settings/subagents", { version: 1, profiles: [{ ...fresh.subagents.settings.profiles[0], name: v }] }),
  },
  {
    name: `Decisions excluded folders (at most ${decisionForm.MAX_EXCLUSIONS})`,
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
        assert.notEqual(await limit.client(v), null, `${limit.name}: the form takes ${shown(v)}, past the limit (it would fail only at Save)`);
        const s = await limit.server(v);
        assert.ok(!s.ok, `${limit.name}: the server takes ${shown(v)}, past the limit`);
      }
    });
  }
  test("the form's Overseer limits, defaults and labels are the server's", () => {
    assert.equal(overseer.CAP_MAX, store.CAP_MAX);
    assert.equal(overseer.QUICK_ACTIONS_MAX, store.QUICK_ACTIONS_MAX);
    assert.equal(overseer.QA_LABEL_MAX, store.QA_LABEL_MAX);
    assert.equal(overseer.QA_DESC_MAX, store.QA_DESC_MAX);
    assert.equal(overseer.QA_PROMPT_MAX, store.QA_PROMPT_MAX);
    assert.equal(overseer.NOTES_MAX, store.NOTES_MAX);
    assert.equal(overseer.EXTRA_PROMPT_MAX, store.EXTRA_PROMPT_MAX);
    assert.deepEqual(overseer.CAP_DEFAULTS, store.DEFAULT_CAPS);
    assert.deepEqual(fresh.overseer.defaults.caps, store.DEFAULT_CAPS, "the route's defaults are the store's");
    for (const k of overseer.CAP_KEYS) assert.equal(overseer.CAP_LABEL[k].label, store.CAP_LABELS[k], `${k}'s label`);
    assert.deepEqual([...overseer.CAP_KEYS].sort(), Object.keys(store.DEFAULT_CAPS).sort(), "the form has a box for every server limit");
  });
  test("a refusal names the field in words, never an internal key (D1's 'caps.concurrentSessions')", async () => {
    const s = ovSettings();
    s.caps.concurrentSessions = 1001;
    const r = await ovServer(s);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error ?? "", /caps\.|quickActions\[|extraSystemPrompt/, r.error);
  });
});
