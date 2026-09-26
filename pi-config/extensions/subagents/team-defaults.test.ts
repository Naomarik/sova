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
	parseTeamDefaults,
	readTeamDefaults,
	teamDefaultsPath,
	writeTeamDefaults,
} from "./team-defaults.ts";

/** The pinned contract, byte for byte as the Settings side writes it. */
const CONTRACT = `{"version":1,
 "coordinator":{"enabled":true,"role":"coordinator","primary":{"backend":"claude-code","model":"opus[1m]","effort":"medium"},"fallback":null,"instructions":""},
 "monitor":{"enabled":true,"role":"monitor","primary":{"backend":"claude-code","model":"haiku","effort":"medium"},"fallback":null,"contextPct":60,"everyMinutes":10,"usage":{"enabled":true,"pausePct":90,"resumeMarginMinutes":5},"instructions":""},
 "handover":{"retireTimeoutMinutes":10}}`;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-team-defaults-"));

test("team-defaults.ts imports only node built-ins, so Sova's server can import it", () => {
	const source = fs.readFileSync(fileURLToPath(new URL("./team-defaults.ts", import.meta.url)), "utf8");
	const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
	assert.ok(specifiers.length > 0);
	for (const s of specifiers) assert.match(s, /^node:/, `${s} is not a node built-in`);
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

test("describeTeamDefaults says off, malformed (with every error) or the effective values", () => {
	assert.match(describeTeamDefaults({ state: "absent", file: "/a/team-defaults.json" }), /^Team defaults: off \(no file at \/a\/team-defaults\.json\)/);
	const malformed = describeTeamDefaults({ state: "malformed", file: "/a/t.json", errors: ["x: bad", "y: worse"] });
	assert.match(malformed, /off — \/a\/t\.json is malformed/);
	assert.match(malformed, /- x: bad\n {2}- y: worse$/);
	const on = describeTeamDefaults({ state: "ok", file: "/a/t.json", value: DEFAULT_TEAM_DEFAULTS });
	assert.match(on, /Coordinator: on — role "coordinator", primary claude-code · opus\[1m\] · medium, fallback none/);
	assert.match(on, /Monitor: on — role "monitor", primary claude-code · haiku · medium/);
	assert.match(on, /every 10 min · wrap-up at 60% context · usage pause at 90%, resume 5 min after reset/);
	assert.match(on, /after 10 min/);
	const off = describeTeamDefaults({ state: "ok", file: "/a/t.json", value: { ...DEFAULT_TEAM_DEFAULTS, coordinator: { ...DEFAULT_TEAM_DEFAULTS.coordinator, enabled: false } } });
	assert.match(off, /Coordinator: off/);
});
