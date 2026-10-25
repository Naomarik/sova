// A special loadout on the chat's side (§app.harness/session-special, §app.chat-processes/special-kinds):
// the Overseer's, a project overseer's or a baton session's loadout built from data (SpecialSpec),
// wherever the chat runs. The kind's own code stays in the server: its tools are served, and what a
// run needs from it (the prompt, the run note, a compaction's note, the id check) is asked through
// the chat's SpecialPort: a loopback in the server's process, the chat's socket in a process of its
// own. Imports only shared types, the adapter's tool and extension types, and pure helpers
// (chat-special.test.ts holds the list).
import type { RunStartAnswer, ServerToolDecl, SpecialSpec } from "../shared/chat-runtime";
import { NOT_RUN_NO_SERVER } from "../shared/chat-runtime-wire";
import type { HEntry, HookCtx, SessionStateWriter } from "../shared/harness";
import type { SpecialPort } from "./chat-manager";
import { authorNotes, batonContextPhrases, labelAuthors, redactContext } from "./author-context";
import type { PiExtensionAPI, PiExtensionFactory, PiLoaderOptions, PiToolDefinition } from "./harness/pi/extension-types";
import { toolStateWriter } from "./harness/pi/state";
import { toolCtx } from "./harness/pi/tools";
import { RootConfinement } from "./overseer-deny";
import { assistantText } from "./overseer-id-check";
import { redactExtensionMessages, serverRedactor } from "./overseer-redact";

/** The last run-start answer each chat had: what a run starts on when no server answers in time. */
const lastAnswer = new Map<string, RunStartAnswer>();
/** Each chat's special extension, once bound: its own writer (pi.appendEntry, so entry_appended fires). */
const writers = new Map<string, PiExtensionAPI>();

/** The special extension's own writer for a chat (a baton tool's appends go through it, so
    entry_appended fires), or undefined before the extension is bound. It names no id: the leaf is the entry. */
export function specialWriter(chatId: string): SessionStateWriter | undefined {
  const pi = writers.get(chatId);
  return pi ? toolStateWriter(pi) : undefined;
}

/** The chat is done: what this module kept for it goes. */
export function forgetSpecial(chatId: string): void {
  lastAnswer.delete(chatId);
  writers.delete(chatId);
}

/** What the chat side needs from the chat to build the loadout. */
export interface SpecialDeps {
  /** The pi tool of a served declaration (chat-manager's serverToolSpec, as the chat registers it). */
  tool(decl: ServerToolDecl): PiToolDefinition;
  /** The memory engine's extension, when the spec asks for it. */
  memory?: () => PiExtensionFactory;
  /** The vis retry's extension, when the spec asks for it (its retry always on, its vis_check tool never). */
  visRetry?: () => PiExtensionFactory;
  /** A run start whose answer did not come: logged by the caller. */
  log?(line: string): void;
}

/** The built loadout: the loader's options, the tool allowlist, the SDK's custom tools, the prompt a run starts on. */
export interface SpecialBuild {
  loader: PiLoaderOptions;
  allow: string[];
  customTools: PiToolDefinition[];
  /** The system prompt's text as the run starting now has it (only where the spec appends its own parts). */
  promptAtRunStart?: (branch: readonly HEntry[]) => string;
}

/** The loadout of one build of a special chat. */
export function specialLoadout(chatId: string, spec: SpecialSpec, port: SpecialPort, deps: SpecialDeps): SpecialBuild {
  // A build starts from the spec's own answer (the prompt as the loadout opens), until a run asks.
  lastAnswer.set(chatId, spec.start);
  // The system prompt's appended parts: the user's own (APPEND_SYSTEM.md), then the loadout's, in one
  // array the SDK keeps; a run start splices the answer in, so a rebuild reads it (quirk P19).
  const parts: string[] = [];
  let base: string[] = [];
  const ours = () => (spec.loader.append === "user-then-ours" ? (lastAnswer.get(chatId)?.append ?? []) : []);
  const splice = () => {
    parts.splice(0, parts.length, ...base, ...ours());
    return parts.join("\n\n");
  };
  /** The baton's context pack of the run in progress. */
  let pack = lastAnswer.get(chatId)?.baton;

  const runStart = async (ctx: HookCtx, images: boolean): Promise<RunStartAnswer> => {
    try {
      const a = await port.runStart({ leafId: ctx.leafId(), images }, { ctx });
      lastAnswer.set(chatId, a);
      return a;
    } catch (err) {
      // Only when no server answered in time: anything else (the kind's own refusal) is the run's error.
      if (!(err instanceof Error && err.message === NOT_RUN_NO_SERVER)) throw err;
      deps.log?.(`run start not answered (${err.message}); the last prompt runs, with no run note`);
      const last = lastAnswer.get(chatId) ?? spec.start;
      const { message: _m, ...rest } = last;
      return rest;
    }
  };

  const factory: PiExtensionFactory = {
    name: spec.extension,
    factory: (pi: PiExtensionAPI) => {
      writers.set(chatId, pi);
      for (const decl of spec.tools) pi.registerTool(deps.tool(decl));
      pi.on("before_agent_start", async (event, ctx) => {
        const a = await runStart(toolCtx(ctx), !!ctx?.model?.input?.includes("image"));
        // A baton's owner areas follow the roster: re-registering refreshes the registry, which
        // re-activates every allowed tool, so its abilities are set again right after.
        for (const decl of a.reregister ?? []) pi.registerTool(deps.tool(decl));
        if (a.activeTools) pi.setActiveTools(a.activeTools);
        pack = a.baton;
        const o = event.systemPromptOptions as unknown as Record<string, unknown>;
        if (spec.loader.append === "user-then-ours") o.appendSystemPrompt = splice();
        for (const [k, v] of Object.entries(a.prompt)) o[k] = v;
        return a.message ? { message: a.message } : undefined;
      });
      if (spec.hooks.agentEnd)
        pi.on("agent_end", async (event) => {
          try {
            const note = await port.agentEnd({ text: assistantText(event.messages) });
            if (note) pi.sendMessage(note);
          } catch (err) {
            console.warn(`[${spec.kind}] id check skipped:`, err instanceof Error ? err.message : String(err));
          }
        });
      if (spec.hooks.compact)
        pi.on("session_compact", async (_event, ctx) => {
          const note = await port.compact({ leafId: toolCtx(ctx).leafId() }, { ctx: toolCtx(ctx) }).catch(() => null);
          if (note) pi.sendMessage(note);
        });
      pi.on("context", (event, ctx) => {
        if (spec.context === "redact") {
          const messages = redactExtensionMessages(event.messages, serverRedactor());
          return messages === event.messages ? undefined : { messages };
        }
        const redacted = redactContext(event.messages, pack ? batonContextPhrases(pack, event.messages) : []);
        // Who wrote each message, added after the redaction (names are no secret).
        const branch = ctx ? toolCtx(ctx).branch() : [];
        const messages = pack ? labelAuthors(redacted, authorNotes(branch, pack.names, pack.holder), event.messages) : redacted;
        return messages === event.messages ? undefined : { messages };
      });
    },
  };

  const l = spec.loader;
  const within = l.contextFilesWithin;
  const loader: PiLoaderOptions = {
    // The project overseer's: the context files pi found inside its root and outside what its file
    // tools never read (the project's own AGENTS.md, never the host's).
    ...(within
      ? {
          agentsFilesOverride: ({ agentsFiles }: { agentsFiles: { path: string }[] }) => {
            const c = new RootConfinement(within.root, within.out);
            return { agentsFiles: agentsFiles.filter((f) => c.problem(f.path) === null) };
          },
        }
      : {}),
    ...(l.noExtensions ? { noExtensions: true } : {}),
    ...(l.noSkills ? { noSkills: true } : {}),
    ...(l.noPromptTemplates ? { noPromptTemplates: true } : {}),
    ...(l.noThemes ? { noThemes: true } : {}),
    ...(l.noContextFiles ? { noContextFiles: true } : {}),
    extensionFactories: [factory, ...(spec.memory && deps.memory ? [deps.memory()] : []), ...(spec.visRetry && deps.visRetry ? [deps.visRetry()] : [])],
    // The OVERRIDE, not appendSystemPrompt: passing appendSystemPrompt suppresses discovery of the
    // user's own APPEND_SYSTEM.md, and the override keeps it (resource-loader.js:386-396).
    appendSystemPromptOverride:
      l.append === "user-then-ours"
        ? (b: string[]) => {
            base = b;
            splice();
            return parts;
          }
        : () => [],
  } as PiLoaderOptions;
  return {
    loader,
    allow: spec.allow,
    customTools: spec.customTools.map((d) => deps.tool(d)),
    ...(l.append === "user-then-ours" ? { promptAtRunStart: () => splice() } : {}),
  };
}
