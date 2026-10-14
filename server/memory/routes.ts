// The memory routes (§chat.memory/status, §chat.memory/settings, §chat.memory/overseer): the outline the
// Session pane reads, Settings → Memory, and the Overseer's own switch.
import type { Hono } from "hono";
import type { HEntry } from "../../shared/harness";
import type { MemoryOutline, MemoryStatus, OverseerMemoryInfo } from "../../shared/protocol";
import { MEMORY_SIZES, MEMORY_TYPE_INFO } from "../../shared/memory";
import { stateView } from "../harness/state-view";
import { MEMORY, MODE, OVERSEER } from "../harness/state-kinds";
import { isOverseerId, readOverseerSettings, writeOverseerSettings } from "../overseer-store";
import { projectOverseerOfPath, projectOverseerPaths, readPoSettings } from "../project-overseer-store";
import type { ChatHandle } from "../chat-handle";
import type { DelegateSources } from "../delegate";
import { delegateOptions } from "../delegate";
import { MemoryEngine } from "./engine";
import { zoomableLines } from "./chat";
import { choiceOf, memorySettingsInfo, overseerMemoryOf, type OverseerMemorySetting, patchOverseerMemory, putMemorySettings } from "./settings";
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

/** The overseer's setting in force when the file is an overseer's (the Overseer's or a project overseer's): its own
    switch, saved or on with UniiChat at 128 KB, never a mode. Undefined for every other chat. */
function overseerMemoryOfFile(path: string, id: string, view: ReturnType<typeof stateView>): OverseerMemorySetting | undefined {
  if (isOverseerId(id) && view.has(OVERSEER)) return overseerMemoryOf(readOverseerSettings().memory);
  const po = projectOverseerOfPath(path, id);
  return po ? overseerMemoryOf(readPoSettings(projectOverseerPaths(po.projectId)).memory) : undefined;
}

/** The outline of a chat no one holds: read from its file and sidecar, building nothing. */
async function coldOutline(path: string, deps: MemoryRouteDeps): Promise<{ outline: MemoryOutline; engine: MemoryEngine } | null> {
  const id = idOfPath(path);
  if (!id) return null;
  const branch = await deps.readBranch(path);
  const view = stateView(branch);
  const overseer = overseerMemoryOfFile(path, id, view);
  const choice = overseer ? { type: overseer.type, size: overseer.size } : choiceOf(view.latest(MEMORY)?.data ?? null);
  const on = overseer ? overseer.on : (view.latest(MODE)?.data.active?.minorModes.includes("memory") ?? false);
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

/** An overseer's switch as its route answers it: its setting in force (saved, else on with
    UniiChat at 128 KB), the types and sizes, and its held chat's status (off while memory is off). Shared by the
    Overseer's route and each project overseer's. */
export function overseerMemoryInfo(saved: OverseerMemorySetting | undefined, status: MemoryStatus | null | undefined): OverseerMemoryInfo {
  const m = overseerMemoryOf(saved);
  return { ...m, types: [...MEMORY_TYPE_INFO], sizes: [...MEMORY_SIZES], status: m.on ? (status ?? { state: "off" }) : { state: "off" } };
}

/**
 * PUT an overseer's switch: `body` over the setting in force, saved by `save`, then its held chat told (turned on
 * when the setting in force went from off to on, so it prepares its history). The answer, or the reason it's
 * refused (nothing written).
 */
export async function putOverseerMemorySwitch(
  saved: OverseerMemorySetting | undefined,
  body: unknown,
  save: (next: OverseerMemorySetting) => void,
  chat: Pick<ChatHandle, "memoryStatus" | "memorySettingsChanged"> | undefined,
): Promise<OverseerMemoryInfo | { error: string }> {
  const was = overseerMemoryOf(saved);
  const next = patchOverseerMemory(was, body);
  if ("error" in next) return next;
  save(next);
  await chat?.memorySettingsChanged(next.on && !was.on);
  return overseerMemoryInfo(next, await chat?.memoryStatus());
}

async function overseerInfo(deps: MemoryRouteDeps): Promise<OverseerMemoryInfo> {
  return overseerMemoryInfo(readOverseerSettings().memory, await deps.overseer()?.memoryStatus());
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
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Expected JSON body { on?, type?, size? }" }, 400);
    }
    const settings = readOverseerSettings();
    const out = await putOverseerMemorySwitch(settings.memory, body, (memory) => writeOverseerSettings({ ...readOverseerSettings(), memory }), deps.overseer());
    return "error" in out ? c.json({ error: out.error }, 400) : c.json(out);
  });
}
