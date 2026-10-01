// Real offline AgentSession lifecycle: mapped code naming is allowed after census, with unchanged prose.
import "../../claude-code/tests/hermetic-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jiti } from "../../subagents/tests/runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "ordinary-mapped-"));
const agentDir = path.join(scratch, "agent");
mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
symlinkSync(path.resolve(here, "../../spec"), path.join(agentDir, "extensions/spec"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
try {
	for (const variant of ["named", "none", "dirty", "unrelated"]) {
		const cwd = path.join(scratch, variant);
		const put = (rel, text) => { mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); writeFileSync(path.join(cwd, rel), text); };
		put(".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["src"], exclude: [] }, claims: { "§app/x": { kind: "behavior", requires: [], code: ["src/a.js"] }, "§app/y": { kind: "behavior", requires: [], code: ["src/b.js"] } } }));
		const prose = "# §app/x\n\nWarnings begin at 80%.\n";
		put(".sova/spec/claims/app/x.md", prose);
		put("src/a.js", "export const warningThreshold = 80;\n");
		put("src/b.js", "export const other = 1;\n");
		put(".sova/spec/claims/app/y.md", "# §app/y\n\nOther.\n");
		for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-qm", "base"]]) {
			const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
			assert.equal(r.status, 0, r.stderr);
		}
		if (variant === "dirty") put("src/a.js", "export const warningThreshold = 85;\n");
		const requests = [], steps = [];
		const streamSimple = (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			requests.push(JSON.stringify(context.messages));
			const step = steps.shift();
			assert.ok(step, "unexpected continuation");
			const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: step.command ? "toolUse" : "stop", timestamp: Date.now() };
			queueMicrotask(() => {
				options?.onPayload?.({});
				stream.push({ type: "start", partial: message });
				if (step.command) {
					message.content.push({ type: "toolCall", id: `c${requests.length}`, name: "bash", arguments: { command: step.command } });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
				} else {
					message.content.push({ type: "text", text: step.text });
					stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: message });
				}
				stream.push({ type: "done", reason: message.stopReason, message });
			});
			return stream;
		};
		const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, additionalExtensionPaths: [path.resolve(here, "../index.ts")], extensionFactories: [pi => pi.registerProvider("scripted", { baseUrl: "http://localhost", apiKey: "unused", api: "openai-completions", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }], streamSimple })] });
		await loader.reload();
		const manager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: SettingsManager.inMemory(), sessionManager: manager });
		try {
			await session.setModel(session.modelRuntime.getModel("scripted", "fixture"));
			await session.prompt("/mode spec on");
			steps.push({ command: "printf 'export const warningThreshold = 90;\\n' > src/a.js" }, { text: variant === "unrelated" ? "Edited.\nAlso changes: §app/y — false name" : variant === "none" ? "Edited.\nAlso changes: none" : "Edited.\nAlso changes: §app/x — warnings now begin at 90%" });
			await session.prompt("Raise the warning threshold to 90%.");
			assert.equal(requests.length, 2, "no corrective continuation");
			if (variant === "dirty") assert.doesNotMatch(requests[1], /\[spec census\] \d+ changed file/, "dirty baseline: no fresh-path census");
			else {
				assert.match(requests[1], /\[spec census\]/);
				assert.match(requests[1], /Foreign §: §app\/x/, "actual census reached the reply request");
			}
			const diff = spawnSync("git", ["-C", cwd, "diff", "--", ".sova/spec/claims/app/x.md"], { encoding: "utf8" });
			assert.equal(diff.stdout, "", "incumbent prose is intentionally unchanged");
			if (variant === "named" || variant === "dirty") {
				steps.push({ command: "printf 'export const warningThreshold = 95;\\n' > src/a.js" }, { text: "Edited again.\nAlso changes: §app/x — truthful repeated-path edit" });
				await session.prompt("Raise it again to 95%.");
				assert.equal(requests.length, 4, "repeated ordinary edit adds no continuation");
				assert.doesNotMatch(requests[3].split("Raise it again")[1] ?? "", /\[spec census\] \d+ changed file/, "no new fresh-path census");
			}
			steps.push({ text: "The code now says 90." });
			await session.prompt("What does the code say?");
			const warnings = manager.getBranch().filter(e => e.type === "custom_message" && e.customType === "spec-check" && /Your previous reply/.test(e.content));
			if (variant === "unrelated") {
				assert.equal(warnings.length, 1, "known unrelated claim is still rejected");
				assert.match(warnings[0].content, /§app\/y isn't changed by this diff/);
			} else {
				assert.deepEqual(warnings, [], `${variant}: no false extra warning persisted or delivered`);
				assert.doesNotMatch(requests.at(-1), /isn't changed by this diff/);
			}
		} finally { session.dispose(); }
	}
	console.log("ordinary-mapped: ok (named and none, real census lifecycle)");
} finally { rmSync(scratch, { recursive: true, force: true }); }
