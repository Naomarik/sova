import { CustomEditor, getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext,
  type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Palette, type MenuItem } from "./menu.ts";
import { ModelFavorites } from "./favorites.ts";
import { CATEGORY_DISCOVER_EVENT, CATEGORY_REGISTER_EVENT, OPEN_EVENT,
  type CategoryDiscovery, type CategoryProvider, type OpenRequest } from "./contracts.ts";
import { join } from "node:path";
import { globallyEnabled, readPolicy } from "../model-policy/policy.ts";

type FavoriteStore = Pick<ModelFavorites, "has" | "set">;

type Editor = ReturnType<NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>>;

// Only these known interactive commands may use the editor's submit callback.
// sendUserMessage('/settings') would send text to the model instead of opening UI.
const groups: [string, [string, string, string?][]][] = [
  ["Sessions", [
    ["new", "New session"], ["resume", "Resume session"], ["name", "Rename session"],
    ["tree", "Session tree"], ["fork", "Fork from a message"], ["clone", "Clone current branch"],
    ["session", "Session information"], ["compact", "Compact context"],
  ]],
  ["Settings", [["settings", "All settings", "Theme, delivery, transport and preferences"],
    ["trust", "Project trust"], ["reload", "Reload Pi resources", "Extensions, keybindings, skills, prompts and themes"]]],
  ["Providers", [["login", "Log in / configure provider"], ["logout", "Log out of provider"]]],
  ["Share & export", [["copy", "Copy last response"], ["export", "Export session", "HTML or JSONL"],
    ["import", "Import session", "Resume from a JSONL file"], ["share", "Share session", "Upload to a private GitHub gist"]]],
  ["Help", [["hotkeys", "Keyboard shortcuts"], ["changelog", "Changelog"], ["quit", "Quit Pi"]]],
];

export function modelItems(pi: ExtensionAPI, ctx: ExtensionContext, favorites?: FavoriteStore, policyFile?: string): MenuItem[] {
  const scoped = ctx.scopedModels;
  const models = scoped.length ? scoped.map(entry => entry.model) : ctx.modelRegistry.getAvailable();
  // Models turned off in Sova's Settings → Models are not choices: the palette is a picker, and
  // listing one here would offer a model the session refuses to run (../model-policy/policy.ts).
  const policy = readPolicy(policyFile);
  return models.filter(model => globallyEnabled(policy, "pi", `${model.provider}/${model.id}`)).map(model => {
    const current = model.provider === ctx.model?.provider && model.id === ctx.model?.id;
    const levels = getSupportedThinkingLevels(model);
    const preferred = current ? ctx.thinkingLevel : scoped.find(entry =>
      entry.model.provider === model.provider && entry.model.id === model.id)?.thinkingLevel ?? ctx.thinkingLevel;
    // These are tentative choices local to this palette opening, not changes to
    // the running session. Pi's helpers honor each model's thinkingLevelMap.
    let level = clampThinkingLevel(model, preferred ?? pi.getThinkingLevel());
    return {
      id: `model:${model.provider}/${model.id}`,
      label: `${current ? "✓ " : ""}${model.provider}/${model.id}`,
      description: `${model.provider} · ${model.name}${model.input?.includes("image") ? " · vision" : ""}`,
      favorite: favorites ? {
        isFavorite: () => favorites.has(model),
        toggle: () => favorites.set(model, !favorites.has(model)),
      } : undefined,
      value: () => levels.length > 1 ? `‹ ${level} ›` : levels.length ? `[${level}]` : "[unavailable]",
      adjust: (direction: -1 | 1) => {
        if (levels.length > 1) level = levels[(levels.indexOf(level) + direction + levels.length) % levels.length]!;
      },
      run: async () => {
        if (!levels.length) {
          ctx.ui.notify("This model does not advertise a supported thinking level.", "warning");
          return;
        }
        if (!await pi.setModel(model)) {
          ctx.ui.notify(`Could not select ${model.provider}/${model.id}: authentication is not configured.`, "error");
          return;
        }
        pi.setThinkingLevel(level);
      },
    };
  });
}

export default function commandPalette(pi: ExtensionAPI) {
  let editor: Editor | undefined;
  let active = false;
  let generation = 0;
  // Filled synchronously by discovery on each open; never cached across opens.
  const providers: CategoryProvider[] = [];
  pi.events.on(CATEGORY_REGISTER_EVENT, (data: unknown) => {
    const provider = data as CategoryProvider | undefined;
    if (provider?.version === 1 && typeof provider.id === "string" && typeof provider.items === "function") providers.push(provider);
  });

  pi.on("session_start", (_event, ctx) => {
    generation++;
    if (ctx.mode !== "tui") return;
    const previous = ctx.ui.getEditorComponent();
    // Retain any existing custom editor. Pi wires its public onSubmit callback
    // after this factory returns; no terminal injection or private host access.
    ctx.ui.setEditorComponent((tui, theme, keys) => {
      editor = previous?.(tui, theme, keys) ?? new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
      return editor;
    });
  });
  pi.on("session_shutdown", () => { generation++; editor = undefined; });

  pi.on("model_select", async (event, ctx) => {
    // Restoring an old session (or a background agent choosing a model) must
    // not overwrite the user's next-session preference.
    if (ctx.mode !== "tui" || (event.source !== "set" && event.source !== "cycle")) return;
    try {
      // Use Pi's own locking/merge behavior, and touch only the global pair.
      // A fresh manager sees other panes' settings without reading project config.
      const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: false });
      const current = settings.getGlobalSettings();
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        throw new Error("Global settings must be a JSON object.");
      }
      settings.setDefaultModelAndProvider(event.model.provider, event.model.id);
      await settings.flush();
      // SettingsManager queues storage errors instead of rejecting flush().
      const failure = settings.drainErrors()[0];
      if (failure) throw failure.error;
    } catch (error) {
      ctx.ui.notify(`Model selected, but could not save the startup default: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  async function submitBuiltin(ctx: ExtensionContext, command: string) {
    const target = editor;
    if (!target?.onSubmit) throw new Error("Palette editor integration is unavailable. Run /reload.");
    const draft = ctx.ui.getEditorText();
    const version = generation;
    const restore = () => {
      // Never replace text supplied by a picker, another command, or the user.
      // A session replacement owns its own editor; do not reuse the old context.
      if (generation === version && editor === target && draft && !target.getText()) target.setText(draft);
    };
    try {
      const pending = target.onSubmit(command);
      restore();
      await pending;
    } finally { restore(); }
  }

  function builtin(ctx: ExtensionContext, name: string, label: string, description?: string): MenuItem {
    return { id: `builtin:${name}`, label, description: description ?? `/${name}`, run: async () => {
      // Session and persistence operations should not race a running agent.
      if (!ctx.isIdle() && ["new", "resume", "fork", "clone", "tree", "import", "reload", "compact"].includes(name)) {
        ctx.ui.notify("Wait for the current response to finish, or cancel it first.", "warning");
        return;
      }
      let args = "";
      if (name === "name" || name === "import" || name === "export") {
        const value = await ctx.ui.input(label, name === "name" ? "Session name" : name === "import" ? "Path to JSONL file" : "Optional output path (.html or .jsonl)");
        if (value === undefined || (name !== "export" && !value.trim())) return;
        args = value.trim();
      }
      if (name === "share" && !await ctx.ui.confirm("Upload this conversation?", "This uploads the session to a private GitHub gist. Anyone with its URL can read it.")) return;
      if (name === "quit" && !await ctx.ui.confirm("Quit Pi?", "The current session is saved automatically.")) return;
      await submitBuiltin(ctx, `/${name}${args ? ` ${args}` : ""}`);
    } };
  }

  function items(ctx: ExtensionContext): MenuItem[] {
    const roots: MenuItem[] = groups.map(([label, commands]) => ({ id: label, label,
      children: commands.map(([name, text, description]) => builtin(ctx, name, text, description)),
    }));
    let favorites: FavoriteStore;
    try { favorites = new ModelFavorites(join(getAgentDir(), "model-favorites.json")); }
    catch (error) {
      // Keep other commands and Show all usable, but never overwrite unreadable preferences.
      ctx.ui.notify(`Could not load model favorites: ${error instanceof Error ? error.message : String(error)}`, "error");
      favorites = { has: () => false, set: () => { throw error; } };
    }
    roots.unshift({ id: "Models & thinking", label: "Models & thinking", modelGroup: true,
      description: "Favorites · Ctrl+A show all · ←→ thinking level", children: modelItems(pi, ctx, favorites) });
    providers.length = 0;
    pi.events.emit(CATEGORY_DISCOVER_EVENT, { version: 1 } satisfies CategoryDiscovery);
    const seen = new Set<string>();
    const categories: MenuItem[] = [];
    for (const provider of providers.splice(0)) {
      if (seen.has(provider.id)) continue;
      seen.add(provider.id);
      try {
        categories.push({ id: provider.id, label: provider.label, description: provider.description, children: provider.items(ctx) });
      } catch (error) {
        // One broken provider must not take the rest of the palette down.
        ctx.ui.notify(`Palette category ${provider.label}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
    roots.splice(1, 0, ...categories);
    roots.find(r => r.id === "Settings")!.children!.push(
      builtin(ctx, "scoped-models", "Configure model cycling", "Choose and reorder models shown in the palette"),
      {
      id: "themes", label: "Theme", description: "Choose a theme", children: ctx.ui.getAllThemes().map(theme => ({
        id: `theme:${theme.name}`, label: theme.name, run: () => {
          const result = ctx.ui.setTheme(theme.name);
          if (!result.success) ctx.ui.notify(result.error ?? "Could not change theme", "error");
        },
      })),
    });
    roots.push({ id: "display", label: "Display", children: [
      { id: "expand-tools", label: "Expand tool output", run: () => ctx.ui.setToolsExpanded(true) },
      { id: "collapse-tools", label: "Collapse tool output", run: () => ctx.ui.setToolsExpanded(false) },
    ] });
    for (const [source, label] of [["extension", "Extensions"], ["prompt", "Prompt templates"], ["skill", "Skills"]] as const) {
      const commands = pi.getCommands().filter(c => c.source === source && c.name !== "palette");
      roots.push({ id: source, label, children: commands.map(c => {
        const run = async (ask: boolean) => {
          const args = ask ? await ctx.ui.input(`/${c.name}`, "Arguments (optional)") : "";
          if (args === undefined) return;
          const command = `/${c.name}${args.trim() ? ` ${args.trim()}` : ""}`;
          if (source === "extension") {
            pi.sendUserMessage(command, { expandPromptTemplates: true, deliverAs: "followUp" });
          } else {
            // Skills and templates start model work. Compose for review, never
            // submit just because someone selected a search result.
            const draft = ctx.ui.getEditorText();
            const composed = await ctx.ui.editor(`Compose /${c.name} (submit from main editor)`, command + (draft ? `\n${draft}` : ""));
            if (composed !== undefined) ctx.ui.setEditorText(composed);
          }
        };
        return { id: `${source}:${c.name}`, label: `/${c.name}`, description: c.description, children: [
          { id: `${c.name}:run`, label: source === "extension" ? "Run command" : "Compose prompt", run: () => run(false) },
          { id: `${c.name}:args`, label: "With arguments…", run: () => run(true) },
        ] };
      }) });
    }
    return roots;
  }

  async function open(ctx: ExtensionContext, path?: string[]) {
    if (ctx.mode !== "tui" || active) return;
    active = true;
    try {
      const item = await ctx.ui.custom<MenuItem | undefined>((tui, theme, keys, done) =>
        new Palette(items(ctx), theme, keys, () => tui.requestRender(),
          () => tui.terminal.rows - 2, done, path),
      { overlay: true, overlayOptions: { width: "80%", anchor: "top-center", offsetY: 1, margin: 1 } });
      await item?.run?.();
    } catch (error) {
      ctx.ui.notify(`Command palette: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally { active = false; }
  }
  pi.registerShortcut("ctrl+p", { description: "Open command palette", handler: ctx => open(ctx) });
  // `/palette mode` opens at a category; ids match case-insensitively.
  pi.registerCommand("palette", { description: "Search commands and submenus; optional category id opens it directly",
    handler: (args, ctx) => open(ctx, args.trim() ? [args.trim()] : undefined) });
  // Other extensions deep-link through requestPaletteOpen (contracts.ts).
  pi.events.on(OPEN_EVENT, (data: unknown) => {
    const request = data as OpenRequest | undefined;
    if (request?.version !== 1 || request.ctx?.mode !== "tui" || active) return;
    request.claim(open(request.ctx, request.path));
  });
}
