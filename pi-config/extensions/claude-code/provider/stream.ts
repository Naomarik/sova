/**
 * Pure adapter: one assistant message worth of Claude CLI frames in, one
 * pi-ai AssistantMessageEventStream out. No process, file system or CLI here —
 * the frames arrive from a ClaudeSessionBridge, so this module is fully
 * testable against recorded fixtures.
 */
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Api,
	calculateCost,
	collapseSystemMessages,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type JsonObject,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	type ClaudeFrame,
	type ClaudeSessionBridge,
	type ClaudeTurnPayload,
	type ClaudeUsage,
	ClaudeProtocolError,
	toPiToolName,
} from "./types.ts";

/** Anthropic stop reasons the CLI passes through, mapped onto pi's ladder. */
function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
		case "pause_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "error";
	}
}

/** The CLI `--effort` value for a pi thinking level, via the model's map. */
export function resolveClaudeEffort(model: Model<Api>, reasoning: string | undefined): string | undefined {
	if (!reasoning) return undefined; // "off" arrives as undefined.
	const mapped = model.thinkingLevelMap?.[reasoning as keyof NonNullable<Model<Api>["thinkingLevelMap"]>];
	return typeof mapped === "string" ? mapped : undefined;
}

function emptyUsage(): AssistantMessage["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function abortError(): Error {
	const error = new Error("Claude Code request was aborted");
	error.name = "AbortError";
	return error;
}

/**
 * Iterate `source` but settle as soon as `signal` aborts, closing the source.
 * The bridge also receives the signal; this only bounds a bridge that is slow
 * to notice it.
 */
async function* untilAborted<T>(source: AsyncIterable<T>, signal: AbortSignal | undefined): AsyncGenerator<T> {
	const iterator = source[Symbol.asyncIterator]();
	let aborted: Promise<never> | undefined;
	let onAbort: (() => void) | undefined;
	if (signal) {
		aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(abortError());
			signal.addEventListener("abort", onAbort, { once: true });
		});
		aborted.catch(() => { /* handled by the race below; keeps this from being unhandled */ });
	}
	try {
		for (;;) {
			if (signal?.aborted) throw abortError();
			const next = aborted ? await Promise.race([iterator.next(), aborted]) : await iterator.next();
			if (next.done) return;
			yield next.value;
		}
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		// Never awaited: a bridge suspended on its own await would otherwise
		// keep this turn (and the test event loop) alive forever. The bridge
		// holds the same signal and owns its process cleanup.
		void Promise.resolve(iterator.return?.()).catch(() => { /* bridge-owned cleanup */ });
	}
}

/** Mutable per-block state; `index` is the CLI's content index, not pi's. */
type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };

/**
 * Run one assistant message through `bridge` and map its frames to pi-ai events.
 * `options.onPayload` may replace the request before it reaches the bridge;
 * `options.onResponse` is invoked once, when the CLI's first frame arrives.
 */
export function streamClaudeCode(
	bridge: ClaudeSessionBridge,
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	// The CLI takes one system prompt for the process, so fold later system
	// messages into the leading one rather than sending them mid-conversation.
	const transcript = collapseSystemMessages(context);
	const systemPrompt = getCurrentSystemPrompt(transcript.messages);
	const tools = getCurrentTools(transcript.messages);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};
		const blocks = output.content as Block[];
		let sawToolCall = false;
		let sawStreamedContent = false;
		let responded = false;

		const applyUsage = (usage: ClaudeUsage | undefined): void => {
			if (!usage) return;
			output.usage.input = usage.input;
			output.usage.output = usage.output;
			output.usage.cacheRead = usage.cacheRead;
			output.usage.cacheWrite = usage.cacheWrite;
			output.usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			// Zero-cost model: a subscription CLI turn has no per-token list price here.
			output.usage.cost = calculateCost(model, output.usage);
		};
		const find = (index: number): number => blocks.findIndex((block) => block.index === index);
		const endBlock = (contentIndex: number): void => {
			const block = blocks[contentIndex];
			if (!block) return;
			delete (block as Partial<Block>).index;
			if (block.type === "text") stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
			else if (block.type === "thinking") {
				// A block that produced no text but did carry a signature is
				// redacted thinking: keep the block so the opaque payload
				// survives replay, and mark it as what it is.
				if (!block.thinking && block.thinkingSignature) block.redacted = true;
				stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
			}
			else {
				const call = block as ToolCall & { partialJson?: string };
				if (call.partialJson) {
					try {
						call.arguments = JSON.parse(call.partialJson) as JsonObject;
					} catch {
						throw new ClaudeProtocolError(`Claude sent invalid JSON arguments for tool "${call.name}"`);
					}
				}
				delete call.partialJson;
				stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: output });
			}
		};

		try {
			let payload: ClaudeTurnPayload = {
				provider: "claude-code-cli",
				model: model.id,
				effort: resolveClaudeEffort(model, options?.reasoning),
				sessionId: options?.sessionId,
				systemPrompt: systemPrompt || undefined,
				tools,
				messages: transcript.messages,
			};
			const replacement = await options?.onPayload?.(payload, model);
			if (replacement && typeof replacement === "object") payload = replacement as ClaudeTurnPayload;

			stream.push({ type: "start", partial: output });

			for await (const frame of untilAborted(bridge.runTurn(payload, options?.signal), options?.signal)) {
				if (!responded) {
					responded = true;
					// The CLI is not HTTP; report the synthetic "response received"
					// point that the ProviderConfig contract asks every provider for.
					await options?.onResponse?.({ status: 200, headers: {} }, model);
				}
				handleFrame(frame);
			}

			if (options?.signal?.aborted) throw abortError();
			if (output.stopReason === "pending") {
				// PRIMARY TOOL PATH, not a fallback: one CLI turn spans several pi
				// assistant messages, so a message that calls tools ends with the
				// iterator simply ending — the bridge is holding the CLI turn open
				// on the tools/call, and no terminal `result` frame is expected
				// until the whole CLI turn finishes. Do NOT tighten this into an
				// error; that would break every tool-using turn. Pinned by
				// "a tool turn with no terminal result ends as toolUse" in
				// stream.test.ts. Only a message with no tool call and no stop
				// reason is genuine protocol corruption.
				if (sawToolCall) output.stopReason = "toolUse";
				else throw new ClaudeProtocolError("Claude ended the turn without a stop reason");
			}
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "Claude Code failed without a message");
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of blocks) delete (block as Partial<Block>).index;
			const aborted =
				output.stopReason === "aborted" || options?.signal?.aborted || (error instanceof Error && error.name === "AbortError");
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}

		function handleFrame(frame: ClaudeFrame): void {
			if (frame.type === "init") return;
			if (frame.type === "result") {
				applyUsage(frame.usage);
				if (frame.outcome === "aborted") {
					output.stopReason = "aborted";
					output.errorMessage = frame.message ?? "Claude Code cancelled the turn";
				} else if (frame.outcome === "error") {
					output.stopReason = "error";
					output.errorMessage = frame.message ?? "Claude Code reported a failed turn";
				} else if (output.stopReason === "pending") {
					output.stopReason = sawToolCall ? "toolUse" : "stop";
				}
				return;
			}
			if (frame.type === "assistant") {
				applyUsage(frame.usage);
				// With --include-partial-messages the whole-message frame repeats
				// what the stream already delivered; only use it as a fallback.
				if (!sawStreamedContent) replayAssistant(frame);
				if (frame.stopReason && output.stopReason === "pending") output.stopReason = mapStopReason(frame.stopReason);
				return;
			}
			handleEvent(frame.event);
		}

		function replayAssistant(frame: Extract<ClaudeFrame, { type: "assistant" }>): void {
			for (const block of frame.blocks) {
				const contentIndex = output.content.length;
				if (block.kind === "text") {
					output.content.push({ type: "text", text: "" });
					stream.push({ type: "text_start", contentIndex, partial: output });
					(output.content[contentIndex] as TextContent).text = block.text;
					stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
				} else if (block.kind === "thinking") {
					output.content.push({ type: "thinking", thinking: "", thinkingSignature: block.signature });
					stream.push({ type: "thinking_start", contentIndex, partial: output });
					(output.content[contentIndex] as ThinkingContent).thinking = block.thinking;
					stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial: output });
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
				} else {
					sawToolCall = true;
					const call: ToolCall = {
						type: "toolCall",
						id: block.id,
						name: toPiToolName(block.name, tools),
						arguments: (typeof block.input === "object" && block.input !== null ? block.input : {}) as JsonObject,
					};
					output.content.push(call);
					stream.push({ type: "toolcall_start", contentIndex, partial: output });
					const json = JSON.stringify(call.arguments);
					stream.push({ type: "toolcall_delta", contentIndex, delta: json, partial: output });
					stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: output });
				}
			}
		}

		function handleEvent(event: Extract<ClaudeFrame, { type: "stream" }>["event"]): void {
			switch (event.type) {
				case "message_start":
					applyUsage(event.usage);
					return;
				case "content_block_start": {
					sawStreamedContent = true;
					const contentIndex = output.content.length;
					if (event.block.kind === "text") {
						blocks.push({ type: "text", text: "", index: event.index });
						stream.push({ type: "text_start", contentIndex, partial: output });
					} else if (event.block.kind === "thinking") {
						blocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
						stream.push({ type: "thinking_start", contentIndex, partial: output });
					} else if (event.block.kind === "redacted_thinking") {
						blocks.push({ type: "thinking", thinking: "", thinkingSignature: event.block.data, redacted: true, index: event.index });
						stream.push({ type: "thinking_start", contentIndex, partial: output });
					} else {
						sawToolCall = true;
						const input = typeof event.block.input === "object" && event.block.input !== null ? (event.block.input as JsonObject) : {};
						blocks.push({ type: "toolCall", id: event.block.id, name: toPiToolName(event.block.name, tools), arguments: input, partialJson: "", index: event.index });
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
					}
					return;
				}
				case "content_block_delta": {
					const contentIndex = find(event.index);
					const block = blocks[contentIndex];
					if (!block) throw new ClaudeProtocolError(`Claude sent a delta for unknown content block ${event.index}`);
					sawStreamedContent = true;
					if (event.delta.kind === "text" && block.type === "text") {
						block.text += event.delta.text;
						stream.push({ type: "text_delta", contentIndex, delta: event.delta.text, partial: output });
					} else if (event.delta.kind === "thinking" && block.type === "thinking") {
						// Under subscription auth thinking is redacted: the deltas
						// arrive empty and only the signature carries the payload.
						// An empty delta is not an event worth pushing.
						if (!event.delta.thinking) return;
						block.thinking += event.delta.thinking;
						stream.push({ type: "thinking_delta", contentIndex, delta: event.delta.thinking, partial: output });
					} else if (event.delta.kind === "signature" && block.type === "thinking") {
						block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
					} else if (event.delta.kind === "input_json" && block.type === "toolCall") {
						const call = block as ToolCall & { partialJson: string };
						call.partialJson += event.delta.partialJson;
						try {
							call.arguments = JSON.parse(call.partialJson) as JsonObject;
						} catch { /* arguments stay partial until the block ends */ }
						stream.push({ type: "toolcall_delta", contentIndex, delta: event.delta.partialJson, partial: output });
					} else {
						throw new ClaudeProtocolError(`Claude sent a ${event.delta.kind} delta for a ${block.type} block`);
					}
					return;
				}
				case "content_block_stop": {
					const contentIndex = find(event.index);
					if (contentIndex < 0) throw new ClaudeProtocolError(`Claude closed unknown content block ${event.index}`);
					endBlock(contentIndex);
					return;
				}
				case "message_delta":
					applyUsage(event.usage);
					if (event.stopReason) output.stopReason = mapStopReason(event.stopReason);
					return;
				case "message_stop":
					if (output.stopReason === "pending" && sawToolCall) output.stopReason = "toolUse";
					return;
			}
		}
	})();

	return stream;
}

/** Bind a bridge into the `streamSimple` shape `pi.registerProvider` expects. */
export function createClaudeStreamSimple(bridge: ClaudeSessionBridge) {
	return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream =>
		streamClaudeCode(bridge, model, context, options);
}
