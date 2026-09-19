// wake-nudge: lets the model schedule a one-shot wakeup. At fire time a user
// message tagged [wake_nudge <id>] is sent, starting a new turn even while idle.
//
// No sidecar state: pending nudges are rebuilt from the session branch (tool
// result details, wake-nudge-cancel custom entries, fired wake messages) on
// session_start / session_tree. Timers are only armed from those handlers and
// tool calls, and all are cleared on session_shutdown.

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MIN_DELAY_MS = 10_000;
const MAX_DELAY_MS = 24 * 3600_000;
const MAX_ACTIVE = 5;
const MAX_FIRES = 30; // since last interactive user input
const SETTLE_MS = 2_000; // overdue nudges fire this long after session start
const PAST_TOLERANCE_MS = 60_000;
const STATUS_KEY = "wake-nudge";
const CANCEL_TYPE = "wake-nudge-cancel";
const TAG_RE = /^\[wake_nudge (n\d+)\]/;

interface Nudge {
	id: string;
	reason: string;
	fireAt: number;
	createdAt: number;
}

interface Details {
	action: "schedule" | "list" | "cancel";
	nudge?: Nudge;
	active: Nudge[];
}

function fmtDur(ms: number): string {
	let s = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(s / 3600);
	s -= h * 3600;
	const m = Math.floor(s / 60);
	s -= m * 60;
	if (h) return m ? `${h}h${m}m` : `${h}h`;
	if (m) return s ? `${m}m${s}s` : `${m}m`;
	return `${s}s`;
}

function parseDelay(text: string): number {
	const t = text.trim().toLowerCase();
	const re = /(\d+(?:\.\d+)?)\s*(h|m|s)/g;
	let total = 0;
	let consumed = "";
	for (const match of t.matchAll(re)) {
		total += Number(match[1]) * { h: 3600_000, m: 60_000, s: 1000 }[match[2] as "h" | "m" | "s"];
		consumed += match[0];
	}
	if (!consumed || consumed.replace(/\s/g, "") !== t.replace(/\s/g, "")) {
		throw new Error(`Invalid delay "${text}"; use e.g. 30s, 5m, 1h30m.`);
	}
	return total;
}

function fmtLocal(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const first = content.find((c) => c && c.type === "text");
		return first ? String(first.text) : "";
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	const active = new Map<string, Nudge>();
	const handles = new Map<string, ReturnType<typeof setTimeout>>();
	let seq = 0;
	let firesSinceInput = 0;
	let lastCtx: ExtensionContext | undefined;

	const list = () => [...active.values()].sort((a, b) => a.fireAt - b.fireAt);

	function updateStatus() {
		const ctx = lastCtx;
		if (!ctx?.hasUI) return;
		const next = list()[0];
		ctx.ui.setStatus(STATUS_KEY, next ? `⏰ ${next.id} in ${fmtDur(next.fireAt - Date.now())}` : undefined);
	}

	function clearHandles() {
		for (const h of handles.values()) clearTimeout(h);
		handles.clear();
	}

	function disarm(id: string) {
		const h = handles.get(id);
		if (h) clearTimeout(h);
		handles.delete(id);
		active.delete(id);
	}

	function arm(n: Nudge, delay: number) {
		const prev = handles.get(n.id);
		if (prev) clearTimeout(prev);
		handles.set(n.id, setTimeout(() => fire(n.id), Math.max(0, delay)));
	}

	function fire(id: string) {
		const n = active.get(id);
		handles.delete(id);
		if (!n) return;
		active.delete(id);
		updateStatus();
		firesSinceInput++;
		const now = Date.now();
		const lines = [`[wake_nudge ${n.id}] Scheduled wakeup fired (set ${fmtDur(now - n.createdAt)} ago).`];
		if (now - n.fireAt > 60_000) lines.push(`Overdue by ${fmtDur(now - n.fireAt)} (pi was not running).`);
		lines.push(`Reason: ${n.reason || "(none)"}`);
		lines.push(
			firesSinceInput >= MAX_FIRES
				? `Wake limit (${MAX_FIRES}) reached without user input: do not schedule more nudges; summarize status and wait for the user.`
				: "Continue the pending work; re-schedule if still not ready. Prioritize any newer user message.",
		);
		const text = lines.join("\n");
		if (!lastCtx || lastCtx.isIdle()) pi.sendUserMessage(text);
		else pi.sendUserMessage(text, { deliverAs: "followUp" });
	}

	function reconstruct(ctx: ExtensionContext) {
		lastCtx = ctx;
		clearHandles();
		active.clear();
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message") {
				const msg = e.message as { role?: string; toolName?: string; details?: Partial<Details>; content?: unknown };
				if (msg.role === "toolResult" && msg.toolName === "wake_nudge" && msg.details) {
					const d = msg.details;
					if (d.action === "schedule" && d.nudge) active.set(d.nudge.id, { ...d.nudge });
					else if (d.action === "cancel" && d.nudge) active.delete(d.nudge.id);
				} else if (msg.role === "user") {
					const m = TAG_RE.exec(messageText(msg.content));
					if (m) active.delete(m[1]);
				}
			} else if (e.type === "custom" && e.customType === CANCEL_TYPE) {
				const id = (e.data as { id?: string } | undefined)?.id;
				if (id) active.delete(id);
			}
		}
		// Avoid id collisions with anything already in this branch.
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type !== "message") continue;
			const d = (e.message as { toolName?: string; details?: Partial<Details> }).details;
			const id = (e.message as { toolName?: string }).toolName === "wake_nudge" ? d?.nudge?.id : undefined;
			const num = id ? Number(id.slice(1)) : 0;
			if (num > seq) seq = num;
		}
		const now = Date.now();
		for (const n of active.values()) arm(n, n.fireAt > now ? n.fireAt - now : SETTLE_MS);
		updateStatus();
	}

	function result(action: Details["action"], text: string, nudge?: Nudge) {
		const details: Details = { action, nudge, active: list() };
		return { content: [{ type: "text" as const, text }], details };
	}

	function describe(n: Nudge): string {
		return `${n.id} at ${fmtLocal(n.fireAt)} (in ${fmtDur(n.fireAt - Date.now())})${n.reason ? `: ${n.reason}` : ""}`;
	}

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_shutdown", async () => {
		clearHandles();
		active.clear();
	});
	pi.on("input", async (event) => {
		if (event.source === "interactive") firesSinceInput = 0;
	});

	pi.registerTool({
		name: "wake_nudge",
		label: "Wake nudge",
		description:
			"Schedule a wakeup: at the fire time a user message tagged [wake_nudge <id>] starts a new turn, even while idle.",
		promptSnippet: "wake_nudge: schedule/list/cancel a one-shot wakeup that starts a new turn later.",
		promptGuidelines: [
			"After scheduling a wake_nudge, end your turn; you will be woken at the fire time.",
			"When waiting on something slow, use wake_nudge instead of sleeping or polling.",
		],
		parameters: Type.Object({
			action: StringEnum(["schedule", "list", "cancel"] as const, { description: "What to do" }),
			delay: Type.Optional(Type.String({ description: "Relative delay, e.g. 5m" })),
			at: Type.Optional(Type.String({ description: "Absolute ISO-8601 fire time" })),
			reason: Type.Optional(Type.String({ description: "What to do on wake" })),
			id: Type.Optional(Type.String({ description: "Nudge id to cancel" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const now = Date.now();

			if (params.action === "list") {
				const all = list();
				return result("list", all.length ? all.map(describe).join("\n") : "No pending nudges.");
			}

			if (params.action === "cancel") {
				const n = params.id ? active.get(params.id) : undefined;
				if (!n) throw new Error(`No pending nudge "${params.id ?? ""}".`);
				disarm(n.id);
				updateStatus();
				return result("cancel", `Cancelled ${n.id}.`, n);
			}

			if (firesSinceInput >= MAX_FIRES) {
				throw new Error(`Wake limit (${MAX_FIRES}) reached without user input; wait for the user.`);
			}
			if (active.size >= MAX_ACTIVE) {
				throw new Error(`Max ${MAX_ACTIVE} active nudges: ${list().map((n) => n.id).join(", ")}. Cancel one first.`);
			}
			let fireAt: number;
			if (params.delay && params.at) throw new Error("Give delay or at, not both.");
			if (params.delay) {
				fireAt = now + parseDelay(params.delay);
			} else if (params.at) {
				fireAt = Date.parse(params.at);
				if (Number.isNaN(fireAt)) throw new Error(`Invalid at "${params.at}"; use ISO-8601.`);
				if (fireAt < now - PAST_TOLERANCE_MS) throw new Error(`at "${params.at}" is in the past.`);
			} else {
				throw new Error("schedule needs delay or at.");
			}
			const delay = fireAt - now;
			if (delay < MIN_DELAY_MS) {
				// `at` within the past-tolerance window is clamped rather than rejected.
				if (params.delay) throw new Error("Delay must be at least 10s.");
				fireAt = now + MIN_DELAY_MS;
			}
			if (fireAt - now > MAX_DELAY_MS) throw new Error("Delay must be at most 24h.");

			const nudge: Nudge = { id: `n${++seq}`, reason: params.reason?.trim() ?? "", fireAt, createdAt: now };
			active.set(nudge.id, nudge);
			arm(nudge, fireAt - now);
			updateStatus();
			return result(
				"schedule",
				`Scheduled ${describe(nudge)}\nWakes as [wake_nudge ${nudge.id}]; end your turn now.`,
				nudge,
			);
		},
	});

	pi.registerCommand("nudges", {
		description: "List wake nudges; /nudges cancel <id> | /nudges clear",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const [sub, id] = args.trim().split(/\s+/);
			const say = (text: string) => (ctx.hasUI ? ctx.ui.notify(text, "info") : console.log(text));
			if (sub === "cancel") {
				if (!id || !active.has(id)) return say(`No pending nudge "${id ?? ""}".`);
				disarm(id);
				pi.appendEntry(CANCEL_TYPE, { id });
				updateStatus();
				return say(`Cancelled ${id}.`);
			}
			if (sub === "clear") {
				const ids = [...active.keys()];
				for (const i of ids) {
					disarm(i);
					pi.appendEntry(CANCEL_TYPE, { id: i });
				}
				updateStatus();
				return say(ids.length ? `Cancelled ${ids.join(", ")}.` : "No pending nudges.");
			}
			const all = list();
			say(all.length ? all.map(describe).join("\n") : "No pending nudges.");
		},
	});
}
