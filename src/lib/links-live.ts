// Each open chat's linked agents as its socket last pushed them (the `links` frame, §mesh.links/
// agents-pane), by session path: the Agents tab reads them without waiting for the insight poll.
// Absent for a path: no chat socket (watching, or not open), so the pane falls back to the insight.

import { createStore, reconcile } from "solid-js/store";
import type { LinkedAgentInfo } from "../../shared/mesh-links";

const [links, setLinks] = createStore<Record<string, LinkedAgentInfo[] | undefined>>({});

/** The chat socket's list for `path`; null while no chat socket has said. */
export const chatLinks = (path: string): LinkedAgentInfo[] | null => links[path] ?? null;

/** A `links` frame ([] = none left); null on hello (a runtime sends a frame only when there are
    links, so until one comes the insight speaks) and when the chat socket for `path` goes away.
    Reconciled by key, so rows keep their identity. */
export function noteLinks(path: string, list: LinkedAgentInfo[] | null): void {
  if (!list) return setLinks(path, undefined);
  if (!links[path]) setLinks(path, []);
  setLinks(path, reconcile(list, { key: "key" }));
}
