import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import visionDelegate from "./index.ts";
import { SETTINGS_FILE } from "./settings.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

/** Wires the extension against a fake registry and a throwaway agent dir. */
function harness(options: { vision?: boolean; fallbacks?: string[]; complete?: () => Promise<any> } = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "vision-agent-"));
	writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ fallbacks: options.fallbacks ?? ["seer/eye"], contextChars: 200 }));
	const tools = new Map<string, any>();
	const events = new Map<string, any>();
	const notices: any[] = [];
	const requests: any[] = [];
	const catalog = [
		{ provider: "seer", id: "eye", name: "Eye", input: ["text", "image"] },
		{ provider: "blind", id: "ear", name: "Ear", input: ["text"] },
	];
	const ctx: any = {
		cwd: agentDir,
		mode: "tui",
		hasUI: true,
		model: options.vision ? catalog[0] : catalog[1],
		sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: "earlier turn" }] } }] },
		modelRegistry: {
			find: (provider: string, id: string) => catalog.find(m => m.provider === provider && m.id === id),
			complete: async (model: any, context: any, opts: any) => {
				requests.push({ model, context, opts });
				return options.complete ? await options.complete() : { content: [{ type: "text", text: "a red error dialog" }] };
			},
		},
		ui: { notify: (...a: any[]) => notices.push(a) },
	};
	visionDelegate({
		registerTool: (t: any) => tools.set(t.name, t),
		on: (name: string, handler: any) => events.set(name, handler),
	} as any, { agentDir });
	return {
		agentDir, ctx, tools, notices, requests,
		call: (params: any) => tools.get("look_at_image").execute("id", params, undefined, () => {}, ctx),
		event: (name: string, data: any) => events.get(name)(data, ctx),
		image: (name = "shot.png") => {
			const path = join(agentDir, name);
			writeFileSync(path, PNG);
			return path;
		},
	};
}

test("the tool sends the image plus conversation context and attributes the answer", async () => {
	const h = harness();
	const result = await h.call({ path: h.image(), question: "what does the error say?" });
	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].text, "[via seer/eye]\na red error dialog");
	assert.equal(result.details.model, "seer/eye");
	const [request] = h.requests;
	assert.equal(request.model.id, "eye");
	const [prompt, image] = request.context.messages[0].content;
	assert.match(prompt.text, /Question: what does the error say\?/);
	assert.match(prompt.text, /User: earlier turn/);
	assert.equal(image.type, "image");
	assert.equal(image.mimeType, "image/png");
	assert.equal(image.data, PNG.toString("base64"));
	assert.equal(request.opts.cacheRetention, "none");
});

test("relative paths resolve against the working directory", async () => {
	const h = harness();
	h.image("nested.png");
	const result = await h.call({ path: "nested.png", question: "what is this?" });
	assert.equal(result.isError, undefined);
	assert.equal(h.requests.length, 1);
});

test("unsupported extensions and unreadable files fail cleanly without a model call", async () => {
	const h = harness();
	writeFileSync(join(h.agentDir, "notes.txt"), "hi");
	let result = await h.call({ path: "notes.txt", question: "?" });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Not a supported image file: notes\.txt/);
	result = await h.call({ path: "absent.png", question: "?" });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Could not read absent\.png/);
	assert.deepEqual(h.requests, []);
});

test("delegation still works on a vision model but says the detour was unnecessary", async () => {
	const h = harness({ vision: true });
	const result = await h.call({ path: h.image(), question: "what is this?" });
	assert.equal(result.isError, undefined);
	assert.match(result.content[0].text, /could have read this file directly/);
});

test("no usable fallback is an explicit tool error naming the settings file", async () => {
	const h = harness({ fallbacks: ["blind/ear", "gone/missing"] });
	const result = await h.call({ path: h.image(), question: "?" });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /No vision model available/);
	assert.match(result.content[0].text, /blind\/ear \(does not accept image input\)/);
	assert.match(result.content[0].text, /vision-delegate\.json/);
	assert.deepEqual(h.requests, []);
});

test("a read result with images is prefixed with a description and keeps the image blocks", async () => {
	const h = harness();
	const content = [{ type: "text", text: "Read /tmp/shot.png" }, { type: "image", data: "AAAA", mimeType: "image/png" }];
	const patch = await h.event("tool_result", { toolName: "read", content });
	assert.equal(patch.content.length, 3);
	assert.equal(patch.content[0].text, "[image described by seer/eye]\na red error dialog");
	assert.deepEqual(patch.content.slice(1), content);
	assert.equal(h.requests[0].context.messages[0].content[0].text.startsWith("Describe this image precisely"), true);
});

test("read results are left alone for other tools, imageless results, and vision models", async () => {
	const withImage = [{ type: "image", data: "AAAA", mimeType: "image/png" }];
	const h = harness();
	assert.equal(await h.event("tool_result", { toolName: "bash", content: withImage }), undefined);
	assert.equal(await h.event("tool_result", { toolName: "read", content: [{ type: "text", text: "plain file" }] }), undefined);
	const seeing = harness({ vision: true });
	assert.equal(await seeing.event("tool_result", { toolName: "read", content: withImage }), undefined);
	assert.deepEqual(h.requests, []);
	assert.deepEqual(seeing.requests, []);
});

test("attached input images are described in place, capped at three, and never dropped", async () => {
	const h = harness();
	const images = Array.from({ length: 5 }, (_, i) => ({ type: "image", data: `IMG${i}`, mimeType: "image/png" }));
	const patch = await h.event("input", { source: "interactive", text: "look at these", images });
	assert.equal(patch.action, "transform");
	assert.equal(patch.images, images, "original image data must survive a later switch to a vision model");
	assert.match(patch.text, /^look at these\n\n/);
	assert.equal(h.requests.length, 3);
	assert.deepEqual(h.requests.map(r => r.context.messages[0].content[1].data), ["IMG0", "IMG1", "IMG2"]);
	assert.match(patch.text, /\[image 1\/3 described by seer\/eye\][\s\S]*\[image 3\/3 described by seer\/eye\]/);
	assert.match(patch.text, /2 further image\(s\) in this message were not described/);
});

test("input without images, from extensions, or on a vision model is untouched", async () => {
	const h = harness();
	const images = [{ type: "image", data: "AAAA", mimeType: "image/png" }];
	assert.equal(await h.event("input", { source: "interactive", text: "hi" }), undefined);
	assert.equal(await h.event("input", { source: "extension", text: "hi", images }), undefined);
	const seeing = harness({ vision: true });
	assert.equal(await seeing.event("input", { source: "interactive", text: "hi", images }), undefined);
	assert.deepEqual(h.requests, []);
});

test("both hooks fail soft: a delegation error warns and passes the content through", async () => {
	const failing = { complete: async () => { throw new Error("provider down"); } };
	const h = harness(failing);
	const content = [{ type: "image", data: "AAAA", mimeType: "image/png" }];
	assert.equal(await h.event("tool_result", { toolName: "read", content }), undefined);
	assert.equal(await h.event("input", { source: "interactive", text: "hi", images: content }), undefined);
	assert.deepEqual(h.notices.map(n => n[1]), ["warning", "warning"]);
	assert.match(h.notices[0][0], /could not describe the image in this read result \(provider down\)/);
	assert.match(h.notices[1][0], /could not describe the attached image\(s\) \(provider down\)/);
	// An empty answer is a failure too, not an empty description.
	const silent = harness({ complete: async () => ({ content: [] }) });
	assert.equal(await silent.event("tool_result", { toolName: "read", content }), undefined);
	assert.match(silent.notices[0][0], /returned no text/);
});
