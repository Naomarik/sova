// The reply in progress, folded from the wire-2 events a chat broadcasts, for the `live` field of a
// hello (shared/protocol.ts HelloLive): a browser that connects mid-reply is shown the reply so far
// and keeps streaming it. The fold follows the browser's own reducer (src/lib/live.ts applyPart): a
// part event without an index applies at the end of the parts, a delta without a started part starts
// one, a part's end with text replaces what streamed. A hello is built and sent in the same
// synchronous step as the events, so the snapshot always sits at a frame boundary: the first event a
// new client gets after it is the first one not folded in.
import type { SovaEvent, SovaPart } from "../../shared/harness-wire";
import type { HelloLive } from "../../shared/protocol";

type LiveTool = NonNullable<HelloLive["tools"]>[number];

export class LiveTail {
  private message: { model?: string; parts: SovaPart[] } | null = null;
  private readonly tools = new Map<string, LiveTool>();

  apply(e: SovaEvent): void {
    switch (e.type) {
      case "message.start":
        if (e.role === "assistant") this.message = { ...(e.model ? { model: e.model } : {}), parts: e.parts.map((p) => ({ ...p })) };
        return;
      case "message.end":
        if (e.role === "assistant") this.message = null;
        return;
      case "part.start":
      case "part.delta":
      case "part.end":
        if (this.message) applyPart(this.message.parts, e);
        return;
      case "tool.start":
        this.tools.set(e.callId, {
          callId: e.callId,
          name: e.name,
          ...(e.args !== undefined ? { args: e.args } : {}),
          output: "",
          images: [],
          ...(e.parentCallId ? { parentCallId: e.parentCallId } : {}),
        });
        return;
      case "tool.update": {
        const t = this.tools.get(e.callId);
        if (t) {
          t.output = e.output;
          t.images = e.images;
        }
        return;
      }
      case "tool.end":
        this.tools.delete(e.callId);
        return;
      case "run.start":
      case "run.settled":
        this.message = null;
        this.tools.clear();
        return;
      default:
        return;
    }
  }

  /** The reply so far, or undefined when nothing streams. */
  snapshot(): HelloLive | undefined {
    if (!this.message && this.tools.size === 0) return undefined;
    return {
      ...(this.message ? { message: { ...(this.message.model ? { model: this.message.model } : {}), parts: this.message.parts.map((p) => ({ ...p })) } } : {}),
      ...(this.tools.size ? { tools: [...this.tools.values()].map((t) => ({ ...t, images: [...t.images] })) } : {}),
    };
  }
}

function applyPart(parts: SovaPart[], e: Extract<SovaEvent, { type: "part.start" | "part.delta" | "part.end" }>): void {
  const i = e.index ?? parts.length;
  const cur = parts[i];
  if (e.type === "part.start") {
    parts[i] = e.kind === "toolCall" ? { kind: "toolCall", id: e.id ?? "", name: e.name ?? "tool" } : { kind: e.kind, text: "" };
  } else if (e.type === "part.delta") {
    // A tool call's arguments stream as JSON text: the snapshot has them once the call's part ends.
    if (e.kind === "toolCall") return;
    if (cur && cur.kind === e.kind) cur.text += e.delta;
    else parts[i] = { kind: e.kind, text: e.delta };
  } else if (e.kind === "toolCall") {
    const was = cur?.kind === "toolCall" ? cur : undefined;
    parts[i] = { kind: "toolCall", id: e.id ?? was?.id ?? "", name: e.name ?? was?.name ?? "tool", ...(e.args !== undefined ? { args: e.args } : {}) };
  } else if (e.text !== undefined) parts[i] = { kind: e.kind, text: e.text };
}
