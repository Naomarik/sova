import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { writeProviderLimits } from "./gate.ts";
import { applyGates, CLAUDE_PI_PROVIDER } from "./index.ts";

const tmpAgent = () => fs.mkdtempSync(path.join(os.tmpdir(), "provider-limits-index-"));
const model = (provider: string, api: string) => ({ id: "m", provider, api }) as any;
const slots = (dir: string, key: string) => {
	try {
		return fs.readdirSync(path.join(dir, "provider-limits", key, "slots")).filter((f) => f.endsWith(".json")).length;
	} catch {
		return 0;
	}
};

function fakePi() {
	const configs = new Map<string, { api?: string; streamSimple?: any }>();
	const registered: string[] = [];
	return {
		configs,
		registered,
		pi: {
			registerProvider(name: string, config: any) {
				registered.push(name);
				configs.set(name, { ...configs.get(name), ...config });
			},
		},
		registry: (models: any[]) => ({ getAll: () => models, getRegisteredProviderConfig: (p: string) => configs.get(p) as any }),
	};
}

test("each limited provider this runtime has is re-registered once, gated; others are left alone", () => {
	const dir = tmpAgent();
	writeProviderLimits(dir, { version: 1, limits: { zai: 5, "ollama-cloud": 10, absent: 2 } });
	const f = fakePi();
	const reg = f.registry([model("zai", "openai-completions"), model("ollama-cloud", "openai-completions"), model("openai-codex", "openai-codex-responses")]);
	assert.deepEqual(applyGates(f.pi, reg, () => dir).sort(), ["ollama-cloud", "zai"], "no models here: not registered; no limit: untouched");
	assert.equal(f.configs.get("zai")!.api, "openai-completions");
	assert.deepEqual(applyGates(f.pi, reg, () => dir), [], "already gated: nothing re-registered");
});

test("the claude-code limit wraps the stream the claude-code extension registered, counting under `claude-code`", async () => {
	const dir = tmpAgent();
	writeProviderLimits(dir, { version: 1, limits: { "claude-code": 1 } });
	const f = fakePi();
	let during = -1;
	const original = (m: any) => {
		during = slots(dir, "claude-code");
		const s = createAssistantMessageEventStream();
		queueMicrotask(() => {
			// A non-HTTP error that mentions a rate limit: the claude-code stream is never retried here.
			s.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: m.api, provider: m.provider, model: m.id, usage: {} as any, stopReason: "error", errorMessage: "rate limit", timestamp: 0 } });
			s.end();
		});
		return s;
	};
	f.configs.set(CLAUDE_PI_PROVIDER, { api: CLAUDE_PI_PROVIDER, streamSimple: original });
	const reg = f.registry([model(CLAUDE_PI_PROVIDER, CLAUDE_PI_PROVIDER)]);
	assert.deepEqual(applyGates(f.pi, reg, () => dir), [CLAUDE_PI_PROVIDER]);
	const gated = f.configs.get(CLAUDE_PI_PROVIDER)!.streamSimple;
	assert.notEqual(gated, original);
	const events = [];
	for await (const e of gated(model(CLAUDE_PI_PROVIDER, CLAUDE_PI_PROVIDER), { messages: [] })) events.push(e);
	assert.equal(during, 1, "the original stream ran holding one claude-code slot");
	assert.deepEqual(events.map((e: any) => e.type), ["error"], "passed through once, not re-queued");
	assert.equal(slots(dir, "claude-code"), 0);
	assert.deepEqual(applyGates(f.pi, reg, () => dir), [], "its own gated stream is never wrapped twice");
});
