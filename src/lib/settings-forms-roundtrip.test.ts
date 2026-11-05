// Run: pnpm test -- src/lib/settings-forms-roundtrip.test.ts
// Every Save-gated Settings form (settings-draft.ts's registry), every field of each, round-tripped
// through the real server routes, in-process (§app.settings-dialog/save-bar). The fake IO is the app
// itself: `fetch` of a relative "/api/…" URL goes to `app.request` (no socket, no listener), on a
// throwaway PI_CODING_AGENT_DIR; any other URL is refused. Per field: a fresh form opens clean; a valid
// edit is dirty with no problem; Save writes it; the form reads back clean, and a fresh read holds the
// value. Invalid edges (blank, half-typed, out of range, over-long) are each a problem and Save skips
// them. Each Reset to Defaults leaves a savable form, even over an invalid box.
//
// The table must cover the whole registry and every field of each form's real draft (its keys after
// a fresh load): a new form or a new field with no row fails "the table covers…" below.
// Known defects (.cache/settings-qa/defects.md) are `todo` with their id, never weakened assertions.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { scratchRoot } from "../../server/test-scratch";

const agentDir = scratchRoot("sova-settings-forms-");
// The unit tier starts no program but git: a claude-code pick's checks would run the runner's
// stand-in `claude` (`--version` for a usable title model, the model list for drift). With no
// `claude` on PATH the version check answers "isn't installed" without a spawn, and the drift list
// is primed empty below. server/settings-roundtrip.integration.test.ts runs them for real.
process.env.PATH = (process.env.PATH ?? "").split(":").filter((d) => !existsSync(join(d, "claude"))).join(":");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { testApp } = await import("../../server/mesh/app-test-fixtures");
const app = await testApp();
const { cachedClaudeModels } = await import("../../server/delegate");
/** Primes the Claude list cache (60 s) so no save asks the CLI for it. */
const primeClaude = () => cachedClaudeModels(async () => []);
await primeClaude();
const { AUTH_COOKIE, initAuthToken, setAuthPort, sovaToken } = await import("../../server/auth");
/** The port this listener would be bound to: no socket is opened (as server/auth-gate.test.ts). */
const port = 47_914;
initAuthToken();
setAuthPort(port);
const self = `127.0.0.1:${port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("/api/")) throw new Error(`settings-forms-roundtrip: refused a fetch of ${url}`);
  // As the operator's browser sends it through the main listener: a loopback socket, its cookie,
  // its origin, same-origin fetch metadata (the Updates routes refuse anything else,
  // server/updates/routes.ts; the gate reads only these, server/auth-gate.test.ts).
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries({ Host: self, Origin: `http://${self}`, "Sec-Fetch-Site": "same-origin", Cookie: `${AUTH_COOKIE}=${sovaToken()}` })) headers.set(k, v);
  const lower: Record<string, string> = {};
  headers.forEach((v, k) => (lower[k] = v));
  const method = init?.method ?? "GET";
  const incoming = { headers: lower, socket: { remoteAddress: "127.0.0.1" }, url, method };
  return app.fetch(new Request(`http://${self}${url}`, { ...init, headers }), { incoming });
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
  rmSync(agentDir, { recursive: true, force: true });
});

const api = await import("./api");
const { gatedForms, resetAllDrafts } = await import("./settings-draft");
const alignment = await import("./alignment-draft");
const baton = await import("./baton-settings-draft");
const decision = await import("./decision-draft");
const experimental = await import("./experimental-draft");
const memory = await import("./memory-settings-draft");
const mesh = await import("./mesh-draft");
const policy = await import("./model-policy-draft");
const outreach = await import("./outreach");
const overseer = await import("./overseer-draft");
const limits = await import("./provider-limits-draft");
const links = await import("./public-links");
const push = await import("./push-draft");
const titles = await import("./session-title-settings-draft");
const titleForm = await import("./session-title-settings-form");
const { TITLE_RULES } = await import("../../shared/session-title-limits");
const profiles = await import("./subagent-profiles-draft");
const summarizer = await import("./summarizer-draft");
const summarizerForm = await import("./summarizer-form");
const updates = await import("./updates-draft");

type Json = any;
/** A value, or one made from the field's current value (a box held as text or as a number). */
type Val = unknown | ((cur: unknown) => unknown);
interface Field {
  /** A valid edit the server accepts. */
  valid?: Val;
  /** Other fields the edit needs at the same time (a branch name with source "branch"). */
  with?: Record<string, Val>;
  /** Values the form must refuse (a problem, Save skips). */
  invalid?: Val[];
  /** The form has no control for it (a file's version). */
  fixed?: string;
  /** Round-tripped only in server/settings-roundtrip.integration.test.ts: saving it starts something
      the unit tier refuses (a socket, a unit's status). */
  elsewhere?: string;
  /** A known defect: the field's cases run as `todo` with this id. */
  known?: string;
}
interface ResetGroup {
  name: string;
  /** The group's Reset to Defaults: the pure helper its button calls (the draft module's own). */
  apply(draft: Json, defaults: Json): Json;
  /** A box in the group made invalid first: the reset must still leave a savable form. */
  spoil?: Record<string, Val>;
  known?: string;
}
interface Row {
  label: string;
  /** What the section's load does: read the server, seed the store. */
  load(): Promise<void>;
  draft(): Json;
  setDraft(d: Json): void;
  /** Draft paths whose object is a group of fields rather than one field. */
  expand?: string[];
  fields: Record<string, Field>;
  /** Reads the server's defaults (the GET's `defaults`), for the Reset to Defaults groups. */
  defaults?(): Promise<Json>;
  resets?: ResetGroup[];
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const at = (o: Json, path: string): unknown => path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), o);
function put(o: Json, path: string, v: unknown): void {
  const ks = path.split(".");
  let cur = o;
  for (const k of ks.slice(0, -1)) cur = cur[k] ??= {};
  cur[ks[ks.length - 1]!] = v;
}
const valOf = (v: Val, cur: unknown) => (typeof v === "function" ? (v as (c: unknown) => unknown)(cur) : clone(v));
function patched(d: Json, patch: Record<string, Val>): Json {
  const next = clone(d);
  for (const [p, v] of Object.entries(patch)) put(next, p, valOf(v, at(d, p)));
  return next;
}
/** The draft's fields: its keys, recursing into the paths a row names as groups. */
function leaves(o: Json, expand: ReadonlySet<string>, prefix = ""): string[] {
  return Object.keys(o).flatMap((k) => {
    const p = prefix + k;
    const v = o[k];
    return expand.has(p) && v && typeof v === "object" && !Array.isArray(v) ? leaves(v, expand, `${p}.`) : [p];
  });
}
/** A box held as text gets text, one held as a number a number: whichever the draft keeps. */
const num = (n: number) => (cur: unknown) => (typeof cur === "string" ? String(n) : n);
/** A raw typed string: a text box keeps it; a number box's parse of it (`Number("")` is 0, so NaN for anything not a whole number's text). */
const typed = (s: string) => (cur: unknown) => (typeof cur === "string" ? s : /^\s*-?\d+(\.\d+)?\s*$/.test(s) ? Number(s) : Number.NaN);
const pick = (backend: string, model: string, effort: string) => ({ backend, model, effort });
const long = (n: number) => "x".repeat(n);

const form = (label: string) => {
  const f = gatedForms().find((g) => g.label === label);
  assert.ok(f, `no registered form "${label}"`);
  return f;
};

const overseerCaps = Object.fromEntries(
  overseer.CAP_KEYS.map((k) => [
    `settings.caps.${k}`,
    { valid: num(7), invalid: [typed(""), typed("1e"), typed("a5"), typed("-1"), typed("1.5"), num(1001)] } satisfies Field,
  ]),
);

const ROWS: Row[] = [
  {
    label: "Updates",
    load: async () => updates.setUpdatesSaved((await api.getUpdates()).settings),
    draft: () => updates.updatesDraft(),
    setDraft: updates.setUpdatesDraft,
    fields: {
      source: { valid: "branch", with: { branch: "master" } },
      branch: { valid: "master", with: { source: "branch" }, invalid: ["", "   "] },
      autoCheck: { valid: false },
      autoUpgrade: { valid: true },
    },
  },
  {
    label: "Request limits",
    load: async () => limits.setLimitsSaved((await api.getProviderLimits()).limits),
    draft: () => limits.limitsDraft(),
    setDraft: limits.setLimitsDraft,
    fields: {
      // Empty is "no limit" (provider-limits.ts), so it isn't an invalid edge here.
      zai: { valid: num(7), invalid: [typed("1e"), typed("0"), typed("1.5"), num(1000)] },
      "ollama-cloud": { valid: num(999), invalid: [typed("a5"), num(1000)] },
    },
  },
  {
    label: "Subagents",
    load: async () => profiles.profilesDraft.setSaved(profiles.savedOf(await api.getSubagentProfiles())),
    draft: () => profiles.profilesDraft.draft(),
    setDraft: profiles.profilesDraft.setDraft,
    fields: {
      version: { fixed: "the file's version" },
      default: { valid: "off" },
      profiles: {
        valid: (cur: Json) => [{ ...cur[0], name: "Mine" }],
        invalid: [(cur: Json) => [{ ...cur[0], name: "" }], (cur: Json) => [{ ...cur[0], name: long(49) }], (cur: Json) => [{ ...cur[0], name: "Off" }]],
      },
    },
  },
  {
    label: "Alignment",
    load: async () => alignment.setAlignmentSaved(await alignment.readAlignment()),
    draft: () => alignment.alignmentDraft(),
    setDraft: alignment.setAlignmentDraft,
    fields: {
      eagerness: { valid: "careful" },
      style: { valid: "simplified" },
      visuals: { valid: true },
      review: { valid: true },
    },
  },
  {
    label: "Overseer",
    load: async () => {
      const [info, notes] = await Promise.all([api.getOverseerSettings(), api.getOverseerNotes()]);
      overseer.setOverseerSaved({ settings: info.settings, notes: notes.text });
    },
    draft: () => overseer.overseerDraft(),
    setDraft: overseer.setOverseerDraft,
    expand: ["settings", "settings.caps", "settings.explorer"],
    fields: {
      "settings.version": { fixed: "the file's version" },
      "settings.model": { valid: "claude-code-cli/claude-sonnet-5-5" },
      "settings.thinking": { valid: "high" },
      "settings.extraSystemPrompt": { valid: "Be brief.", invalid: [long(8001)] },
      "settings.proactivity": { valid: "brief" },
      "settings.quickActions": {
        valid: (cur: Json) => [{ ...cur[0], label: "Moving" }, ...cur.slice(1)],
        invalid: [
          (cur: Json) => [{ ...cur[0], label: long(41) }, ...cur.slice(1)],
          (cur: Json) => [{ ...cur[0], description: long(121) }, ...cur.slice(1)],
          (cur: Json) => [{ ...cur[0], prompt: long(2001) }, ...cur.slice(1)],
          (cur: Json) => [...cur, ...Array.from({ length: 13 - cur.length }, (_, i) => ({ id: `custom-${i + 1}`, label: `A${i}`, description: "", prompt: "Go." }))],
        ],
      },
      ...overseerCaps,
      "settings.explorer.backend": { valid: "pi", with: { "settings.explorer.model": "ollama-cloud/deepseek-v4.1-flash", "settings.explorer.effort": "high" } },
      "settings.explorer.model": { valid: "zai/glm-5.3" },
      "settings.explorer.effort": { valid: "low" },
      notes: { valid: "Keep it short.\n", invalid: [long(8001)] },
    },
    defaults: async () => (await api.getOverseerSettings()).defaults,
    resets: [
      { name: "Limits", apply: overseer.resetLimits, spoil: { "settings.caps.createPerTurn": typed("") } },
      { name: "Limits, over a half-typed box", apply: overseer.resetLimits, spoil: { "settings.caps.archivesPerTurn": typed("1e") } },
      { name: "Quick actions", apply: overseer.resetQuickActions, spoil: { "settings.quickActions": (cur: Json) => [{ ...cur[0], label: long(41) }, ...cur.slice(1)] } },
      { name: "Idea explorer", apply: overseer.resetExplorer },
    ],
  },
  {
    label: "Phone Notifications",
    load: async () => push.setPushSaved((await api.getPushInfo()).settings),
    draft: () => push.pushDraft(),
    setDraft: push.setPushDraft,
    expand: ["kinds", "quietHours"],
    fields: {
      enabled: { valid: false },
      contact: { valid: "mailto:someone@example.com", invalid: ["not a contact"] },
      "kinds.needs-input": { valid: false },
      "kinds.open-questions": { valid: false },
      "kinds.error": { valid: false },
      "kinds.baton-needs-you": { valid: false },
      "kinds.worker-error": { valid: true },
      "kinds.playbook-review": { valid: false },
      "kinds.whatsapp-down": { valid: false },
      "kinds.owner-outage": { valid: false },
      "quietHours.enabled": { valid: true },
      "quietHours.start": { valid: "21:30", invalid: ["", "25:00", "9", "07:00"] },
      "quietHours.end": { valid: "06:15", invalid: ["", "7:6x", "21:30"] },
    },
  },
  {
    label: "Decisions",
    load: async () => decision.setDecisionSaved((await api.getDecisionSettings()).settings),
    draft: () => decision.decisionDraft(),
    setDraft: decision.setDecisionDraft,
    expand: ["jev", "features"],
    fields: {
      version: { fixed: "the file's version" },
      "jev.enabled": { valid: false },
      fallback: { valid: pick("claude-code", "claude-sonnet-5-5", "low"), invalid: [pick("claude-code", "", "low"), pick("claude-code", "claude-sonnet-5-5", "")] },
      "features.attention": { valid: true },
      "features.tags": { valid: true },
      "features.reconcile": { valid: false },
      exclusions: { valid: "/srv/private", invalid: ["relative/path"] },
      neverSendTui: { valid: true },
    },
  },
  {
    label: "Session titles",
    load: async () => titles.setTitleSettingsSaved((await api.getSessionTitleSettings()).settings),
    draft: () => titles.titleSettingsDraft(),
    setDraft: titles.setTitleSettingsDraft,
    fields: {
      version: { fixed: "the file's version" },
      enabled: { valid: false },
      intervalMinutes: { valid: num(1440), invalid: [typed(""), typed("1e"), typed("0"), typed("1.5"), num(1441)] },
      quietMinutes: { valid: num(0), invalid: [typed(""), typed("a5"), typed("-1"), num(1441)] },
      primary: { valid: pick("claude-code", "claude-haiku-5-5", "low"), invalid: [pick("claude-code", "", "low")] },
      fallback: { valid: null },
    },
    defaults: async () => (await api.getSessionTitleSettings()).defaults,
    resets: [{ name: "Session titles", apply: (_d, def) => titleForm.toTitleDraft(def), spoil: { intervalMinutes: typed("1e") } }],
  },
  {
    label: "Summaries",
    load: async () => summarizer.setSummarizerSaved((await api.getSummarizerSettings()).settings),
    draft: () => summarizer.summarizerDraft(),
    setDraft: summarizer.setSummarizerDraft,
    fields: {
      primary: { valid: { backend: "claude-code", model: "claude-haiku-5-5" }, invalid: [{ backend: "pi", model: "" }] },
      fallback: { valid: null, invalid: [{ backend: "pi", model: "" }] },
    },
    defaults: async () => (await api.getSummarizerSettings()).defaults,
    resets: [{ name: "Summaries", apply: (_d, def) => summarizerForm.cloneSummarizer(def), spoil: { primary: { backend: "pi", model: "" } } }],
  },
  {
    label: "Memory",
    load: async () => memory.setMemorySaved((await api.getMemorySettings()).settings),
    draft: () => memory.memoryDraft(),
    setDraft: memory.setMemoryDraft,
    expand: ["sizes"],
    fields: {
      primary: { valid: pick("claude-code", "claude-sonnet-5-5", "low"), invalid: [pick("claude-code", "", "low"), pick("claude-code", "claude-sonnet-5-5", "")] },
      // The primary is Sonnet by now (the row above): a fallback the same as it is a problem.
      fallback: { valid: pick("claude-code", "claude-haiku-5-5", "low"), invalid: [pick("claude-code", "claude-sonnet-5-5", "low")] },
      "sizes.uniichat": { valid: 64 },
      "sizes.zoomable": { valid: 256 },
    },
    defaults: async () => (await api.getMemorySettings()).defaults,
    resets: [
      { name: "Summarizer", apply: memory.resetMemorySummarizer, spoil: { primary: pick("claude-code", "", "low") } },
      { name: "Summary size", apply: memory.resetMemorySizes },
    ],
  },
  {
    label: "Organizations",
    load: async () => baton.setBatonSaved(await api.getBatonSettings()),
    draft: () => baton.batonDraft(),
    setDraft: baton.setBatonDraft,
    fields: {
      messagesMax: { valid: "1000", invalid: ["", "1e", "0", "1.5", "1001", "a5"] },
      photosOn: { valid: false },
      perMessage: { valid: "8", invalid: ["", "0", "9"] },
      mb: { valid: "10", invalid: ["", "0", "11"] },
      perConversation: { valid: "200", invalid: ["", "0", "201"] },
      fileMb: { valid: "1", invalid: ["", "0", "26"] },
      assistant: { valid: { model: "zai/glm-5.3", thinking: "high" } },
    },
  },
  {
    label: "Mesh",
    load: async () => mesh.setMeshSaved(await api.getMeshSettings()),
    draft: () => mesh.meshDraft(),
    setDraft: mesh.setMeshDraft,
    expand: ["sync"],
    fields: {
      hostLabel: { valid: "test-box", invalid: ["", "   "] },
      "sync.settings": { valid: false },
      "sync.themes": { valid: false },
      "sync.extensions": { valid: false },
      "sync.logins": { valid: false },
      frontDoor: { valid: "" },
      loginKinds: { valid: "api-keys" },
    },
  },
  {
    label: "Public links",
    load: async () => links.acceptPublicLinksInfo(await links.getPublicLinks()),
    draft: () => links.publicLinksDraft(),
    setDraft: links.setPublicLinksDraft,
    fields: {
      route: { valid: "self", with: { publicUrl: "https://share.example.com" } },
      viaNodeId: { valid: "", fixed: "only a gateway peer fills it" },
      publicUrl: { valid: "https://links.example.com", with: { route: "self" }, invalid: ["not a url", "ftp://x.example.com"] },
      front: { valid: "caddy" },
      sharePort: { valid: "4803", invalid: ["", "0", "65536", "48o3"] },
      acceptFrom: { valid: ["nodeAbc123"] },
      ingressPort: { elsewhere: "only a route via a gateway peer saves it", with: { route: "via", viaNodeId: "nodeAbc123" }, invalid: ["", "0", "70000", "48o5"] },
      previewUrl: { valid: "https://*.preview.example.com", invalid: ["https://preview.example.com", "http://*.example.com/path"] },
    },
  },
  {
    label: "Visitor logging",
    load: async () => links.setVisitorLoggingSaved(await links.getVisitorLogging()),
    draft: () => links.visitorLoggingDraft(),
    setDraft: links.setVisitorLoggingDraft,
    fields: { logVisitors: { valid: true }, forwardIp: { valid: true } },
  },
  {
    label: "Outreach",
    load: async () => outreach.acceptOutreachInfo(await outreach.getOutreach()),
    draft: () => outreach.outreachDraft(),
    setDraft: outreach.setOutreachDraft,
    fields: {
      sender: { elsewhere: "a local sender is probed on its socket and unit", invalid: [] },
      socket: { elsewhere: "probed", with: { sender: "local" }, invalid: ["relative.sock"] },
      numbers: { elsewhere: "probed", invalid: [[{ id: "Work!", socket: "/run/test/w.sock" }], [{ id: "work", socket: "relative.sock" }], [{ id: "a", socket: "/s" }, { id: "a", socket: "/t" }]] },
      labels: { elsewhere: "a label names a sender entry, and every entry is probed" },
      acceptFrom: { valid: "all" },
    },
  },
  {
    label: "Experimental",
    load: async () => experimental.setExperimentalSaved((await api.getWebSettings()).experimental),
    draft: () => experimental.experimentalDraft(),
    setDraft: experimental.setExperimentalDraft,
    fields: {},
  },
  // Last: the providers it turns off would refuse the model picks of the forms above.
  {
    label: "Models",
    load: async () => policy.setPolicySaved(await api.getModelPolicy()),
    draft: () => policy.policyDraft(),
    setDraft: policy.setPolicyDraft,
    fields: {
      disabledProviders: { valid: ["zai"] },
      disabledModels: { valid: ["ollama-cloud/deepseek-v4.1-flash"] },
      subagentDisabledProviders: { valid: ["zai"] },
      subagentDisabledModels: { valid: ["ollama-cloud/deepseek-v4.1-flash"] },
    },
  },
];

describe("the table covers every Save-gated form and every field of each", () => {
  before(() => resetAllDrafts());
  test("one row per registered form, and no row for a form that isn't registered", () => {
    assert.deepEqual(ROWS.map((r) => r.label).sort(), gatedForms().map((f) => f.label).sort());
  });
  for (const row of ROWS) {
    test(`${row.label}: one entry per field of its real draft`, async () => {
      resetAllDrafts();
      await row.load();
      const d = row.draft();
      assert.ok(d, `${row.label} loaded no draft`);
      assert.deepEqual(Object.keys(row.fields).sort(), leaves(d, new Set(row.expand ?? [])).sort());
      for (const [path, f] of Object.entries(row.fields)) assert.ok(f.fixed || f.elsewhere || f.valid !== undefined, `${row.label}.${path} needs a valid edit or a reason it has none`);
    });
  }
});

for (const row of ROWS) {
  describe(`${row.label}: edit, save, read back; invalid edges; Reset to Defaults`, () => {
    before(async () => {
      resetAllDrafts();
      await row.load();
    });

    test("opens clean on a fresh install: not dirty, no problem", () => {
      const f = form(row.label);
      assert.equal(f.dirty(), false);
      assert.equal(f.problem(), null);
    });

    for (const [path, field] of Object.entries(row.fields)) {
      if (!field.fixed && !field.elsewhere) test(`${path}: a valid edit is dirty, saves, and reads back`, async () => {
        await primeClaude();
        const f = form(row.label);
        const edit = patched(row.draft(), { [path]: field.valid, ...(field.with ?? {}) });
        const changed = JSON.stringify(edit) !== JSON.stringify(row.draft());
        row.setDraft(edit);
        assert.equal(f.problem(), null, `${row.label}.${path}: the valid edit has a problem`);
        assert.equal(f.dirty(), changed, `${row.label}.${path}: dirty iff the edit changed something`);
        const status = await f.save();
        assert.equal(f.error(), null, `${row.label}.${path}: the save failed`);
        assert.equal(status, changed ? "saved" : "skipped");
        assert.equal(f.dirty(), false, `${row.label}.${path}: dirty after its save`);
        f.reset();
        await row.load();
        for (const p of [path, ...Object.keys(field.with ?? {})]) assert.deepEqual(at(row.draft(), p), at(edit, p), `${row.label}.${p}: a fresh read holds what was saved`);
        assert.equal(f.dirty(), false);
      });

      if (!field.invalid?.length) continue;
      test(`${path}: every invalid edge is a problem, and Save writes nothing`, { todo: field.known }, async () => {
        const f = form(row.label);
        for (const bad of field.invalid!) {
          const base = row.draft();
          const edit = patched(base, { [path]: bad, ...(field.with ?? {}) });
          row.setDraft(edit);
          const shown = JSON.stringify(at(edit, path))?.slice(0, 40);
          assert.notEqual(f.problem(), null, `${row.label}.${path} = ${shown}: no problem`);
          assert.equal(await f.save(), "skipped", `${row.label}.${path} = ${shown}: Save wrote it`);
          f.discard();
          assert.equal(f.dirty(), false);
        }
      });
    }

    for (const group of row.resets ?? []) {
      test(`Reset to Defaults (${group.name}) leaves a form Save takes, and it reads back as the defaults`, { todo: group.known }, async () => {
        const f = form(row.label);
        const defaults = await row.defaults!();
        const spoiled = group.spoil ? patched(row.draft(), group.spoil) : row.draft();
        if (group.spoil) {
          row.setDraft(spoiled);
          assert.notEqual(f.problem(), null, "the spoiled box is a problem before the reset");
        }
        const reset = group.apply(clone(spoiled), defaults);
        row.setDraft(reset);
        assert.equal(f.problem(), null, `${row.label}: a problem right after Reset to Defaults (${group.name})`);
        const status = await f.save();
        assert.equal(f.error(), null, `${row.label}: the save after Reset to Defaults failed`);
        assert.notEqual(status, "failed");
        assert.equal(f.dirty(), false);
        f.reset();
        await row.load();
        row.setDraft(group.apply(clone(row.draft()), defaults));
        assert.equal(f.dirty(), false, `${row.label}: after the reset's save, its group reads back as the defaults`);
        f.discard();
      });
    }

    test("a fresh form after every save is clean, with no problem", async () => {
      resetAllDrafts();
      await row.load();
      const f = form(row.label);
      assert.equal(f.dirty(), false);
      assert.equal(f.problem(), null);
    });
  });
}

// Every number box in a Save-gated form (the coordinator's frozen-red case, for the browsers not run
// here): each raw string a user can leave in it is kept exactly as typed, is a problem (Save waits),
// and is cleared both by typing a valid value and by its group's Reset to Defaults where it has one.
// The table must name every field whose fresh draft is a whole number's text, so a new number box
// with no row fails. General → Sessions in Recent saves as you type and repairs on leave (the
// operator's exception): it is no draft store, and settings-browser.integration.test.ts checks it.
const RAW = ["", "-", "1e", "1.", "2.5", "-3", "abc", " "];
interface NumberBox {
  label: string;
  path: string;
  max: number;
  /** Empty is a value here (Request limits: no limit), so the blank strings aren't refused. */
  blankOk?: true;
  /** The Reset to Defaults group that covers it. */
  reset?: string;
}
const NUMBER_BOXES: NumberBox[] = [
  ...overseer.CAP_KEYS.map((k): NumberBox => ({ label: "Overseer", path: `settings.caps.${k}`, max: overseer.CAP_MAX, reset: "Limits" })),
  { label: "Request limits", path: "zai", max: 999, blankOk: true },
  { label: "Request limits", path: "ollama-cloud", max: 999, blankOk: true },
  { label: "Session titles", path: "intervalMinutes", max: TITLE_RULES.intervalMinutes.max, reset: "Session titles" },
  { label: "Session titles", path: "quietMinutes", max: TITLE_RULES.quietMinutes.max, reset: "Session titles" },
  { label: "Organizations", path: "messagesMax", max: 1000 },
  { label: "Organizations", path: "perMessage", max: 8 },
  { label: "Organizations", path: "mb", max: 10 },
  { label: "Organizations", path: "perConversation", max: 200 },
  { label: "Organizations", path: "fileMb", max: 25 },
  { label: "Public links", path: "sharePort", max: 65535 },
  { label: "Public links", path: "ingressPort", max: 65535 },
];

describe("every number box: each raw string stays as typed, is a problem, and clears", () => {
  test("the table names every number box (every field whose fresh draft is a number's text)", async () => {
    const found: string[] = [];
    for (const row of ROWS) {
      resetAllDrafts();
      await row.load();
      for (const path of leaves(row.draft(), new Set(row.expand ?? []))) if (typeof at(row.draft(), path) === "string" && /^\d+$/.test(at(row.draft(), path) as string)) found.push(`${row.label}.${path}`);
    }
    assert.deepEqual(NUMBER_BOXES.map((b) => `${b.label}.${b.path}`).sort(), found.sort());
  });
  for (const nb of NUMBER_BOXES) {
    test(`${nb.label}.${nb.path}`, async () => {
      const row = ROWS.find((r) => r.label === nb.label)!;
      resetAllDrafts();
      await row.load();
      const f = form(nb.label);
      const fresh = row.draft();
      // Ingress port is saved only on a route via a gateway (its box shows only then).
      const ctx = nb.path === "ingressPort" ? { route: "via", viaNodeId: "nodeAbc123" } : {};
      const group = row.resets?.find((g) => g.name === nb.reset);
      const defaults = group ? await row.defaults!() : null;
      for (const raw of [...RAW.filter((r) => !(nb.blankOk && r.trim() === "")), String(nb.max + 1)]) {
        row.setDraft(patched(fresh, { ...ctx, [nb.path]: raw }));
        assert.equal(at(row.draft(), nb.path), raw, `${nb.label}.${nb.path}: "${raw}" isn't kept as typed`);
        assert.notEqual(f.problem(), null, `${nb.label}.${nb.path}: "${raw}" is no problem`);
        assert.equal(await f.save(), "skipped", `${nb.label}.${nb.path}: Save wrote "${raw}"`);
        row.setDraft(patched(row.draft(), { [nb.path]: String(nb.max) }));
        assert.equal(f.problem(), null, `${nb.label}.${nb.path}: typing ${nb.max} over "${raw}" leaves a problem`);
        if (group) {
          row.setDraft(patched(fresh, { ...ctx, [nb.path]: raw }));
          row.setDraft(group.apply(clone(row.draft()), defaults));
          assert.equal(f.problem(), null, `${nb.label}.${nb.path}: Reset to Defaults (${group.name}) over "${raw}" leaves a problem`);
        }
      }
      f.discard();
    });
  }
});

// The subagent profile editor's team numbers: nested in a profile of the `profiles` array, so the
// flat table above can't see them. The draft holds what the box holds, the typed text (the save
// writes its number).
// Each raw string is a problem and Save waits; the bound saves and reads back. The coverage check
// walks the whole profile, arrays and all: a new number anywhere in a profile with no row fails.
const { TEAM_RULES } = await import("../../shared/subagent-limits");
describe("Subagents: every team number inside a profile", () => {
  const TEAM_BOXES: Record<string, keyof typeof TEAM_RULES> = {
    "teams.monitor.contextPct": "contextPct",
    "teams.monitor.everyMinutes": "everyMinutes",
    "teams.monitor.usage.pausePct": "pausePct",
    "teams.monitor.usage.resumeMarginMinutes": "resumeMarginMinutes",
    "teams.handover.retireTimeoutMinutes": "retireTimeoutMinutes",
  };
  /** Every number's path in `o`, arrays included (`[0]`). */
  const numbers = (o: Json, prefix = ""): string[] =>
    o && typeof o === "object"
      ? Object.entries(o).flatMap(([k, v]) => numbers(v, Array.isArray(o) ? `${prefix}[${k}].` : `${prefix}${k}.`))
      : typeof o === "number"
        ? [prefix.slice(0, -1)]
        : [];
  /** The profile list with profile 0's teams switched on, as the editor's switch seeds them. */
  const withTeams = async (): Promise<Json> => {
    const seed = (await api.getTeamDefaults()).defaults;
    const d: Json = clone(profiles.profilesDraft.draft());
    // On Claude Code picks: the seed's pi model isn't in this process's registry.
    const claude = { primary: pick("claude-code", "claude-sonnet-5-5", "low"), fallback: null };
    d.profiles[0].teams = { coordinator: { ...seed.coordinator, ...claude }, monitor: { ...seed.monitor, ...claude }, handover: seed.handover };
    return d;
  };
  const load = async () => {
    resetAllDrafts();
    await primeClaude();
    profiles.profilesDraft.setSaved(profiles.savedOf(await api.getSubagentProfiles()));
  };

  test("the table names every number in a profile (its teams seeded), and every team number field", async () => {
    await load();
    const d = await withTeams();
    assert.deepEqual(numbers(d.profiles[0]).sort(), Object.keys(TEAM_BOXES).sort());
    assert.deepEqual(Object.values(TEAM_BOXES).sort(), Object.keys(TEAM_RULES).sort());
  });
  for (const [path, field] of Object.entries(TEAM_BOXES)) {
    test(`profiles[0].${path}: "1." (half-typed) is a problem, as in every other number box (D14)`, async () => {
      await load();
      const d = await withTeams();
      put(d.profiles[0], path, "1.");
      profiles.profilesDraft.setDraft(d);
      assert.notEqual(form("Subagents").problem(), null, `${path}: "1." is no problem`);
      form("Subagents").discard();
    });
    test(`profiles[0].${path}: each raw string is a problem; its bounds save and read back`, async () => {
      await load();
      const f = form("Subagents");
      const { min, max } = TEAM_RULES[field];
      const base = await withTeams();
      const at0 = (v: unknown) => {
        const d = clone(base);
        put(d.profiles[0], path, v);
        return d;
      };
      for (const raw of [...RAW, String(max + 1), String(min - 1)]) {
        profiles.profilesDraft.setDraft(at0(raw));
        assert.notEqual(f.problem(), null, `${path}: "${raw}" is no problem`);
        assert.equal(await f.save(), "skipped", `${path}: Save wrote "${raw}"`);
        profiles.profilesDraft.setDraft(at0(max));
        assert.equal(f.problem(), null, `${path}: typing ${max} over "${raw}" leaves a problem`);
      }
      for (const v of [min, max]) {
        profiles.profilesDraft.setDraft(at0(String(v)));
        await primeClaude();
        await f.save();
        assert.equal(f.error(), null, `${path} = ${v}: the save failed`);
        f.reset();
        await load();
        assert.equal(at(profiles.profilesDraft.draft()!.profiles[0], path), v, `${path} = ${v}: a fresh read holds it`);
      }
    });
  }
});

// Settings → Merge Queue's staged edit is a held edit (its own confirm saves it, one commit), not a
// registry form: a time-limit box whose text isn't a time limit must still hold the dialog's close,
// and Discard and Close must drop it (D13: the bad text was never unsaved work, so nothing held it).
const mq = await import("./merge-queue-settings");
const held = await import("./merge-queue-settings-draft");
const { heldEdits } = await import("./settings-draft");
describe("Merge Queue: a bad time-limit box holds the close", () => {
  const base = {
    landing: { push: false },
    review: { on: false },
    fixed: { checkMaxMin: 30 },
    checks: { list: [{ id: "unit", label: "Unit tests", timeoutSec: 600, rerun: false, optional: false }] },
  } as unknown as Parameters<typeof mq.toProjectDraft>[0];
  for (const bad of ["", "-", "1e", "1.", "2.5", "-3", "abc", " ", "31", "99999"]) {
    test(`"${bad}" holds the close, names the check, and Discard drops it`, () => {
      resetAllDrafts();
      const draft = mq.typedMinutes(mq.toProjectDraft(base, false), "unit", bad, base);
      held.stageEdit({ project: "prj_test", base, hasOrigin: false, draft });
      assert.equal(mq.minutesTextOf(draft, "unit", base), bad, "kept as typed");
      assert.equal(mq.draftProblem(draft, base), "Unit tests: the time limit in minutes must be a whole number from 1 to 30.");
      assert.deepEqual(heldEdits().map((h) => h.label), ["Merge Queue"], "the close-hold doesn't count it");
      resetAllDrafts();
      assert.deepEqual(heldEdits(), [], "Discard and Close leaves it held");
    });
  }
  test("a valid time typed back to the saved one holds nothing", () => {
    resetAllDrafts();
    const draft = mq.typedMinutes(mq.typedMinutes(mq.toProjectDraft(base, false), "unit", "1e", base), "unit", "10", base);
    held.stageEdit({ project: "prj_test", base, hasOrigin: false, draft });
    assert.deepEqual(heldEdits(), []);
    resetAllDrafts();
  });
});
