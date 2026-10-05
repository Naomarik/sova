// pi's extension UI on Sova's dialog bridge (§app.harness/session-open): the ExtensionUIContext a hosted
// chat's extensions get (pattern from pi's rpc-mode). select/confirm/input/editor become bridge dialogs,
// notify/setStatus fire-and-forget requests; TUI-only features are no-ops. The chat (server/chat-manager.ts)
// keeps the pending dialogs behind the DialogBridge.
import { type AgentSession, type ExtensionUIContext, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { DialogBridge } from "../../../shared/harness";

// Extensions may read ctx.ui.theme; pi's `theme` singleton isn't exported, so initialize
// it and read the global instance it registers (same key as pi's theme.js).
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
export function currentTheme(): Theme {
  const g = globalThis as Record<symbol, Theme | undefined>;
  if (!g[THEME_KEY]) initTheme(undefined, false);
  return g[THEME_KEY] as Theme;
}

/** The UI context pi hands a chat's extensions, answered through `dialogs`. */
export function createPiUiContext(dialogs: DialogBridge): ExtensionUIContext {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    select: (title, options, opts) => dialogs.open({ method: "select", title, options }, undefined, str, opts),
    confirm: (title, message, opts) => dialogs.open({ method: "confirm", title, message }, false, (v) => v === true, opts),
    input: (title, placeholder, opts) => dialogs.open({ method: "input", title, placeholder }, undefined, str, opts),
    editor: (title, prefill) => dialogs.open({ method: "editor", title, prefill }, undefined, str),
    notify: (message, type) => dialogs.fireAndForget({ method: "notify", message, notifyType: type }),
    setStatus: (key, text) => dialogs.fireAndForget({ method: "setStatus", statusKey: key, statusText: text }),
    onTerminalInput: () => () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined as never,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return currentTheme();
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching not supported in Sova" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

/** Start the session's extensions (pi emits session_start here) with their UI on `dialogs`, in pi's rpc mode. */
export function bindPiExtensions(session: AgentSession, dialogs: DialogBridge, onError: (extensionPath: string, error: string) => void): Promise<void> {
  return session.bindExtensions({
    uiContext: createPiUiContext(dialogs),
    mode: "rpc",
    onError: (err) => onError(err.extensionPath, err.error),
  });
}
