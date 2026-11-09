// Run: pnpm test -- server/modes/engine-parity.test.ts. The engine is the mode extension's hub lifted with no
// behaviour change (§chat.mode-menu/sova-runs-modes): the old extension (pi-config/extensions/mode/index.ts)
// and Sova's engine (server/harness/pi/modes.ts) are each driven through the same script against one fake pi,
// and everything a model or a chat can see must match exactly: tools (name, description, schema, snippet,
// guidelines) in registration order, the flags, the active tool lists, every entry written, every message
// sent, the bus events the subagents extension reads, the notices, and each handler's answer (the `mode`
// section, the hidden notes, the nudge, the census patch). Only the terminal's surfaces differ (status,
// shortcuts, renderers, the palette), and they are left out of the log by name.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

/** The old extension, imported by a computed path: it is pi-config's code, typechecked there, not by the server's tsc. */
const OLD_EXTENSION: string = new URL("../../pi-config/extensions/mode/index.ts", import.meta.url).href;

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Log {
  lines: string[];
}

/** One fake pi runtime: a recorder of everything the extension does, and a driver of its events. */
function fakePi(log: Log, flags: Record<string, unknown>, opts: { cwd?: string; worker?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, ((data: unknown) => void)[]>();
  const tools = new Map<string, Record<string, unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  let active: string[] = ["read", "bash", "edit", "write"];
  const branch: unknown[] = [];
  const say = (line: string) => log.lines.push(line);
  // A worker: the subagents marker answers the mode extension's question at its load.
  if (opts.worker) bus.set("subagents:worker-discover", [() => pi.events.emit("subagents:worker", { version: 1 })]);
  // Bus events of the terminal's palette are the TUI's: not logged.
  const quiet = (event: string) => event.startsWith("command-palette:") || event.startsWith("palette:");
  const pi = {
    events: {
      on(event: string, fn: (data: unknown) => void) {
        bus.set(event, [...(bus.get(event) ?? []), fn]);
        return () => {};
      },
      emit(event: string, data: unknown) {
        if (!quiet(event) && !event.startsWith("sova:modes-engine")) say(`emit ${event} ${JSON.stringify(data)}`);
        for (const fn of bus.get(event) ?? []) fn(data);
      },
    },
    on(event: string, fn: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    registerFlag(name: string, spec: unknown) {
      say(`flag ${name} ${JSON.stringify(spec)}`);
    },
    getFlag: (name: string) => flags[name],
    registerTool(def: Record<string, unknown>) {
      const isNew = !tools.has(def.name as string);
      tools.set(def.name as string, def);
      if (isNew) active = [...active, def.name as string];
      say(`tool ${def.name} ${JSON.stringify({ d: def.description, p: def.parameters, s: def.promptSnippet, g: def.promptGuidelines, x: def.exposure, m: def.executionMode })}`);
    },
    registerCommand(name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, cmd);
      say(`command ${name}`);
    },
    registerShortcut() {},
    registerEntryRenderer() {},
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
      say(`active ${names.join(",")}`);
    },
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data, id: `e${branch.length}` });
      say(`entry ${customType} ${JSON.stringify(data)}`);
    },
    sendMessage(message: unknown, opts?: unknown) {
      say(`message ${JSON.stringify(message)} ${JSON.stringify(opts ?? null)}`);
    },
    sendUserMessage(text: string, opts?: unknown) {
      say(`user ${text} ${JSON.stringify(opts ?? null)}`);
    },
  };
  const sections: Record<string, string> = {};
  const ctx = (command = false) => ({
    cwd: opts.cwd ?? process.cwd(),
    hasUI: false,
    mode: "rpc",
    signal: undefined,
    isIdle: () => true,
    modelRegistry: { getAvailable: () => [] },
    ui: {
      notify: (text: string, level: string) => say(`notify ${level} ${text}`),
      setStatus() {},
      setWidget() {},
      theme: { fg: (_t: string, s: string) => s },
    },
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "s-parity",
      getHeader: () => ({ timestamp: "2026-11-05T00:00:00.000Z" }),
      getSessionFile: () => undefined,
    },
    ...(command ? { getSystemPromptOptions: () => ({ sections }) } : {}),
  });
  /** Fire one event through every handler, in order, logging each answer. */
  const fire = async (event: string, data: unknown = {}) => {
    for (const fn of handlers.get(event) ?? []) {
      const out = await fn(data, ctx());
      if (out !== undefined) say(`answer ${event} ${JSON.stringify(out)}`);
    }
  };
  const run = async (name: string, args: string) => {
    const cmd = commands.get(name);
    if (!cmd) return say(`no command /${name}`);
    await cmd.handler(args, ctx(true));
    say(`sections ${JSON.stringify(sections)}`);
  };
  return { pi, fire, run, sections, handlers, commandNames: () => [...commands.keys()] };
}

/** The script both owners are driven through. */
async function script(f: ReturnType<typeof fakePi>) {
  await f.fire("session_start", { reason: "startup" });
  await f.run("mode", "sync");
  const turn = async (prompt: string, reply: string) => {
    const opts = { sections: {} as Record<string, string> };
    await f.fire("before_agent_start", { prompt, systemPrompt: "BASE", systemPromptOptions: opts });
    f.pi.events.emit("log", { sections: opts.sections });
    await f.fire("agent_start", {});
    await f.fire("turn_end", { message: { role: "assistant", content: [{ type: "text", text: reply }] } });
    await f.fire("agent_before_settle", { outcome: "completed", entries: [] });
    await f.fire("agent_settled", {});
  };
  await turn("hello?", "Hi.");
  await f.run("mode", "align on");
  await turn("Build a login page", "Plan:\n1. A form\n2. A route\n\nShould I go ahead?");
  await f.run("mode", "vis on");
  await f.run("mode", "spec on");
  await turn("next", "ok");
  await f.run("mode", "strict on");
  // A tool that arrives while strict is on (§chat.mode-menu/strict) stays through the rest of this.
  f.pi.setActiveTools([...f.pi.getActiveTools(), "arrived"]);
  await f.run("mode", "delegate");
  await turn("go", "done");
  await f.run("mode", "align off");
  await f.run("mode", "normal");
  assert.ok(f.pi.getActiveTools().includes("arrived"), "leaving strict keeps it");
  await f.run("mode", "strict off");
  await f.run("mode", "bogus on");
  await f.run("align", "on");
  await f.run("mode", "project:demo on");
  await f.run("mode", "demo");
  await f.run("mode", "demo on");
  await f.run("mode", "tooly on");
  await f.run("mode", "project:missing on");
  await f.run("mode", "subagents nobody");
  await f.run("mode", "align on");
  await turn("Build it", "Here is my plan. Which option do you prefer?");
  await f.run("review", "plan");
  await f.fire("tool_execution_start", { toolName: "align", args: { op: "change_request" } });
  await f.fire("tool_execution_end", { toolName: "align", toolCallId: "t1", isError: false, result: { details: { exempt: "x" } } });
  await f.run("mode", "create");
  await f.run("mode", "delegate");
  await turn("again", "Plan:\n1. a\n2. b\nShall I?");
  await f.fire("session_compact", {});
  await f.fire("context", { messages: [{ role: "custom", customType: "mode-note", timestamp: 1 }, { role: "compactionSummary", timestamp: 5 }, { role: "user", timestamp: 6 }] });
  await turn("after compaction", "ok");
  await f.fire("context", { messages: [{ role: "custom", customType: "mode-note", timestamp: 1 }, { role: "compactionSummary", timestamp: 5 }, { role: "user", timestamp: 6 }] });
  await f.fire("session_tree", {});
  await f.fire("session_shutdown", {});
}

describe("the engine matches the mode extension", () => {
  let dir: string;
  const saved = { agent: process.env.PI_CODING_AGENT_DIR, census: process.env.PI_SPEC_CENSUS_HOOK };
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "modes-parity-"));
    mkdirSync(join(dir, "agent"), { recursive: true });
    writeFileSync(join(dir, "agent", "mode.json"), JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: [] }));
    // A checkout with two project modes: one plain (workers: yes), one with a tool nobody approved.
    const modes = join(dir, "checkout", ".sova", "minor-modes");
    mkdirSync(join(dir, "checkout", ".git"), { recursive: true });
    mkdirSync(join(modes, "demo"), { recursive: true });
    writeFileSync(join(modes, "demo", "MODE.md"), "---\ndescription: Demo mode\nworkers: yes\n---\nAlways say demo.\n");
    mkdirSync(join(modes, "tooly"), { recursive: true });
    writeFileSync(join(modes, "tooly", "go.sh"), "#!/bin/sh\necho go\n", { mode: 0o755 });
    writeFileSync(join(modes, "tooly", "MODE.md"), '---\ndescription: Tool mode\ntools: [{"name": "go", "description": "Go", "params": {"type": "object"}, "command": ["./go.sh"]}]\n---\nUse go.\n');
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    process.env.PI_SPEC_CENSUS_HOOK = "0";
  });
  after(() => {
    if (saved.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved.agent;
    if (saved.census === undefined) delete process.env.PI_SPEC_CENSUS_HOOK;
    else process.env.PI_SPEC_CENSUS_HOOK = saved.census;
    rmSync(dir, { recursive: true, force: true });
  });

  const drive = async (load: (pi: unknown) => unknown, flags: Record<string, unknown>, worker = false) => {
    const log: Log = { lines: [] };
    const f = fakePi(log, flags, { cwd: join(dir, "checkout"), worker });
    load(f.pi);
    await script(f);
    return { lines: log.lines, commands: f.commandNames() };
  };

  for (const [name, flags, worker] of [
    ["a chat", {}, false],
    ["a chat with adversarial review and Visuals", { "adversarial-review": true, "align-visuals": "on" }, false],
    ["a chat started with --major delegate --minor spec,vis", { major: "delegate", minor: "spec,vis" }, false],
    ["a worktree-config worker (--major normal --minor spec)", { major: "normal", minor: "spec" }, true],
  ] as const) {
    test(`${name}: same tools, entries, notes, sections and notices`, async () => {
      const old = (await import(OLD_EXTENSION)).default as (pi: never, o: unknown) => void;
      const { modesExtension } = await import("../harness/pi/modes.ts");
      const a = await drive((pi) => old(pi as never, { claudeModels: () => [] }), flags, worker);
      const b = await drive((pi) => modesExtension(pi as never, { claudeModels: () => [] }), flags, worker);
      assert.deepEqual(b.commands, a.commands);
      // The one intended difference: typed /mode's usage line no longer offers the terminal's status, default and sync.
      const usage = (line: string) => line.replace("|status|default|sync|", "|");
      assert.deepEqual(b.lines, a.lines.map(usage));
      // The script reached what it means to compare (a check that can't pass on an empty log).
      const has = (part: string) => assert.ok(b.lines.some((l) => l.includes(part)), `the log has ${part}`);
      if (!worker) {
        has("entry mode-project-snapshot");
        has("notify info Minor mode: demo on");
        has("runs the project's own tools");
        has("align-nudge");
        has('"mode":"# Mode: delegate');
      } else has("Minor mode demo not turned on: a worker gets its project modes");
      has("emit mode:worker");
    });
  }
});
