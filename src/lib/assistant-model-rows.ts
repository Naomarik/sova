// The Owner card's Project Assistant model rows (§app.owner-page/controls, §app.project-assistant/models).
import type { WorkKind } from "../../shared/powers";

export const WORK_LABEL: Record<WorkKind, string> = { reply: "Its replies", coding: "Fixes it starts", gathering: "Feature request chats it starts" };

/** The kinds the card shows, in order: every kind (gathering runs its feature request chats). */
export const SHOWN_KINDS: WorkKind[] = ["reply", "coding", "gathering"];
