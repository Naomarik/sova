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
