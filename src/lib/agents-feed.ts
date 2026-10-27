import { createSignal } from "solid-js";
import type { AgentsInsight } from "../../shared/protocol";

/**
 * The app's #/agents poll, readable by any view. App registers its poll's accessor once; a
 * reader tracks the fields it reads through it (the poll reconciles into one store, so the
 * object itself never changes — only its fields do).
 */
const [source, setSource] = createSignal<() => AgentsInsight | undefined>(() => undefined);
export const agentsFeed = (): AgentsInsight | undefined => source()();
export const setAgentsFeedSource = (read: () => AgentsInsight | undefined) => setSource(() => read);

/**
 * How many shown Agents boards want per-session tokens (§app.insights/session-token-rate). The app's
 * one agents poll asks for them (`?tokens=1`) only while this is above 0, so every other page's poll
 * (the sidebar's feed) costs what it did before the column. The poll itself pauses while the tab is hidden.
 */
let tokenWanters = 0;
export const agentsTokensWanted = (): boolean => tokenWanters > 0;
/** A board shown: ask from the next request on; the returned function stops asking. */
export function wantAgentsTokens(): () => void {
  tokenWanters++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    tokenWanters--;
  };
}
