// Run: npx tsx --test server/team-defaults.test.ts (or npm test). Writes only under a mkdtemp dir; no CLI runs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DEFAULT_TEAM_DEFAULTS } from "../pi-config/extensions/subagents/team-defaults.ts";
import type { ModelPolicy, WorkerChoice } from "../shared/protocol";
import type { TeamDefaults } from "../shared/team-defaults";
import type { DelegateSources } from "./delegate";
import { saveTeamDefaults, teamDefaultsFile, teamDefaultsInfo, teamDefaultsOff, teamOptions } from "./team-defaults";

const root = mkdtempSync(join(tmpdir(), "sova-team-defaults-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
/** A fresh agent dir per test: the file's name is fixed, its directory is what varies. */
const agentDir = () => {
  const dir = join(root, `agent-${++n}`);
  mkdirSync(dir);
  return dir;
};

const EMPTY: ModelPolicy = { disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] };
const ALL_CLAUDE = ["low", "medium", "high", "xhigh", "max"];
const sources = (over: Partial<DelegateSources> = {}): DelegateSources => ({
  piModels: async () => [{ ref: "zai/glm-5.3", id: "glm-5.3", provider: "zai", thinkingLevels: ["off", "low", "medium", "high"] }],
  claudeModels: async () => [
    { id: "opus[1m]", name: "Opus", efforts: ALL_CLAUDE },
    { id: "haiku", name: "Haiku", efforts: ALL_CLAUDE },
    { id: "sonnet", name: "Sonnet", efforts: ["low", "medium"] },
  ],
  policy: () => EMPTY,
  ...over,
});
const glm: WorkerChoice = { backend: "pi", model: "zai/glm-5.3", effort: "high" };
const sonnet: WorkerChoice = { backend: "claude-code", model: "sonnet", effort: "medium" };
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** The pinned defaults with both members on, as a save body. */
const on = (): TeamDefaults => copy(DEFAULT_TEAM_DEFAULTS as TeamDefaults);

describe("GET /api/settings/team", () => {
  test("no file: the built-in values with both members off, not stored, and nothing written", () => {
    const dir = agentDir();
    const info = teamDefaultsInfo(dir);
    assert.equal(info.stored, false);
    assert.equal(info.error, undefined);
    assert.equal(info.settings.coordinator.enabled, false);
    assert.equal(info.settings.monitor.enabled, false);
    // Only the two switches differ from the built-in values.
    const off = on();
    off.coordinator.enabled = false;
    off.monitor.enabled = false;
    assert.deepEqual(info.settings, off);
    assert.deepEqual(info.settings, teamDefaultsOff());
    assert.deepEqual(info.defaults, on());
    assert.deepEqual(info.backends.map((b) => b.id), ["pi", "claude-code"]);
    assert.equal(info.file, join(dir, "team-defaults.json"));
    assert.ok(!existsSync(info.file), "reading never writes");
  });

  test("the pinned built-in values", () => {
    assert.deepEqual(DEFAULT_TEAM_DEFAULTS, {
      version: 1,
      coordinator: { enabled: true, role: "coordinator", primary: { backend: "claude-code", model: "opus[1m]", effort: "medium" }, fallback: null, instructions: "" },
      monitor: {
        enabled: true,
        role: "monitor",
        primary: { backend: "claude-code", model: "haiku", effort: "medium" },
        fallback: null,
        contextPct: 60,
        everyMinutes: 10,
        usage: { enabled: true, pausePct: 90, resumeMarginMinutes: 5 },
        instructions: "",
      },
      handover: { retireTimeoutMinutes: 10 },
    });
  });

  test("a malformed file is reported, and the screen gets the off defaults to hold", () => {
    const dir = agentDir();
    writeFileSync(teamDefaultsFile(dir), "{ nope");
    const info = teamDefaultsInfo(dir);
    assert.equal(info.stored, true);
    assert.match(info.error ?? "", /^not valid JSON/, "the parser's reason is carried");
    assert.deepEqual(info.settings, teamDefaultsOff());
  });

  test("a well-formed file of the wrong shape is reported too", () => {
    const dir = agentDir();
    writeFileSync(teamDefaultsFile(dir), JSON.stringify({ version: 2 }));
    assert.equal(teamDefaultsInfo(dir).error, "version: must be 1");
  });
});

describe("GET /api/settings/team/options", () => {
  test("is Delegate's discovery, policy included", async () => {
    const options = await teamOptions(sources({ policy: () => ({ ...EMPTY, subagentDisabledModels: ["haiku"] }) }));
    assert.deepEqual(options.backends.map((b) => [b.id, b.models?.map((m) => m.id)]), [
      ["pi", ["zai/glm-5.3"]],
      ["claude-code", ["opus[1m]", "haiku", "sonnet"]],
    ]);
    assert.match(options.backends[1]!.models!.find((m) => m.id === "haiku")!.denied!, /off for subagents/);
  });
});

describe("PUT /api/settings/team", () => {
  test("saves, and reads back what was saved, through the extension's reader", async () => {
    const dir = agentDir();
    const body = on();
    body.monitor.fallback = glm;
    body.monitor.contextPct = 75;
    body.coordinator.instructions = "Report milestones only.";
    const result = await saveTeamDefaults(body, sources(), dir);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (result.status !== 200) return;
    assert.deepEqual(result.body.warnings, []);
    assert.equal(result.body.stored, true);
    assert.deepEqual(result.body.settings, body);
    assert.deepEqual(JSON.parse(readFileSync(teamDefaultsFile(dir), "utf8")), body);
    assert.deepEqual(teamDefaultsInfo(dir).settings, body);
  });

  test("a bad shape is refused with the parser's reason, and nothing is written", async () => {
    const dir = agentDir();
    const body = on() as unknown as Record<string, unknown>;
    (body.monitor as Record<string, unknown>).contextPct = "sixty";
    const result = await saveTeamDefaults(body, sources(), dir);
    assert.equal(result.status, 400);
    assert.match((result.body as { error: string }).error, /^monitor\.contextPct: must be a number from 1 to 100$/);
    assert.ok(!existsSync(teamDefaultsFile(dir)));
  });

  test("two roles under one name are refused by the extension's parse", async () => {
    const dir = agentDir();
    const body = on();
    body.monitor.role = "Coordinator";
    const result = await saveTeamDefaults(body, sources(), dir);
    assert.equal(result.status, 400);
    assert.match((result.body as { error: string }).error, /monitor\.role: must differ from coordinator\.role/);
  });

  test("a row without an effort is refused: the screen always names one", async () => {
    const dir = agentDir();
    const body = on() as unknown as { coordinator: { fallback: unknown } };
    body.coordinator.fallback = { backend: "claude-code", model: "sonnet" };
    const result = await saveTeamDefaults(body, sources(), dir);
    assert.equal(result.status, 400);
    assert.equal((result.body as { error: string }).error, "Coordinator fallback: choose an effort");
    assert.ok(!existsSync(teamDefaultsFile(dir)));
  });

  test("a changed row its backend can't run is refused, naming the slot", async () => {
    const dir = agentDir();
    const body = on();
    body.coordinator.primary = { backend: "claude-code", model: "sonnet", effort: "max" };
    const result = await saveTeamDefaults(body, sources(), dir);
    assert.equal(result.status, 400);
    assert.match((result.body as { error: string }).error, /^Coordinator primary: sonnet doesn't take effort "max"/);
    assert.ok(!existsSync(teamDefaultsFile(dir)));
  });

  test("the monitor's fallback is checked too", async () => {
    const dir = agentDir();
    const body = on();
    body.monitor.fallback = { backend: "pi", model: "zai/not-a-model", effort: "high" };
    const result = await saveTeamDefaults(body, sources(), dir);
    assert.equal(result.status, 400);
    assert.match((result.body as { error: string }).error, /^Monitor fallback: zai\/not-a-model isn't offered by pi/);
  });

  test("a member that is off is still checked: its rows are what turning it on restores", async () => {
    const dir = agentDir();
    const body = on();
    body.monitor.enabled = false;
    body.monitor.primary = { backend: "claude-code", model: "sonnet", effort: "max" };
    const result = await saveTeamDefaults(body, sources(), dir);
    assert.equal(result.status, 400);
    assert.match((result.body as { error: string }).error, /^Monitor primary:/);
  });

  test("policy: a model off for subagents, or off altogether, saves with a warning per row", async () => {
    const dir = agentDir();
    const body = on();
    body.coordinator.fallback = sonnet;
    const policy: ModelPolicy = { ...EMPTY, disabledModels: ["opus[1m]"], subagentDisabledModels: ["haiku"] };
    const result = await saveTeamDefaults(body, sources({ policy: () => policy }), dir);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (result.status !== 200) return;
    assert.deepEqual(result.body.warnings, [
      "Coordinator primary: opus[1m] is turned off in Settings → Models; the team uses the fallback or isn't created",
      "Monitor primary: haiku is off for subagents in Settings → Models; the team uses the fallback or isn't created",
    ]);
    assert.ok(existsSync(teamDefaultsFile(dir)));
  });

  test("a row left as stored never blocks a save, even once its backend stops offering it", async () => {
    const dir = agentDir();
    const body = on();
    body.monitor.fallback = glm;
    assert.equal((await saveTeamDefaults(body, sources(), dir)).status, 200);
    body.coordinator.role = "lead";
    const result = await saveTeamDefaults(body, sources({ piModels: async () => [] }), dir);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (result.status !== 200) return;
    assert.deepEqual(result.body.warnings, ["Monitor fallback: zai/glm-5.3 isn't offered by pi"]);
    assert.equal(teamDefaultsInfo(dir).settings.coordinator.role, "lead");
  });

  test("a malformed stored file is never overwritten: 409, and its bytes stay", async () => {
    const dir = agentDir();
    writeFileSync(teamDefaultsFile(dir), "{ nope");
    const result = await saveTeamDefaults(on(), sources({ claudeModels: async () => { throw new Error("must not be asked"); } }), dir);
    assert.equal(result.status, 409);
    assert.match((result.body as { error: string }).error, /can't be read/);
    assert.equal(readFileSync(teamDefaultsFile(dir), "utf8"), "{ nope");
  });

  test("a backend that couldn't list its models saves unverified, one note for the backend", async () => {
    const dir = agentDir();
    const result = await saveTeamDefaults(on(), sources({ claudeModels: async () => { throw new Error("CLI missing"); } }), dir);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (result.status !== 200) return;
    assert.deepEqual(result.body.warnings, ["Not verified, because Claude Code couldn't list its models (CLI missing): Coordinator primary, Monitor primary"]);
  });
});
