/**
 * When summarizer runs are allowed. Kept free of pi imports so it is unit-testable.
 *
 * The TUI always runs them. Any other mode (print/json/rpc, including subagent
 * workers) runs them only when its host opts in with the headless flag, as
 * Sova does for the chat runtimes it embeds.
 */

export const HEADLESS_FLAG = "topic-outline-headless";

export function shouldRunOutline(options: { mode: string | undefined; headless: unknown }): boolean {
  return options.mode === "tui" || options.headless === true;
}
