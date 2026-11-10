import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_TEAM_DEFAULTS,
	TEAM_DEFAULTS_FILE_NAME,
	defaultAgentDir,
	describeTeamDefaults,
	effectiveTeamDefaults,
	parseTeamDefaults,
	readTeamDefaults,
	teamDefaultsPath,
	writeTeamDefaults,
} from "./team-defaults.ts";

/** The pinned contract, byte for byte as the Settings side writes it. */
const CONTRACT = `{"version":1,
 "coordinator":{"role":"coordinator","primary":{"backend":"claude-code","model":"claude-opus-5-5","effort":"medium"},"fallback":null,"instructions":""},
 "monitor":{"role":"monitor","primary":{"backend":"pi","model":"ollama-cloud/deepseek-v4.1-flash","effort":"low"},"fallback":{"backend":"claude-code","model":"claude-sonnet-5-5","effort":"low"},"contextPct":60,"everyMinutes":10,"usage":{"enabled":true,"pausePct":90,"resumeMarginMinutes":5},"instructions":""},
 "handover":{"retireTimeoutMinutes":10}}`;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-team-defaults-"));

test("team-defaults.ts imports only node built-ins and the Claude catalog (which imports nothing), so Sova's server can import it", () => {
	const source = fs.readFileSync(fileURLToPath(new URL("./team-defaults.ts", import.meta.url)), "utf8");
	const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
	assert.ok(specifiers.length > 0);
	for (const s of specifiers) if (s !== "../claude-code/catalog.ts") assert.match(s, /^node:/, `${s} is not a node built-in`);
	const catalog = fs.readFileSync(fileURLToPath(new URL("../claude-code/catalog.ts", import.meta.url)), "utf8");
	assert.doesNotMatch(catalog, /^import\s/m, "the catalog imports nothing");
});

test("the pinned contract parses to exactly itself, and equals the built-in defaults", () => {
	const parsed = parseTeamDefaults(CONTRACT);
	assert.ok(parsed.ok, JSON.stringify(parsed));
	assert.deepEqual(parsed.value, JSON.parse(CONTRACT));
	assert.deepEqual(parsed.value, DEFAULT_TEAM_DEFAULTS);
});

test("missing keys take the defaults; stated keys win", () => {
	const parsed = parseTeamDefaults({ version: 1, monitor: { contextPct: 75, usage: { pausePct: 95 } }, coordinator: { primary: { backend: "pi", model: "openai-codex/gpt-6" } } });
	assert.ok(parsed.ok, JSON.stringify(parsed));
	assert.equal(parsed.value.monitor.contextPct, 75);
	assert.equal(parsed.value.monitor.usage.pausePct, 95);
	assert.equal(parsed.value.monitor.usage.resumeMarginMinutes, 5, "a sibling key in a stated object still defaults");
	assert.deepEqual(parsed.value.coordinator.primary, { backend: "pi", model: "openai-codex/gpt-6" }, "a stated tuple is taken whole, effort absent");
	assert.equal(parsed.value.coordinator.role, "coordinator");
	assert.equal(parsed.value.handover.retireTimeoutMinutes, 10);
});

test("strict: every error is reported, none is repaired, and no value comes back", () => {
	const parsed = parseTeamDefaults({
		version: 2,
		extra: true,
		coordinator: { enabled: "yes", role: "ag_07", primary: { backend: "ollama", model: "" }, fallback: { backend: "pi", model: "no-slash", effort: "turbo" } },
		monitor: { role: "Coordinator", contextPct: 0, everyMinutes: 2000, usage: { pausePct: 101, typo: 1 }, instructions: 42 },
		handover: { retireTimeoutMinutes: -1 },
	});
	assert.equal(parsed.ok, false);
	if (parsed.ok) return;
	const expected = [
		/^extra: unknown key/, /^version: must be 1/, /^coordinator\.enabled: must be true or false/, /^coordinator\.role: looks like a worker ID/,
		/^coordinator\.primary\.backend: must be one of pi, claude-code/, /^coordinator\.primary\.model: must be a non-blank string/,
		/^coordinator\.fallback\.model: a pi model must be provider\/id/, /^coordinator\.fallback\.effort: must be one of/,
		/^monitor\.usage\.typo: unknown key/, /^monitor\.contextPct: must be a number from 1 to 100/, /^monitor\.everyMinutes: must be a number from 1 to 1440/,
		/^monitor\.usage\.pausePct: must be a number from 1 to 100/, /^monitor\.instructions: must be a string/, /^handover\.retireTimeoutMinutes: must be a number from 1 to 1440/,
	];
	for (const re of expected) assert.ok(parsed.errors.some((e) => re.test(e)), `missing ${re}: ${parsed.errors.join(" | ")}`);
	// The monitor role clashes with the (defaulted) coordinator role only case-insensitively here.
	const clash = parseTeamDefaults({ version: 1, monitor: { role: "COORDINATOR" } });
	assert.equal(clash.ok, false);
	assert.match(!clash.ok ? clash.errors.join() : "", /monitor\.role: must differ from coordinator\.role/);
	assert.match((parseTeamDefaults("{not json") as { errors: string[] }).errors[0], /^not valid JSON/);
	assert.match((parseTeamDefaults([]) as { errors: string[] }).errors[0], /must be an object/);
	assert.match((parseTeamDefaults({ version: 1, coordinator: { instructions: "a\u0007b" } }) as { errors: string[] }).errors.join(), /control characters/);
	assert.ok(parseTeamDefaults({ version: 1, coordinator: { instructions: "line one\n\tline two" } }).ok, "instructions keep newlines and tabs");
});

test("readTeamDefaults: absent, malformed (never rewritten) and ok", () => {
	const dir = tempDir();
	try {
		assert.deepEqual(readTeamDefaults(dir), { state: "absent", file: path.join(dir, TEAM_DEFAULTS_FILE_NAME) });
		const file = teamDefaultsPath(dir);
		fs.writeFileSync(file, '{"version":1,"monitor":{"contextPct":"sixty"}}');
		const before = fs.readFileSync(file, "utf8");
		const bad = readTeamDefaults(dir);
		assert.equal(bad.state, "malformed");
		assert.match(bad.state === "malformed" ? bad.errors.join() : "", /monitor\.contextPct/);
		assert.equal(fs.readFileSync(file, "utf8"), before, "a reader never touches the file");
		fs.writeFileSync(file, CONTRACT);
		const ok = readTeamDefaults(dir);
		assert.equal(ok.state, "ok");
		assert.deepEqual(ok.state === "ok" ? ok.value : undefined, DEFAULT_TEAM_DEFAULTS);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("writeTeamDefaults writes atomically, normalizes, and refuses an invalid value without touching the old file", () => {
	const dir = tempDir();
	try {
		const agentDir = path.join(dir, "agent");
		const written = writeTeamDefaults(agentDir, { version: 1, monitor: { everyMinutes: 15 } });
		assert.equal(written.monitor.everyMinutes, 15);
		assert.deepEqual(JSON.parse(fs.readFileSync(teamDefaultsPath(agentDir), "utf8")), written, "the normalized value is what lands");
		const before = fs.readFileSync(teamDefaultsPath(agentDir), "utf8");
		assert.throws(() => writeTeamDefaults(agentDir, { version: 1, monitor: { everyMinutes: 0 } }), /Refusing to write team-defaults\.json: monitor\.everyMinutes/);
		assert.equal(fs.readFileSync(teamDefaultsPath(agentDir), "utf8"), before);
		assert.deepEqual(fs.readdirSync(agentDir), [TEAM_DEFAULTS_FILE_NAME], "no temp file is left behind");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("defaultAgentDir follows PI_CODING_AGENT_DIR with ~ expansion, else ~/.pi/agent", () => {
	assert.equal(defaultAgentDir({}), path.join(os.homedir(), ".pi", "agent"));
	assert.equal(defaultAgentDir({ PI_CODING_AGENT_DIR: "/srv/agent" }), "/srv/agent");
	assert.equal(defaultAgentDir({ PI_CODING_AGENT_DIR: "~/x/agent" }), path.join(os.homedir(), "x/agent"));
});

test("a saved enabled is accepted when boolean and ignored: it is not part of the value, and false turns nothing off", () => {
	const parsed = parseTeamDefaults({ version: 1, coordinator: { enabled: false }, monitor: { enabled: false } });
	assert.ok(parsed.ok, JSON.stringify(parsed));
	assert.deepEqual(parsed.value, parseTeamDefaults({ version: 1, coordinator: {}, monitor: {} }).value, "the same value as without the key");
	assert.equal("enabled" in parsed.value.coordinator || "enabled" in parsed.value.monitor, false);
	assert.equal(parsed.value.monitor.usage.enabled, true, "the usage pause's own switch stays");
	assert.equal(parseTeamDefaults({ version: 1, monitor: { usage: { enabled: false } } }).ok && parseTeamDefaults({ version: 1, monitor: { usage: { enabled: false } } }).value?.monitor.usage.enabled, false);
});

const chat = { backend: "pi" as const, model: "test/model", effort: "high" as const };

test("effectiveTeamDefaults always gives a full value: no settings or malformed ones put both roles on the chat's own model with the built-ins", () => {
	for (const state of [{ state: "absent", file: "/a/team-defaults.json" } as const, { state: "malformed", file: "/a/t.json", errors: ["x: bad"] } as const]) {
		const now = effectiveTeamDefaults(state, chat);
		assert.equal(now.chatsOwn, true, state.state);
		assert.deepEqual(now.value.coordinator, { ...DEFAULT_TEAM_DEFAULTS.coordinator, primary: chat, fallback: null });
		assert.deepEqual(now.value.monitor, { ...DEFAULT_TEAM_DEFAULTS.monitor, primary: chat, fallback: null });
		assert.deepEqual([now.value.monitor.contextPct, now.value.monitor.everyMinutes, now.value.monitor.usage, now.value.handover], [60, 10, { enabled: true, pausePct: 90, resumeMarginMinutes: 5 }, { retireTimeoutMinutes: 10 }]);
	}
	assert.equal(effectiveTeamDefaults({ state: "absent", file: "/a" }, chat).warning, undefined);
	assert.match(effectiveTeamDefaults({ state: "malformed", file: "/a/t.json", errors: ["x: bad", "y: worse"] }, chat).warning ?? "", /^Warning: \/a\/t\.json is malformed \(x: bad; y: worse\), so this team's coordinator and monitor run on this chat's own model/);
	const ok = effectiveTeamDefaults({ state: "ok", file: "/a/t.json", value: DEFAULT_TEAM_DEFAULTS }, chat);
	assert.deepEqual([ok.chatsOwn, ok.value, ok.warning], [false, DEFAULT_TEAM_DEFAULTS, undefined], "named settings are used as they are");
});

test("describeTeamDefaults names both roles and the model each uses, never says off", () => {
	const absent = describeTeamDefaults(effectiveTeamDefaults({ state: "absent", file: "/a/team-defaults.json" }, chat));
	assert.match(absent, /^Team defaults: no file at \/a\/team-defaults\.json, so both roles use this chat's own model with Sova's built-in values:/);
	assert.match(absent, /Every team gets this coordinator and monitor from Sova; the chat names only the workers\./);
	assert.match(absent, /Coordinator: role "coordinator", this chat's own model \(pi · test\/model · high\)/);
	assert.match(absent, /Monitor: role "monitor", this chat's own model \(pi · test\/model · high\)/);
	assert.match(absent, /every 10 min · wrap-up at 60% context · usage pause at 90%, resume 5 min after reset/);
	const malformed = describeTeamDefaults(effectiveTeamDefaults({ state: "malformed", file: "/a/t.json", errors: ["x: bad", "y: worse"] }, chat));
	assert.match(malformed, /\/a\/t\.json is malformed .*this chat's own model/);
	assert.match(malformed, /- x: bad\n {2}- y: worse\n/);
	const on = describeTeamDefaults(effectiveTeamDefaults({ state: "ok", file: "/a/t.json", value: DEFAULT_TEAM_DEFAULTS }, chat));
	assert.match(on, /Coordinator: role "coordinator", primary claude-code · claude-opus-5-5 · medium, fallback none/);
	assert.match(on, /Monitor: role "monitor", primary pi · ollama-cloud\/deepseek-v4\.1-flash · low, fallback claude-code · claude-sonnet-5-5 · low/);
	assert.match(on, /after 10 min/);
	for (const text of [absent, malformed, on]) assert.doesNotMatch(text, /\boff\b/);
});
