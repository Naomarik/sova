// Assembles the in-progress agent run from raw pi SDK events (docs/rpc.md "Events").
// The store holds only what streamed since the last settle; on agent_settled the chat view
// refetches the normalized transcript and resets this.

import { produce, type SetStoreFunction } from "solid-js/store";
import { imagesFromContent } from "./images";
import { contentText, isObj, str } from "./message";

export type LiveBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; id: string; name: string; argsText: string; args?: unknown };

export type LiveEntry =
  | { kind: "user"; text: string; confirmed: boolean; images: string[] }
  | {
      kind: "assistant";
      blocks: LiveBlock[];
      done: boolean;
      /** "provider/model" producing this message, from message_start/message_end. */
      model?: string;
      error?: string;
      /** ISO time the message ended as aborted. */
      stoppedAt?: string;
    };

export interface LiveTool {
  name: string;
  args?: unknown;
  status: "running" | "done" | "error";
  output: string;
  images: string[];
}

export interface LiveState {
  entries: LiveEntry[];
  tools: Record<string, LiveTool>;
  /** True from agent_start (or hello.isStreaming) until agent_settled. */
  running: boolean;
  /** What the agent is doing besides generating, e.g. retrying or compacting. */
  activity: string | null;
  /** The user pressed Stop and the run hasn't settled yet. */
  stopping: boolean;
}

export const emptyLive = (): LiveState => ({ entries: [], tools: {}, running: false, activity: null, stopping: false });

/** Run-status detail: "running bash" / "thinking" / "writing", or null between blocks. */
export function runDetail(s: LiveState): string | null {
  const running = Object.values(s.tools).find((t) => t.status === "running");
  if (running) return `running ${running.name}`;
  const last = s.entries[s.entries.length - 1];
  if (last?.kind !== "assistant" || last.done) return null;
  const block = [...last.blocks].reverse().find(Boolean);
  if (block?.type === "thinking") return "thinking";
  if (block?.type === "text") return "writing";
  if (block?.type === "toolCall") return `running ${block.name}`;
  return null;
}

/** "provider/model" of a streaming assistant message, when the event carries one. */
function liveModelOf(msg: Record<string, unknown>): string | undefined {
  const provider = str(msg.provider);
  const model = str(msg.model);
  return provider && model ? `${provider}/${model}` : undefined;
}

function blocksFromContent(content: unknown): LiveBlock[] {
  if (!Array.isArray(content)) return [];
  const out: LiveBlock[] = [];
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c.type === "text") out.push({ type: "text", text: str(c.text) ?? "" });
    else if (c.type === "thinking") out.push({ type: "thinking", text: str(c.thinking) ?? "" });
    else if (c.type === "toolCall")
      out.push({ type: "toolCall", id: str(c.id) ?? "", name: str(c.name) ?? "tool", argsText: "", args: c.arguments });
  }
  return out;
}

function lastAssistant(s: LiveState): Extract<LiveEntry, { kind: "assistant" }> {
  const last = s.entries[s.entries.length - 1];
  if (last?.kind === "assistant" && !last.done) return last;
  // Joined mid-message (e.g. after reconnect): start a fresh one.
  const entry: LiveEntry = { kind: "assistant", blocks: [], done: false };
  s.entries.push(entry);
  return s.entries[s.entries.length - 1] as Extract<LiveEntry, { kind: "assistant" }>;
}

function toolOutput(result: unknown): string {
  return isObj(result) ? contentText(result.content) : typeof result === "string" ? result : "";
}

const toolImages = (result: unknown) => (isObj(result) ? imagesFromContent(result.content) : []);

/** Adds the user's prompt before the server echoes it, so the thread never lags the composer. */
export function addPendingPrompt(set: SetStoreFunction<LiveState>, text: string, images: string[] = []) {
  set(produce((s) => void s.entries.push({ kind: "user", text, confirmed: false, images })));
}

export function applyEvent(set: SetStoreFunction<LiveState>, event: unknown) {
  if (!isObj(event)) return;
  const type = str(event.type);
  set(
    produce((s) => {
      switch (type) {
        case "agent_start":
          s.running = true;
          break;
        case "agent_settled":
          s.running = false;
          s.activity = null;
          s.stopping = false;
          break;
        case "message_start": {
          const msg = isObj(event.message) ? event.message : {};
          if (msg.role === "assistant") {
            s.running = true;
            const model = liveModelOf(msg);
            s.entries.push({ kind: "assistant", blocks: blocksFromContent(msg.content), done: false, ...(model ? { model } : {}) });
          } else if (msg.role === "user") {
            const pending = s.entries.find((e) => e.kind === "user" && !e.confirmed);
            if (pending && pending.kind === "user") pending.confirmed = true;
            else s.entries.push({ kind: "user", text: contentText(msg.content), confirmed: true, images: imagesFromContent(msg.content) });
          }
          break;
        }
        case "message_update": {
          const ev = isObj(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
          if (!ev) break;
          const entry = lastAssistant(s);
          const i = typeof ev.contentIndex === "number" ? ev.contentIndex : entry.blocks.length;
          const delta = str(ev.delta) ?? "";
          const cur = entry.blocks[i];
          switch (ev.type) {
            case "text_start":
              entry.blocks[i] = { type: "text", text: "" };
              break;
            case "text_delta":
              if (cur?.type === "text") cur.text += delta;
              else entry.blocks[i] = { type: "text", text: delta };
              break;
            case "text_end":
              if (typeof ev.content === "string") entry.blocks[i] = { type: "text", text: ev.content };
              break;
            case "thinking_start":
              entry.blocks[i] = { type: "thinking", text: "" };
              break;
            case "thinking_delta":
              if (cur?.type === "thinking") cur.text += delta;
              else entry.blocks[i] = { type: "thinking", text: delta };
              break;
            case "thinking_end":
              if (typeof ev.content === "string") entry.blocks[i] = { type: "thinking", text: ev.content };
              break;
            case "toolcall_start":
              entry.blocks[i] = { type: "toolCall", id: str(ev.id) ?? "", name: str(ev.toolName) ?? "tool", argsText: "" };
              break;
            case "toolcall_delta":
              if (cur?.type === "toolCall") cur.argsText += delta;
              break;
            case "toolcall_end": {
              const tc = isObj(ev.toolCall) ? ev.toolCall : {};
              entry.blocks[i] = {
                type: "toolCall",
                id: str(tc.id) ?? (cur?.type === "toolCall" ? cur.id : ""),
                name: str(tc.name) ?? (cur?.type === "toolCall" ? cur.name : "tool"),
                argsText: cur?.type === "toolCall" ? cur.argsText : "",
                args: tc.arguments,
              };
              break;
            }
          }
          break;
        }
        case "message_end": {
          const msg = isObj(event.message) ? event.message : {};
          if (msg.role !== "assistant") break;
          const entry = lastAssistant(s);
          // message_end is authoritative.
          const model = liveModelOf(msg);
          if (model) entry.model = model;
          const blocks = blocksFromContent(msg.content);
          if (blocks.length) entry.blocks = blocks;
          entry.done = true;
          if (msg.stopReason === "error") entry.error = str(msg.errorMessage) ?? "The model returned an error";
          else if (msg.stopReason === "aborted") entry.stoppedAt = new Date().toISOString();
          break;
        }
        case "tool_execution_start": {
          const id = str(event.toolCallId);
          if (id) s.tools[id] = { name: str(event.toolName) ?? "tool", args: event.args, status: "running", output: "", images: [] };
          break;
        }
        case "tool_execution_update": {
          const id = str(event.toolCallId);
          const t = id ? s.tools[id] : undefined;
          if (t) {
            t.output = toolOutput(event.partialResult);
            t.images = toolImages(event.partialResult);
          }
          break;
        }
        case "tool_execution_end": {
          const id = str(event.toolCallId);
          if (!id) break;
          const prev = s.tools[id];
          s.tools[id] = {
            name: str(event.toolName) ?? prev?.name ?? "tool",
            args: prev?.args ?? event.args,
            status: event.isError === true ? "error" : "done",
            output: toolOutput(event.result),
            images: toolImages(event.result),
          };
          break;
        }
        case "auto_retry_start":
          s.activity = "Retrying after a provider error";
          break;
        case "compaction_start":
          s.activity = "Compacting context";
          break;
        case "auto_retry_end":
        case "compaction_end":
          s.activity = null;
          break;
      }
    }),
  );
}
