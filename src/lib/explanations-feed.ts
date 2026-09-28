import { createSignal } from "solid-js";
import type { ExplanationInfo } from "../../shared/protocol";

/**
 * The app's /api/explanations poll, readable by any view (as agents-feed is for #/agents): what a
 * session view's strip shows of the session's explanations before its own insight lands.
 */
const [source, setSource] = createSignal<() => ExplanationInfo[] | undefined>(() => undefined);
export const explanationsFeed = (): ExplanationInfo[] | undefined => source()();
export const setExplanationsFeedSource = (read: () => ExplanationInfo[] | undefined) => setSource(() => read);
