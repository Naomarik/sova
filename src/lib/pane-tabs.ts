// The session pane's tab strip, and which tab it opens on. Pure (no DOM, no Solid), so it tests under tsx.

export type TabId = "session" | "timeline" | "agents" | "usage" | "time" | "context" | "sharing" | "explain";

export const TABS: readonly { id: TabId; label: string }[] = [
  { id: "session", label: "Session" },
  { id: "timeline", label: "Timeline" },
  { id: "agents", label: "Agents" },
  { id: "usage", label: "Usage" },
  { id: "time", label: "Time Spent" },
  { id: "context", label: "Context" },
  { id: "sharing", label: "Sharing" },
  { id: "explain", label: "Explain" },
];

const isTab = (id: string | null): id is TabId => TABS.some((t) => t.id === id);

/** The tab showing: the one kept for this session while the strip has it, else the pane's fallback. Pure. */
export const openingTab = (kept: string | null, fallback: TabId): TabId => (isTab(kept) ? kept : fallback);
