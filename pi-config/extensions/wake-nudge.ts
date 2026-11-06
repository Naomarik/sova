// wake-nudge: lets the model schedule a one-shot wakeup. At fire time a user
// message tagged [wake_nudge <id>] is sent, starting a new turn even while idle.
//
// Pending nudges are rebuilt from the session branch (tool result details,
// wake-nudge-cancel custom entries, fired wake messages) on session_start /
// session_tree. Timers are only armed from those handlers and tool calls, and all
// are cleared on session_shutdown.
//
// In a chat a host started, each change also publishes the due times to the wake
// store (subagents/wake-store.ts), so the host can bring the chat back for a nudge
// after it shut down. A nudge stays published until its message is on the branch;
// a rebuild publishes again, which drops what the branch no longer has. The file
// is only ever a copy of the branch: the branch decides what fires.
//
// The same chat delivers its background jobs' end cards (subagents/job-store.ts): the host marks a
// job ended and publishes a "jobs" wake item; this extension sends the card, tagged [job j1], counted
// toward the same wake limit, and records it delivered once it is on the branch. A job stopped from
// Sova sends no card: the chat gets a quiet note at the start of its next run instead.

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { JOB_TAG_RE, JOBS_WAKE_SOURCE, jobCardText, jobStoppedNote, jobStoreOf, markCardDone, pendingCards, type JobRecord, type JobStore } from "./subagents/job-store.ts";
import { WAKE_WORKER_ENV, publishWakes, wakeStoreOf, wakesCancelledBefore, type WakeStore } from "./subagents/wake-store.ts";

const MIN_DELAY_MS = 10_000;
const MAX_DELAY_MS = 24 * 3600_000;
const MAX_ACTIVE = 5;
const MAX_FIRES = 30; // since last interactive user input
const SETTLE_MS = 2_000; // overdue nudges fire this long after session start
const PAST_TOLERANCE_MS = 60_000;
const STATUS_KEY = "wake-nudge";
const CANCEL_TYPE = "wake-nudge-cancel";
const COUNT_TYPE = "wake-nudge-count"; // {n}: fires since the last reset; the newest in the file holds
const WAKE_SOURCE = "nudges";
const CLOCK_CHECK_MS = 15_000; // a timer stopped by a machine's sleep fires this soon after it wakes
const TAG_RE = /^\[wake_nudge (n\d+)\]/;
const JOB_POLL_MS = 5_000; // a running chat looks for its jobs' ends this often
const JOB_NOTE_TYPE = "background-job-note";

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

/**
 * What sets the wake count back to zero, in one place. A person's typed message does. So does a new
 * instruction a worker gets from its main chat: a worker has no composer. For any other chat a
 * queued message (another chat, the Overseer, a brief) never does.
 */
export function resetsWakeCount(source: string | undefined, isWorker: boolean): boolean {
	return source === "interactive" || (isWorker && source === "rpc");
}

export default function (pi: ExtensionAPI) {
	const active = new Map<string, Nudge>();
	const handles = new Map<string, ReturnType<typeof setTimeout>>();
	/** Fired, its message not on the branch yet: still published, so a death in between loses nothing. */
	const firing = new Map<string, Nudge>();
	let seq = 0;
	let firesSinceInput = 0;
	let lastCtx: ExtensionContext | undefined;
	let store: WakeStore | undefined;
	let clockCheck: ReturnType<typeof setInterval> | undefined;
	let jobs: JobStore | undefined;
	let jobPoll: ReturnType<typeof setInterval> | undefined;
	let jobSettle: ReturnType<typeof setTimeout> | undefined;
	/** Job cards sent, not on the branch yet. */
	const jobFiring = new Set<string>();

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

	function publish() {
		if (!store) return;
		try {
			publishWakes(store, WAKE_SOURCE, [...active.values(), ...firing.values()].map((n) => ({ id: n.id, at: n.fireAt })));
		} catch {
			/* The branch still holds it; the next change writes again. */
		}
	}

	function setCount(n: number) {
		firesSinceInput = n;
		pi.appendEntry(COUNT_TYPE, { n });
	}

	/** A timer can sleep through the machine's sleep: the wall clock says what is due. */
	function checkClock() {
		const now = Date.now();
		for (const n of [...active.values()]) if (n.fireAt + 1000 <= now && handles.has(n.id)) fire(n.id);
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
		firing.set(id, n);
		updateStatus();
		// Counted first: a process that dies after the fire can't undercount the chain.
		setCount(firesSinceInput + 1);
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
		publish();
	}

	/** The end cards still owed, as wake items: what brings this chat back for them. */
	function publishJobs() {
		if (!store || !jobs) return;
		try {
			const items = pendingCards(jobs.dir, jobs.sessionId)
				.filter((j) => j.ended!.card === "wake")
				.map((j) => ({ id: j.id, at: j.ended!.at }));
			publishWakes(store, JOBS_WAKE_SOURCE, items);
		} catch {
			/* The job records still hold them; the next look writes again. */
		}
	}

	/** Send the end cards of jobs that ended: every job a machine restart ended in one card, any other one each. */
	function deliverJobs() {
		if (!jobs || !lastCtx) return;
		let pending: JobRecord[];
		try {
			pending = pendingCards(jobs.dir, jobs.sessionId).filter((j) => j.ended!.card === "wake" && !jobFiring.has(j.id));
		} catch {
			return;
		}
		if (!pending.length) return;
		const restart = pending.filter((j) => j.ended!.how === "restart");
		const groups = [...(restart.length ? [restart] : []), ...pending.filter((j) => j.ended!.how !== "restart").map((j) => [j])];
		for (const group of groups) {
			if (firesSinceInput >= MAX_FIRES) {
				// Past the limit the job stays recorded and no card is sent.
				for (const j of group) markCardDone(jobs.dir, jobs.sessionId, j.id, "skipped");
				continue;
			}
			setCount(firesSinceInput + 1);
			const late = Math.max(0, ...group.map((j) => j.ended!.late ?? 0));
			const text = jobCardText(group, { late, limitHit: firesSinceInput >= MAX_FIRES, limit: MAX_FIRES });
			for (const j of group) jobFiring.add(j.id);
			if (lastCtx.isIdle()) pi.sendUserMessage(text);
			else pi.sendUserMessage(text, { deliverAs: "followUp" });
		}
		publishJobs();
	}

	function reconstruct(ctx: ExtensionContext) {
		lastCtx = ctx;
		jobs = jobStoreOf(ctx.sessionManager.getSessionId?.(), ctx.sessionManager.getSessionFile?.());
		jobFiring.clear();
		clearHandles();
		active.clear();
		firing.clear();
		store = wakeStoreOf(ctx.sessionManager.getSessionId?.(), ctx.sessionManager.getSessionFile?.());
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
		// Archiving the chat cancelled these, with or without a process to say so.
		const cancelled = store ? wakesCancelledBefore(store.dir, store.sessionId) : 0;
		for (const n of [...active.values()]) if (n.createdAt <= cancelled) active.delete(n.id);
		// The newest count in the file, whichever branch wrote it: a rewind is not a typed message.
		firesSinceInput = 0;
		for (const e of ctx.sessionManager.getEntries()) {
			if (e.type !== "custom" || e.customType !== COUNT_TYPE) continue;
			const n = (e.data as { n?: unknown } | undefined)?.n;
			if (typeof n === "number" && n >= 0) firesSinceInput = n;
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
		publish();
		publishJobs();
		if (jobs) {
			if (jobSettle) clearTimeout(jobSettle);
			jobSettle = setTimeout(deliverJobs, SETTLE_MS);
			if (!jobPoll) {
				jobPoll = setInterval(deliverJobs, JOB_POLL_MS);
				jobPoll.unref?.();
			}
		}
		if (!clockCheck) {
			clockCheck = setInterval(checkClock, CLOCK_CHECK_MS);
			clockCheck.unref?.();
		}
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
		// The published record stays: it is what brings this chat back.
		if (clockCheck) clearInterval(clockCheck);
		clockCheck = undefined;
		if (jobPoll) clearInterval(jobPoll);
		jobPoll = undefined;
		if (jobSettle) clearTimeout(jobSettle);
		jobSettle = undefined;
		jobs = undefined;
		jobFiring.clear();
		clearHandles();
		active.clear();
		firing.clear();
		store = undefined;
	});
	pi.on("input", async (event) => {
		if (firesSinceInput > 0 && resetsWakeCount(event.source, process.env[WAKE_WORKER_ENV] === "1")) setCount(0);
	});
	pi.on("message_end", async (event) => {
		const msg = event.message as { role?: string; content?: unknown };
		if (msg.role !== "user") return;
		const text = messageText(msg.content);
		const j = JOB_TAG_RE.exec(text);
		if (j && jobs) {
			for (const id of j[1].split(",")) {
				if (!jobFiring.delete(id)) continue;
				try {
					markCardDone(jobs.dir, jobs.sessionId, id, "sent");
				} catch {
					/* sent again at the next start: better twice than never */
				}
			}
			publishJobs();
			return;
		}
		if (!firing.size) return;
		const m = TAG_RE.exec(text);
		if (m && firing.delete(m[1])) publish();
	});
	// A job stopped from Sova costs no reply: the chat reads it at the start of its next run.
	pi.on("before_agent_start", async () => {
		if (!jobs) return;
		let notes: JobRecord[];
		try {
			notes = pendingCards(jobs.dir, jobs.sessionId).filter((j) => j.ended!.card === "note");
		} catch {
			return;
		}
		if (!notes.length) return;
		for (const j of notes) markCardDone(jobs.dir, jobs.sessionId, j.id, "noted");
		return { message: { customType: JOB_NOTE_TYPE, content: notes.map(jobStoppedNote).join("\n"), display: true } };
	});

	// A chat loaded only to deliver its jobs' end cards (SOVA_JOB_CARDS=only) has no wake_nudge of its own.
	if (process.env.SOVA_JOB_CARDS !== "only") pi.registerTool({
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
				publish();
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
			publish();
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
				publish();
				return say(`Cancelled ${id}.`);
			}
			if (sub === "clear") {
				const ids = [...active.keys()];
				for (const i of ids) {
					disarm(i);
					pi.appendEntry(CANCEL_TYPE, { id: i });
				}
				updateStatus();
				publish();
				return say(ids.length ? `Cancelled ${ids.join(", ")}.` : "No pending nudges.");
			}
			const all = list();
			say(all.length ? all.map(describe).join("\n") : "No pending nudges.");
		},
	});
}
