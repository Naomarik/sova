/**
 * Design mode: a chat's prototypes. Part of the command catalogue, assembled by shared/commands-catalog.ts
 * (rules: agents/server/commands/overview.md). Pure, erasable syntax only.
 */
import type { CommandEntry, CommandParam } from "./types.ts";

const session: CommandParam = { type: "session", description: "The chat the designs belong to, by id or by path", in: "query", key: "path", required: true };
const label: CommandParam = { type: "string", description: "The design's label (A, B, … AA)", in: "path", required: true };
const run: CommandParam = { type: "string", description: "The design run's id", in: "path", required: true };
const text: CommandParam = { type: "string", description: "What to say to the design", in: "body", required: true };
const key: CommandParam = { type: "string", description: "A key you make: sending again under it delivers nothing twice", in: "body", required: true };

const entry = (e: Omit<CommandEntry, "sessionKey" | "sessionFile" | "meshNeed"> & { meshNeed?: CommandEntry["meshNeed"] }): CommandEntry => ({ sessionKey: "path", sessionFile: "never", meshNeed: "full", ...e });

export const DESIGN_ENTRIES: CommandEntry[] = [
  entry({ id: "design.list", label: "List Designs", summary: "A chat's design runs and designs, without their pages.", effect: "looks", params: { session }, route: { method: "GET", path: "/api/design" } }),
  entry({ id: "design.page", label: "Read Design Page", summary: "A design's finished page as text: the newest, or the version asked for.", effect: "looks", params: { session, label, version: { type: "integer", description: "The version number", in: "query", key: "v" } }, route: { method: "GET", path: "/api/design/:label/page" } }),
  entry({ id: "design.setup.set", label: "Change Design Setup", summary: "Replace a run's Setup card before it starts. Takes the whole setup.", effect: "changes", params: { session, run, setup: { type: "json", description: "The whole setup: brief, models, directions", in: "body", required: true } }, route: { method: "PATCH", path: "/api/design/runs/:run/setup" } }),
  entry({ id: "design.start", label: "Start Design Coordinator", summary: "Start a run's coordinator, which then launches the designs.", effect: "changes", params: { session, run, confirm: { type: "boolean", description: "Confirm a run above the free limit", in: "body", key: "confirmSpend" } }, route: { method: "POST", path: "/api/design/runs/:run/start" } }),
  entry({ id: "design.message", label: "Message a Design", summary: "Send a design's session a message. It waits if the session is busy.", effect: "changes", params: { session, label, text, key }, route: { method: "POST", path: "/api/design/:label/message" } }),
  entry({ id: "design.refine", label: "Refine a Design", summary: "Hand a design back with what to change: it looks at its page at desktop and phone width and fixes it.", effect: "changes", params: { session, label, text, key, quick: { type: "list", description: "Quick prompts to add", in: "body" } }, route: { method: "POST", path: "/api/design/:label/refine" } }),
  entry({ id: "design.retry", label: "Retry a Design", summary: "Try a failed design again in a fresh session.", effect: "changes", params: { session, label }, route: { method: "POST", path: "/api/design/:label/retry" } }),
  entry({ id: "design.coordinator.message", label: "Message the Design Coordinator", summary: "Send a chat's design coordinator a message. It waits if the coordinator is busy.", effect: "changes", params: { session, text: { type: "string", description: "What to say to the coordinator", in: "body", required: true }, key }, route: { method: "POST", path: "/api/design/coordinator/message" } }),
  entry({ id: "design.delete", label: "Delete a Design", summary: "Remove one design from its chat.", effect: "changes", params: { session, label }, route: { method: "DELETE", path: "/api/design/:label" } }),
];
