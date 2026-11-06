// Run: pnpm test:int -- server/settings-roundtrip.integration.test.ts
// Every route a Settings form saves through, over a real socket on a throwaway server
// (server/testing/hermetic-server.ts: its own agent dir and sentinel HOME, a stand-in model and
// `claude`). Per route: GET; for each field, PUT it, GET it back, and find the value in the file the
// PUT changed on disk; then PUT the fresh-install values (the GET's `defaults` where the route has
// them) and GET them back. Each route's field list must match the keys its GET returns, so a new
// setting with no row fails "covers every field". The forms' side of the same round trip is
// src/lib/settings-forms-roundtrip.test.ts (unit); this file is the HTTP and disk side, and the fields
// the unit tier can't save (a local Outreach sender is probed on its socket and unit) live here.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { authCookieName } from "./auth";
import { recordTree, startHermeticServer, treeChanges, type HermeticServer } from "./testing/hermetic-server";

let s: HermeticServer;
before(async () => {
  s = await startHermeticServer();
});
after(async () => {
  const changed = await s?.stop();
  assert.deepEqual(changed ?? [], [], "the sentinel HOME changed");
});

type Json = any;
/** As the operator's page sends it: its sign-in cookie (never the script header: updating Sova is the
    page's alone, server/page-only.ts), its origin, same-origin fetch metadata (the Updates routes
    refuse anything else, server/updates/routes.ts). */
const headers = () => ({ cookie: `${authCookieName(s.agentDir)}=${s.token}`, "content-type": "application/json", origin: s.base, "sec-fetch-site": "same-origin" });
async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${s.base}${url}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Json = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}
async function get(url: string): Promise<Json> {
  const r = await call("GET", url);
  assert.equal(r.status, 200, `GET ${url}: ${JSON.stringify(r.json)}`);
  return r.json;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const at = (o: Json, path: string): unknown => path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), o);
function put(o: Json, path: string, v: unknown): Json {
  const next = clone(o);
  const ks = path.split(".");
  let cur = next;
  for (const k of ks.slice(0, -1)) cur = cur[k] ??= {};
  cur[ks[ks.length - 1]!] = v;
  return next;
}
function leaves(o: Json, expand: ReadonlySet<string>, prefix = ""): string[] {
  return Object.keys(o).flatMap((k) => {
    const p = prefix + k;
    const v = o[k];
    return expand.has(p) && v && typeof v === "object" && !Array.isArray(v) ? leaves(v, expand, `${p}.`) : [p];
  });
}
/** Whether `needle` is somewhere in `hay` (a parsed file): as a value, or a string inside one. */
function holds(hay: unknown, needle: unknown): boolean {
  if (JSON.stringify(hay) === JSON.stringify(needle)) return true;
  if (typeof hay === "string" && typeof needle === "string" && needle.length > 0) return hay.includes(needle);
  if (hay && typeof hay === "object") return Object.values(hay).some((v) => holds(v, needle));
  return false;
}
const parsed = (path: string): unknown => {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

interface Row {
  name: string;
  get: string;
  put: string;
  /** The saved settings out of a GET. */
  settingsOf(read: Json): Json;
  /** The PUT body for settings (default: the settings themselves). */
  bodyOf?(settings: Json): Json;
  expand?: string[];
  /** Each field's edit; `with` sets others at once; `fixed` has no edit (a file's version). */
  fields: Record<string, { value?: unknown; with?: Record<string, unknown>; fixed?: string; onDisk?: false; optional?: true }>;
  /** What "defaults" are: the GET's `defaults`, else the fresh install's settings. */
  defaultsOf?(read: Json): Json;
}

const pick = (backend: string, model: string, effort: string) => ({ backend, model, effort });
const long = (n: number) => "y".repeat(n);

const ROWS: Row[] = [
  {
    name: "Overseer",
    get: "/api/settings/overseer",
    put: "/api/settings/overseer",
    settingsOf: (r) => r.settings,
    expand: ["caps", "explorer"],
    defaultsOf: (r) => r.defaults,
    fields: {
      version: { fixed: "the file's version" },
      memory: { fixed: "its own route, PUT /api/overseer/memory" },
      model: { value: "claude-code-cli/claude-sonnet-5-5" },
      thinking: { value: "high" },
      extraSystemPrompt: { value: long(8000) },
      proactivity: { value: "brief" },
      quickActions: { value: Array.from({ length: 12 }, (_, i) => ({ id: `custom-${i}`, label: long(40).slice(0, 39) + i.toString(36), description: long(120), prompt: `Prompt ${i} ${long(1900)}` })) },
      "caps.createPerTurn": { value: 1000 },
      "caps.promptsPerTurn": { value: 999 },
      "caps.archivesPerTurn": { value: 0 },
      "caps.concurrentSessions": { value: 600 },
      "caps.explorePerTurn": { value: 7 },
      "caps.linksPerTurn": { value: 8 },
      "caps.orgWritesPerTurn": { value: 501 },
      "caps.gatherPerTurn": { value: 9 },
      "caps.extRunsPerTurn": { value: 11 },
      "explorer.backend": { value: "claude-code", with: { "explorer.model": "claude-sonnet-5-5", "explorer.effort": "low" } },
      "explorer.model": { value: "claude-haiku-5-5" },
      "explorer.effort": { value: "high" },
    },
  },
  {
    name: "Overseer standing notes",
    get: "/api/overseer/notes",
    put: "/api/overseer/notes",
    settingsOf: (r) => ({ text: r.text }),
    bodyOf: (st) => st,
    defaultsOf: () => ({ text: "" }),
    fields: { text: { value: `Keep it short.\n${long(7980)}` } },
  },
  {
    name: "Models",
    get: "/api/settings/models",
    put: "/api/settings/models",
    settingsOf: (r) => r,
    fields: {
      disabledProviders: { value: ["zai"] },
      disabledModels: { value: ["mock/m1"] },
      subagentDisabledProviders: { value: ["zai"] },
      subagentDisabledModels: { value: ["mock/m1"] },
    },
  },
  {
    name: "Request limits",
    get: "/api/settings/provider-limits",
    put: "/api/settings/provider-limits",
    settingsOf: (r) => r.limits,
    bodyOf: (limits) => ({ limits }),
    defaultsOf: (r) => r.defaults,
    fields: { zai: { value: 999 }, "ollama-cloud": { value: 1 } },
  },
  {
    name: "Alignment (review)",
    get: "/api/settings",
    put: "/api/settings",
    settingsOf: (r) => ({ alignment: r.alignment }),
    expand: ["alignment"],
    fields: { "alignment.review": { value: true } },
  },
  {
    name: "Experimental",
    get: "/api/settings",
    put: "/api/settings",
    settingsOf: (r) => ({ experimental: r.experimental }),
    expand: ["experimental"],
    // On unless saved off, so the edit that changes something is off; the row's PUT of defaults turns it back on.
    fields: { "experimental.sovaModes": { value: false } },
  },
  {
    name: "Alignment",
    get: "/api/settings/align",
    put: "/api/settings/align",
    settingsOf: (r) => r.settings,
    fields: { version: { fixed: "the file's version" }, style: { value: "simplified" }, visuals: { value: true }, eagerness: { value: "careful", optional: true } },
  },
  {
    name: "Organizations",
    get: "/api/baton/settings",
    put: "/api/baton/settings",
    // `assistant` is its own route (PUT /api/settings/project-assistant): the Assistant row below.
    settingsOf: ({ assistant: _, ...r }) => r,
    expand: ["photos", "files"],
    fields: {
      messagesMax: { value: 1000 },
      "photos.enabled": { value: false },
      "photos.perMessage": { value: 8 },
      "photos.maxBytes": { value: 10 * 1024 * 1024 },
      "photos.perConversation": { value: 200 },
      "files.maxBytes": { value: 1024 * 1024 },
    },
  },
  {
    name: "Project Assistant default",
    get: "/api/baton/settings",
    put: "/api/settings/project-assistant",
    settingsOf: (r) => ({ assistant: r.assistant }),
    fields: { assistant: { value: { model: "mock/m1", thinking: "high" } } },
  },
  {
    name: "Phone Notifications",
    get: "/api/push",
    put: "/api/push/settings",
    settingsOf: (r) => r.settings,
    defaultsOf: (r) => r.defaults,
    expand: ["kinds", "quietHours"],
    fields: {
      version: { fixed: "the file's version" },
      enabled: { value: false },
      contact: { value: "mailto:someone@example.com" },
      "kinds.needs-input": { value: false },
      "kinds.open-questions": { value: false },
      "kinds.error": { value: false },
      "kinds.baton-needs-you": { value: false },
      "kinds.worker-error": { value: true },
      "kinds.playbook-review": { value: false },
      "kinds.whatsapp-down": { value: false },
      "kinds.owner-outage": { value: false },
      "quietHours.enabled": { value: true },
      "quietHours.start": { value: "23:59" },
      "quietHours.end": { value: "00:00" },
    },
  },
  {
    name: "Decisions",
    get: "/api/settings/decisions",
    put: "/api/settings/decisions",
    settingsOf: (r) => r.settings,
    defaultsOf: (r) => r.defaults,
    expand: ["jev", "features"],
    fields: {
      version: { fixed: "the file's version" },
      "jev.enabled": { value: false },
      fallback: { value: pick("claude-code", "claude-sonnet-5-5", "low") },
      "features.attention": { value: true },
      "features.tags": { value: true },
      exclusions: { value: ["/srv/private", "~/secret"] },
      neverSendTui: { value: true },
    },
  },
  {
    name: "Session titles",
    get: "/api/settings/session-titles",
    put: "/api/settings/session-titles",
    settingsOf: (r) => r.settings,
    defaultsOf: (r) => r.defaults,
    fields: {
      version: { fixed: "the file's version" },
      enabled: { value: false },
      intervalMinutes: { value: 1440 },
      quietMinutes: { value: 0 },
      primary: { value: pick("claude-code", "claude-haiku-5-5", "low") },
      fallback: { value: null },
    },
  },
  {
    name: "Summaries",
    get: "/api/settings/summarizer",
    put: "/api/settings/summarizer",
    settingsOf: (r) => r.settings,
    defaultsOf: (r) => r.defaults,
    fields: { primary: { value: { backend: "claude-code", model: "claude-haiku-5-5" } }, fallback: { value: null, onDisk: false } },
  },
  {
    name: "Memory",
    get: "/api/settings/memory",
    put: "/api/settings/memory",
    settingsOf: (r) => r.settings,
    defaultsOf: (r) => r.defaults,
    expand: ["summarizer", "sizes"],
    fields: {
      version: { fixed: "the file's version" },
      "summarizer.primary": { value: pick("claude-code", "claude-sonnet-5-5", "low") },
      "summarizer.fallback": { value: pick("claude-code", "claude-haiku-5-5", "low") },
      "sizes.uniichat": { value: 256 },
      "sizes.zoomable": { value: 16 },
    },
  },
  {
    name: "Mesh",
    get: "/api/mesh/settings",
    put: "/api/mesh/settings",
    settingsOf: (r) => r,
    expand: ["sync"],
    fields: {
      hostLabel: { value: "test-box" },
      "sync.settings": { value: false },
      "sync.themes": { value: false },
      "sync.extensions": { value: false },
      "sync.logins": { value: false },
      frontDoor: { value: null, onDisk: false },
    },
  },
  {
    name: "Public links",
    get: "/api/public-links",
    put: "/api/public-links",
    settingsOf: (r) => r.file,
    bodyOf: ({ version: _, ...patch }) => patch,
    fields: {
      version: { fixed: "the file's version" },
      route: { value: "self", with: { gateway: { publicUrl: "https://share.example.com", front: "caddy", sharePort: 65535, acceptFrom: ["nodeAbc123"], previewUrl: "https://*.preview.example.com" } } },
      ingressPort: { value: 4805, optional: true },
    },
  },
  {
    name: "Visitor logging",
    get: "/api/visitor-logging",
    put: "/api/visitor-logging",
    settingsOf: (r) => r,
    fields: { logVisitors: { value: true }, forwardIp: { value: true } },
  },
  {
    name: "Outreach",
    get: "/api/outreach",
    put: "/api/outreach",
    settingsOf: (r) => r.file,
    bodyOf: ({ version: _, paused: __, ...patch }) => patch,
    fields: {
      version: { fixed: "the file's version" },
      paused: { fixed: "Pause is its own action (POST /api/outreach/sender/pause)" },
      sender: { value: { local: { socket: "/run/sova-test/outreach.sock" } } },
      acceptFrom: { value: "all" },
      numbers: { value: [{ id: "work", socket: "/run/sova-test/work.sock" }], optional: true },
      labels: { value: { "local:work": "Work phone" }, optional: true },
    },
  },
  {
    name: "Updates",
    get: "/api/updates",
    put: "/api/updates/settings",
    settingsOf: (r) => r.settings,
    fields: {
      source: { value: { kind: "branch", branch: "master" } },
      autoCheck: { value: false },
      autoUpgrade: { value: true },
    },
  },
  {
    name: "Subagents",
    get: "/api/settings/subagents",
    put: "/api/settings/subagents",
    settingsOf: (r) => r.settings,
    fields: {
      version: { fixed: "the file's version" },
      profiles: { value: [{ id: "my-setup", name: long(48).slice(0, 44) + "Mine", delegate: null }] },
    },
  },
];

describe("every settings route: GET, PUT each field, GET, the file on disk, PUT defaults, GET", () => {
  for (const row of ROWS) {
    test(row.name, async () => {
      const first = await get(row.get);
      const fresh = row.settingsOf(first);
      // Every field the GET returns has an entry; an entry the fresh GET lacks is one the file only
      // holds once set (`optional`).
      const listed = Object.entries(row.fields).filter(([, f]) => !f.optional).map(([k]) => k);
      assert.deepEqual(listed.sort(), leaves(fresh, new Set(row.expand ?? [])).sort(), `${row.name}: one entry per field the GET returns`);
      const bodyOf = row.bodyOf ?? ((x: Json) => x);
      let cur = clone(fresh);
      for (const [path, f] of Object.entries(row.fields)) {
        if (f.fixed) continue;
        let next = put(cur, path, f.value);
        for (const [p, v] of Object.entries(f.with ?? {})) next = put(next, p, v);
        // A subagents row's delegate is the template's: the value names only what this edit changes.
        if (row.name === "Subagents") next.profiles = next.profiles.map((p: Json, i: number) => ({ ...fresh.profiles[i], ...p, delegate: fresh.profiles[i].delegate }));
        const before = recordTree(s.agentDir);
        const r = await call("PUT", row.put, bodyOf(next));
        assert.ok(r.status >= 200 && r.status < 300, `${row.name}.${path}: PUT answered ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
        const back = row.settingsOf(await get(row.get));
        for (const p of [path, ...Object.keys(f.with ?? {})]) assert.deepEqual(at(back, p), at(next, p), `${row.name}.${p}: GET after PUT`);
        if (f.onDisk !== false) {
          const changed = treeChanges(before, recordTree(s.agentDir))
            .filter((c) => !c.startsWith("removed"))
            .map((c) => join(s.agentDir, c.replace(/^\S+ /, "")))
            .filter((file) => statSync(file).isFile());
          assert.ok(changed.length > 0, `${row.name}.${path}: the PUT changed no file under the agent dir`);
          const want = at(next, path);
          assert.ok(
            changed.some((file) => holds(parsed(file), want)),
            `${row.name}.${path}: no changed file holds ${JSON.stringify(want).slice(0, 80)} (${changed.map((c) => c.slice(s.agentDir.length)).join(", ")})`,
          );
        }
        cur = back;
      }
      const defaults = row.defaultsOf ? row.defaultsOf(first) : fresh;
      const r = await call("PUT", row.put, bodyOf(row.name === "Public links" ? { ...defaults, gateway: undefined } : defaults));
      assert.ok(r.status >= 200 && r.status < 300, `${row.name}: PUT defaults answered ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
      const end = row.settingsOf(await get(row.get));
      for (const p of leaves(defaults, new Set(row.expand ?? []))) assert.deepEqual(at(end, p), at(defaults, p), `${row.name}.${p}: back to its default`);
    });
  }
});
