// spec-mode.md's trusted-tools line (the `$core` shell prefix, minor.ts SPEC_CORE_SHELL): the prompt is the file
// byte for byte, minor.ts reads it from beside itself and refuses a malformed one, the line resolves the tools as
// spec-guard's coreDir does (SOVA_SPEC_CORE first, then the agent dir as pi resolves it), and only the short part
// carries it. Needs only minor.ts and spec-guard.ts, which Sova's engine reads too.
// Run: cd pi-config/extensions/mode && node --test spec-mode.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { buildMinorPrompt, SPEC_CORE_SHELL, SPEC_INSTRUCTIONS } from "./minor.ts";
import { coreDir } from "./spec-guard.ts";

test("spec: the prompt is spec-mode.md, byte for byte", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const canonical = readFileSync(join(here, "spec-mode.md"), "utf8");
	assert.equal(buildMinorPrompt("spec"), canonical.trimEnd(), "the only normalization is trimEnd");
	assert.ok(canonical.endsWith("\n") && !canonical.endsWith("\n\n"), "the file ends in exactly one newline");
	// The shell prefix is the file's one ```sh block, and appears nowhere else.
	assert.equal(canonical.match(/^```sh$/gm)?.length, 1);
	assert.ok(canonical.includes(`\`\`\`sh\n${SPEC_CORE_SHELL}\n\`\`\``));
	assert.equal(canonical.split(SPEC_CORE_SHELL).length, 2, "one occurrence");
});

test("spec: minor.ts reads its own spec-mode.md, from any cwd, and refuses a malformed one", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const canonical = readFileSync(join(here, "spec-mode.md"), "utf8");
	// A standalone copy of just these files (minor.ts and the prompt texts it reads), imported from an unrelated cwd.
	const load = (md: string) => {
		const dir = mkdtempSync(join(tmpdir(), "spec-mode-"));
		try {
			writeFileSync(join(dir, "minor.ts"), readFileSync(join(here, "minor.ts")));
			writeFileSync(join(dir, "spec-mode.md"), md);
			cpSync(join(here, "vis"), join(dir, "vis"), { recursive: true });
			const src = `import(${JSON.stringify(pathToFileURL(join(dir, "minor.ts")).href)}).then((m) => process.stdout.write(JSON.stringify([m.buildMinorPrompt("spec"), m.SPEC_CORE_SHELL])))`;
			return spawnSync(process.execPath, ["--input-type=module", "-e", src], { cwd: tmpdir(), encoding: "utf8" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	const ok = load(canonical);
	assert.equal(ok.status, 0, ok.stderr);
	assert.deepEqual(JSON.parse(ok.stdout), [canonical.trimEnd(), SPEC_CORE_SHELL]);
	const edited = load(canonical.replace("Trusted tools:", "Edited tools:"));
	assert.equal(edited.status, 0, edited.stderr);
	assert.match(JSON.parse(edited.stdout)[0], /^Edited tools:/m, "the text comes from the file, not a copy");
	const fence = `\`\`\`sh\n${SPEC_CORE_SHELL}\n\`\`\``;
	for (const [what, md] of [
		["no block", canonical.replace(fence, SPEC_CORE_SHELL)],
		["two blocks", canonical.replace(fence, `${fence}\n\n${fence}`)],
		["prefix repeated in prose", `${canonical}\n${SPEC_CORE_SHELL}\n`],
	]) {
		const bad = load(md);
		assert.notEqual(bad.status, 0, `${what}: loading fails`);
		assert.match(bad.stderr, /spec-mode\.md: /, `${what}: says why`);
	}
});

test("spec: the shell prefix resolves the agent dir the way pi does, after SOVA_SPEC_CORE", () => {
	const resolve = (env: Record<string, string>) =>
		spawnSync("bash", ["-c", `${SPEC_CORE_SHELL}; printf %s "$core"`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: "/h", ...env } }).stdout;
	assert.equal(resolve({}), "/h/.pi/agent/extensions/spec/core");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "" }), "/h/.pi/agent/extensions/spec/core", "empty is unset, as in getAgentDir");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "/abs/agent" }), "/abs/agent/extensions/spec/core");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "~/agent" }), "/h/agent/extensions/spec/core", "a leading ~ is home, as pi expands it");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "~" }), "/h/extensions/spec/core");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "/a/~b" }), "/a/~b/extensions/spec/core", "only a leading ~ expands");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "~other/agent" }), "~other/agent/extensions/spec/core", "~user is not home: pi expands only ~ and ~/");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "~other" }), "~other/extensions/spec/core");
	// Sova names each local chat's own copy of the tools; it wins over the agent dir's, and empty is unset.
	assert.equal(resolve({ SOVA_SPEC_CORE: "/gen/abc/pi-config/extensions/spec/core", PI_CODING_AGENT_DIR: "/abs/agent" }), "/gen/abc/pi-config/extensions/spec/core");
	assert.equal(resolve({ SOVA_SPEC_CORE: "", PI_CODING_AGENT_DIR: "/abs/agent" }), "/abs/agent/extensions/spec/core");
	// spec-guard's coreDir (the census, the pi worker's hook) agrees with the line in every case.
	for (const env of [{}, { PI_CODING_AGENT_DIR: "" }, { PI_CODING_AGENT_DIR: "/abs/agent" }, { PI_CODING_AGENT_DIR: "~/agent" }, { PI_CODING_AGENT_DIR: "~" }, { SOVA_SPEC_CORE: "/own/core" }, { SOVA_SPEC_CORE: "/own/core", PI_CODING_AGENT_DIR: "~/a" }, { SOVA_SPEC_CORE: "", PI_CODING_AGENT_DIR: "/x" }] as Record<string, string>[])
		assert.equal(coreDir(env, "/h"), resolve(env), JSON.stringify(env));
});

test("spec: the trusted-tools line rides the short part only, in its exact words", () => {
	const short = buildMinorPrompt("spec");
	const here = dirname(fileURLToPath(import.meta.url));
	const writing = readFileSync(join(here, "../spec/WRITING.md"), "utf8").trimEnd();
	assert.ok(short.includes(`start each bash command with exactly this, never a guessed path:\n\n\`\`\`sh\n${SPEC_CORE_SHELL}\n\`\`\``));
	assert.ok(!writing.includes(SPEC_CORE_SHELL), "the shell line is the short part's alone (minor.ts reads it there)");
	assert.equal(SPEC_INSTRUCTIONS, short, "the prompt is the loaded text");
});
