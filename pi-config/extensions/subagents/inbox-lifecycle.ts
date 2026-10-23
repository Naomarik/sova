/**
 * Pure helpers for an inbox's end of life (§app.teams/inbox "Moving and returning"): where each
 * item a member leaves unaddressed goes back to, and the "not addressed" notice its sender gets.
 * No process, UI or manager dependency; index.ts performs every delivery.
 */
import { MAX_BODY_CHARS, type InboxItem, type InboxParty } from "./inbox.ts";

/** customType of a returned-items notice to the main chat (displayed, no turn). */
export const TEAM_NOTICE_TYPE = "team-notice";

/** Where a returned item's notice goes: its member sender, or (Sova's own and the main thread's) the routing coordinator / main chat. */
export type ReturnTarget = { kind: "member"; to: InboxParty } | { kind: "sova" } | { kind: "main" };

export function returnTarget(item: InboxItem): ReturnTarget {
	if (item.from.workerId !== "parent") return { kind: "member", to: item.from };
	return item.from.role === "main thread" ? { kind: "main" } : { kind: "sova" };
}

/** Returned items grouped by where their notice goes, oldest first within each group. */
export function groupReturns(items: readonly InboxItem[]): { target: ReturnTarget; items: InboxItem[] }[] {
	const groups = new Map<string, { target: ReturnTarget; items: InboxItem[] }>();
	for (const item of [...items].sort((a, b) => a.sentAt - b.sentAt)) {
		const target = returnTarget(item);
		const key = target.kind === "member" ? `member:${target.to.workerId}` : target.kind;
		let g = groups.get(key);
		if (!g) groups.set(key, (g = { target, items: [] }));
		g.items.push(item);
	}
	return [...groups.values()];
}

/** Why a member ended with no successor, as its senders are told. */
export function endReason(state: { status?: string; error?: string; ejected?: boolean; restored?: boolean }): string {
	if (state.ejected) return "it was ejected";
	if (state.restored) return "its process had ended when the main chat restarted";
	if (state.status === "killed") return "it was stopped";
	if (state.error || state.status === "error") return "it failed";
	return "it ended";
}

/**
 * The "not addressed" notice for one group of returned items: who held them, why they came back,
 * one line per item (id, kind, subject, sent), each body when room allows, and what to do next.
 */
export function returnNoticeText(holder: InboxParty, teamId: string, why: string, items: readonly InboxItem[], forSova = false): string {
	const head = `[Not addressed: ${items.length} item(s) returned from ${holder.role} (${holder.workerId}), ${teamId} — ${why}, with no successor]`;
	const tail = forSova
		? `These were Sova's notices to ${holder.role}; route the work to another member, start a successor with team_succeed, or ask the main thread.`
		: `Send them again to another member, or ask the main thread to bring ${holder.role} back with agent_resume ${holder.workerId}.`;
	const lines = items.map((i) => `- ${i.id} ${i.kind}${i.urgent ? " (urgent)" : ""} sent ${new Date(i.sentAt).toISOString()} — ${i.subject}`);
	const budget = MAX_BODY_CHARS - head.length - tail.length - lines.join("\n").length - 64;
	const bodies: string[] = [];
	let used = 0;
	for (const i of items) {
		if (i.body.trim() === i.subject.trim()) continue;
		const block = `${i.id}:\n${i.body}`;
		if (used + block.length > budget) {
			bodies.push(`(Other bodies not shown: ${MAX_BODY_CHARS.toLocaleString("en-US")}-character limit.)`);
			break;
		}
		used += block.length + 2;
		bodies.push(block);
	}
	const text = [head, ...lines, ...(bodies.length ? ["", ...bodies, ""] : []), tail].join("\n");
	return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
}
