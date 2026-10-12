// The memory routes (§chat.memory/status, §chat.memory/settings, §chat.memory/overseer): the outline the
// Session pane reads, Settings → Memory, and the Overseer's own switch.
import type { Hono } from "hono";
import type { HEntry } from "../../shared/harness";
import type { MemoryOutline, OverseerMemoryInfo } from "../../shared/protocol";
import { MEMORY_SIZES, MEMORY_TYPE_INFO } from "../../shared/memory";
import { stateView } from "../harness/state-view";
import { MEMORY, MODE } from "../harness/state-kinds";
import { readOverseerSettings, writeOverseerSettings } from "../overseer-store";
import type { ChatHandle } from "../chat-handle";
import type { DelegateSources } from "../delegate";
import { delegateOptions } from "../delegate";
import { MemoryEngine } from "./engine";
import { zoomableLines } from "./chat";
import { applyMemoryPatch, choiceOf, defaultMemoryChoice, memorySettingsInfo, parseMemoryChoice, putMemorySettings } from "./settings";
import { MemoryStore, memoryDir } from "./store";

/** What the routes ask the rest of the server. */
export interface MemoryRouteDeps {
  resolvePath(raw: string | undefined): string | null;
  /** A held chat, by session file: its memory as its handle answers (server/chat-handle.ts). */
  held(path: string): Pick<ChatHandle, "memoryOutline" | "memoryOpen"> | undefined;
  /** The held Overseer chat, if any. */
  overseer(): Pick<ChatHandle, "memoryStatus" | "memorySettingsChanged"> | undefined;
  readBranch(path: string): Promise<HEntry[]>;
  sources: DelegateSources;
}

const idOfPath = (path: string): string | undefined => /_([0-9a-f-]{36})\.jsonl$/i.exec(path)?.[1];

/** The outline of a chat no one holds: read from its file and sidecar, building nothing. */
async function coldOutline(path: string, deps: MemoryRouteDeps): Promise<{ outline: MemoryOutline; engine: MemoryEngine } | null> {
  const id = idOfPath(path);
  if (!id) return null;
  const branch = await deps.readBranch(path);
  const view = stateView(branch);
  const choice = choiceOf(view.latest(MEMORY)?.data ?? null);
  const on = view.latest(MODE)?.data.active?.minorModes.includes("memory") ?? false;
  const engine = new MemoryEngine(id, new MemoryStore(memoryDir(id)), { summarize: async () => { throw new Error("not held"); }, concurrency: 0 });
  engine.sync(branch);
  const lines = choice.type === "uniichat" ? engine.currentView() : zoomableLines(branch);
  return {
    engine,
    outline: {
      on,
      type: choice.type,
      size: choice.size,
      status: on ? engine.status() : { state: "off" },
      messages: engine.messages.length,
      bytes: engine.viewBytesOf(lines),
      lines: lines.map((r) => engine.memoryLine(r)),
    },
  };
}

async function overseerInfo(deps: MemoryRouteDeps): Promise<OverseerMemoryInfo> {
  const m = readOverseerSettings().memory;
  const choice = m ? { type: m.type, size: m.size } : defaultMemoryChoice();
  const status = (await deps.overseer()?.memoryStatus()) ?? { state: "off" as const };
  return { on: m?.on ?? false, ...choice, types: [...MEMORY_TYPE_INFO], sizes: [...MEMORY_SIZES], status };
}

export function registerMemoryRoutes(app: Hono, deps: MemoryRouteDeps): void {
  app.get("/api/memory", async (c) => {
    const path = deps.resolvePath(c.req.query("path"));
    if (!path) return c.json({ error: "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
    const held = await deps.held(path)?.memoryOutline();
    if (held) return c.json(held);
    try {
      const cold = await coldOutline(path, deps);
      return cold ? c.json(cold.outline) : c.json({ error: "Not a session file" }, 404);
    } catch {
      return c.json({ error: "Not a session file" }, 404);
    }
  });

  app.get("/api/memory/open", async (c) => {
    const path = deps.resolvePath(c.req.query("path"));
    if (!path) return c.json({ error: "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
    const id = Number(c.req.query("id"));
    const n = Number(c.req.query("n"));
    if (!Number.isInteger(id) || !Number.isInteger(n) || id < 0 || n < 1 || (n & (n - 1)) !== 0 || id % n !== 0)
      return c.json({ error: "id and n: n is a power of 2 and id a multiple of n" }, 400);
    const held = (await deps.held(path)?.memoryOpen(id, n)) ?? { state: "unavailable" as const };
    if (held.state === "ok") return c.json(held.open);
    if (held.state === "refused") return c.json({ error: held.error }, 404);
    if (held.state === "no-engine") return c.json({ error: "Not a session file" }, 404);
    let engine: MemoryEngine | undefined;
    try {
      engine = (await coldOutline(path, deps))?.engine;
    } catch {
      engine = undefined;
    }
    if (!engine) return c.json({ error: "Not a session file" }, 404);
    try {
      return c.json(engine.open(id, n));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.get("/api/settings/memory", (c) => c.json(memorySettingsInfo()));
  app.get("/api/settings/memory/options", async (c) => c.json(await delegateOptions(deps.sources)));
  app.put("/api/settings/memory", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Expected JSON body { version: 1, summarizer, default? }" }, 400);
    }
    const result = await putMemorySettings(body, deps.sources);
    return "error" in result ? c.json({ error: result.error }, 400) : c.json(result);
  });

  app.get("/api/overseer/memory", async (c) => c.json(await overseerInfo(deps)));
  app.put("/api/overseer/memory", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Expected JSON body { on?, type?, size? }" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Expected JSON body { on?, type?, size? }" }, 400);
    if (body.on !== undefined && typeof body.on !== "boolean") return c.json({ error: "on must be true or false" }, 400);
    let patch = {};
    if (body.type !== undefined || body.size !== undefined) {
      const p = parseMemoryChoice({ type: body.type, size: body.size }, true);
      if ("error" in p) return c.json({ error: p.error }, 400);
      patch = p;
    }
    const settings = readOverseerSettings();
    const was = settings.memory;
    const cur = was ? { type: was.type, size: was.size } : defaultMemoryChoice();
    const next = { on: typeof body.on === "boolean" ? body.on : (was?.on ?? false), ...applyMemoryPatch(cur, patch) };
    writeOverseerSettings({ ...settings, memory: next });
    await deps.overseer()?.memorySettingsChanged(next.on && !was?.on);
    return c.json(await overseerInfo(deps));
  });
}
