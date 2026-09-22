/**
 * vision-delegate: lets a text-only model work with images.
 *
 * Pi's transport drops image blocks for models whose `input` lacks "image", so a
 * session on glm-5.3 or a Codex model simply never sees a screenshot. This
 * extension routes the pixels to a small vision model instead and puts its words
 * back into the conversation:
 *
 *   - look_at_image  — explicit: ask a question about a file on disk (only offered to text-only models).
 *   - read           — a read tool result carrying images is prefixed with a description.
 *   - input          — images attached in the TUI are described before the turn starts.
 *
 * Image data is never dropped, only described alongside: switching to a vision
 * model with /model later must still show the original attachment.
 *
 * Fallback order, exhaustion threshold and context budget live in
 * ~/.pi/agent/vision-delegate.json (see settings.ts).
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	answerText,
	AUTO_DESCRIBE_PROMPT,
	buildQuestionPrompt,
	conversationExcerpt,
	describedBy,
	imageBlocks,
	IMAGE_MIME,
	MAX_IMAGES,
	mimeForPath,
	ref,
	skippedNote,
	viaLine,
	type ImageBlock,
} from "./describe.ts";
import { globallyEnabled, readPolicy } from "../model-policy/policy.ts";
import { describeSkipped, pickVisionModel, readUsage, type PickableModel, type VisionPick } from "./picker.ts";
import { loadSettings } from "./settings.ts";

class DelegationError extends Error {}

function activeModelSeesImages(ctx: ExtensionContext): boolean {
	return Boolean(ctx.model?.input?.includes("image"));
}

/**
 * Offer look_at_image only while the model cannot see images. Merges the one name
 * in or out of the live active set and writes nothing when it is already right;
 * never snapshots or replaces the list, so mode's strict-mode snapshot/restore
 * stays the only writer that does, and a restore self-heals on the next call.
 */
function gate(pi: ExtensionAPI, model: ExtensionContext["model"]) {
	const active = pi.getActiveTools();
	const want = !model?.input?.includes("image");
	if (active.includes("look_at_image") === want) return;
	pi.setActiveTools(want ? [...active, "look_at_image"] : active.filter((n) => n !== "look_at_image"));
}

/**
 * Send images plus a prompt to the best available vision model.
 * Throws DelegationError with an explanatory message when no model can be used.
 */
async function delegate(ctx: ExtensionContext, agentDir: string, images: ImageBlock[], prompt: string): Promise<{ answer: string; model: PickableModel; pick: VisionPick }> {
	const settings = loadSettings(agentDir);
	// Re-read per call: the usage cache is refreshed out-of-band every ~3 minutes.
	const policy = readPolicy();
	const pick = pickVisionModel(settings, (provider, id) => ctx.modelRegistry.find(provider, id), readUsage(), (ref) =>
		globallyEnabled(policy, "pi", ref),
	);
	if (!pick.model) {
		throw new DelegationError(
			`No vision model available. Candidates: ${describeSkipped(pick.skipped) || "none configured"}. Set "fallbacks" in ~/.pi/agent/vision-delegate.json.`,
		);
	}
	const model = ctx.modelRegistry.find(pick.model.provider, pick.model.id)!;
	const response = await ctx.modelRegistry.complete(
		model,
		{ messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...images], timestamp: Date.now() }] },
		{ cacheRetention: "none", sessionId: uuidv7(), signal: ctx.signal },
	);
	const answer = answerText(response.content);
	if (!answer) throw new DelegationError(`${ref(pick.model)} returned no text for this image.`);
	return { answer, model: pick.model, pick };
}

/** Describe up to MAX_IMAGES blocks, one call each, as an attributed text block. */
async function describeAll(ctx: ExtensionContext, agentDir: string, images: ImageBlock[]): Promise<string> {
	const used = images.slice(0, MAX_IMAGES);
	const parts: string[] = [];
	for (const [index, image] of used.entries()) {
		const { answer, model } = await delegate(ctx, agentDir, [image], AUTO_DESCRIBE_PROMPT);
		parts.push(`${describedBy(model, index, used.length)}\n${answer}`);
	}
	return parts.join("\n\n") + skippedNote(images.length - used.length);
}

/** `options` exists for tests; pi calls the default export with the API alone. */
export default function visionDelegate(pi: ExtensionAPI, options: { agentDir?: string } = {}) {
	const agentDir = () => options.agentDir ?? getAgentDir();
	pi.registerTool({
		name: "look_at_image",
		label: "Look at Image",
		description:
			"Ask a vision model about an image file on disk (png, jpg, webp, gif, bmp) and get its answer as text. Only for models that cannot see images — if the current model accepts image input, read the file directly with the read tool instead; this tool refuses. You will know you cannot see images because tool results and attachments then carry a note saying the current model does not support images. The delegate answers only from the picture plus a short excerpt of this conversation; it cannot run tools or see the repository.",
		promptSnippet: "Ask a vision model a question about an image file",
		promptGuidelines: [
			"Use look_at_image whenever an image is relevant and the current model cannot view images — you will have seen a note such as '[Current model does not support images]'.",
			"Ask look_at_image one specific question per call (what the error says, what the layout is) instead of requesting a generic description.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the image file, absolute or relative to the working directory" }),
			question: Type.String({ description: "What to find out about the image" }),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const path = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
			if (activeModelSeesImages(ctx)) {
				return {
					content: [{ type: "text" as const, text: `look_at_image is only for models that cannot see images. The current model accepts image input, so read the file directly with the read tool instead: ${path}` }],
					isError: true,
					details: {},
				};
			}
			const mimeType = mimeForPath(path);
			if (!mimeType) {
				return {
					content: [{ type: "text" as const, text: `Not a supported image file: ${params.path}. Supported extensions: ${Object.keys(IMAGE_MIME).join(", ")}.` }],
					isError: true,
					details: {},
				};
			}
			let data: string;
			try {
				data = (await readFile(path)).toString("base64");
			} catch (error) {
				return { content: [{ type: "text" as const, text: `Could not read ${params.path}: ${(error as Error).message}` }], isError: true, details: {} };
			}
			const settings = loadSettings(agentDir());
			// getBranch() is the active conversation; extensions have no other reader for it.
			const excerpt = conversationExcerpt(ctx.sessionManager.getBranch(), settings.contextChars);
			try {
				const { answer, model, pick } = await delegate(ctx, agentDir(), [{ type: "image", data, mimeType }], buildQuestionPrompt(params.question, excerpt));
				return {
					content: [{ type: "text" as const, text: `${viaLine(model, pick)}\n${answer}` }],
					details: { model: ref(model), path, overBudget: pick.overBudget, skipped: pick.skipped },
				};
			} catch (error) {
				return { content: [{ type: "text" as const, text: `Vision delegation failed: ${(error as Error).message}` }], isError: true, details: {} };
			}
		},
	});

	// before_agent_start fires once per user prompt with a live ctx.model: the
	// authoritative gate. model_select only makes a /model switch show at once; a
	// switch mid-run leaves the tool offered for the rest of that run, which is why
	// execute still refuses on a vision model.
	pi.on("before_agent_start", (_event, ctx) => gate(pi, ctx.model));
	pi.on("model_select", (event) => gate(pi, event.model));

	// Automatic path 1: a read tool result that carries images the active model
	// cannot see. The image blocks stay in place — the transport strips them for
	// this model, and a later /model switch to a vision model still has them.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read" || activeModelSeesImages(ctx)) return;
		const images = imageBlocks(event.content as unknown[]);
		if (!images.length) return;
		try {
			return { content: [{ type: "text" as const, text: await describeAll(ctx, agentDir(), images) }, ...event.content] };
		} catch (error) {
			notify(ctx, `vision-delegate: could not describe the image in this read result (${(error as Error).message}).`);
			return;
		}
	});

	// Automatic path 2: images attached to user input in the TUI. Extension-sent
	// messages are skipped so a description never re-enters this hook.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || activeModelSeesImages(ctx)) return;
		const images = imageBlocks(event.images as unknown[]);
		if (!images.length) return;
		try {
			const described = await describeAll(ctx, agentDir(), images);
			return { action: "transform" as const, text: `${event.text}\n\n${described}`, images: event.images };
		} catch (error) {
			notify(ctx, `vision-delegate: could not describe the attached image(s) (${(error as Error).message}).`);
			return;
		}
	});
}

function notify(ctx: ExtensionContext, message: string) {
	// Fail soft everywhere: a delegation problem must never lose the user's content.
	try {
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
	} catch {
		/* Session replacement can invalidate the UI. */
	}
}
