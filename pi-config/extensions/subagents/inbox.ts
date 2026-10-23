/**
 * Team inbox store: one append-only `items.jsonl` per team member, under the main chat's
 * mailbox root (`<root>/<team_NN>/<ag_NN>/items.jsonl`). Only the parent extension (the main
 * chat) writes these files; members reach their inbox through mailbox requests the parent
 * serves, so a status mark can never race a new delivery.
 *
 * Every line is one op: add, status, listed, move, return. The fold replays them in order and
 * skips a torn or unknown line. Item ids (`i_<base36>`) are unique and increasing across the
 * whole main chat, never reused; a moved item keeps its id and its original sender.
 *
 * Node builtins only, erasable TypeScript: Sova's server imports the read helpers.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const INBOX_FILE = "items.jsonl";
export const CAPS_FILE = "caps.json";
export const MAX_SUBJECT_CHARS = 120;
export const MAX_BODY_CHARS = 8000;
export const MAX_NOTE_CHARS = 200;
/** Addressed (and other closed) items compaction keeps per member, newest first. */
export const KEEP_CLOSED_ITEMS = 2000;
const COMPACT_SLACK = 200;
const COMPACT_BYTES = 8 * 1024 * 1024;
const SEQ_FILE = "inbox-seq.json";

export type InboxKind = "message" | "question" | "report" | "handover" | "notice" | "instruction";
export type InboxStatus = "new" | "read" | "addressed";
export const INBOX_KINDS: readonly InboxKind[] = ["message", "question", "report", "handover", "notice", "instruction"];
/** A member, or the main chat: `{ role: "main thread", workerId: "parent" }`, or Sova: `{ role: "Sova", workerId: "parent" }`. */
export interface InboxParty { role: string; workerId: string }
export const MAIN_THREAD: InboxParty = { role: "main thread", workerId: "parent" };
export const SOVA: InboxParty = { role: "Sova", workerId: "parent" };
export interface InboxMove { workerId: string; role: string; at: number; why: "handover" | "forward" }
export interface InboxItem {
	id: string;
	teamId: string;
	from: InboxParty;
	/** The member holding the item now. */
	to: InboxParty;
	kind: InboxKind;
	urgent: boolean;
	subject: string;
	body: string;
	replyTo?: string;
	broadcastId?: string;
	/** Whom it was held by before, oldest first (forwarded to a successor, moved at a handover). */
	movedFrom?: InboxMove[];
	sentAt: number;
	status: InboxStatus;
	readAt?: number;
	addressedAt?: number;
	note?: string;
	/** The last accepted wake that listed it. */
	listedAt?: number;
	/** Sent back to its sender, not addressed: no longer open. */
	returned?: { at: number; why: string };
}
export type InboxOp =
	| { v: 1; op: "add"; item: InboxItem }
	| { v: 1; op: "status"; id: string; status: InboxStatus; at: number; note?: string }
	| { v: 1; op: "listed"; ids: string[]; at: number }
	| { v: 1; op: "move"; id: string; to: InboxParty; at: number; why: "handover" | "forward" }
	| { v: 1; op: "return"; id: string; at: number; why: string };

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const ITEM_ID = /^i_[0-9a-z]{1,12}$/;
const TEAM_ID = /^team_\d+$/;
const WORKER_ID = /^ag_\d+$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 100_000): v is string => typeof v === "string" && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const isItemId = (v: unknown): v is string => typeof v === "string" && ITEM_ID.test(v);
export const itemSeq = (id: string): number => parseInt(id.slice(2), 36);
export const itemIdOf = (seq: number): string => `i_${seq.toString(36)}`;
const byId = (a: InboxItem, b: InboxItem) => itemSeq(a.id) - itemSeq(b.id);

/** Open: new or read, never returned, and never an instruction (those are history only). */
export const isOpen = (item: InboxItem): boolean => item.kind !== "instruction" && !item.returned && item.status !== "addressed";

/** One line, no control characters, cut to `max`. */
export function oneLine(text: string, max: number): string {
	const line = text.replace(/\r?\n|\r|\t/g, " ").replace(CONTROL, "").replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
/** The sender's subject, else the first non-blank line of the body, cut to 120. */
export function subjectOf(body: string, subject?: string): string {
	const given = subject === undefined ? "" : oneLine(subject, MAX_SUBJECT_CHARS);
	if (given) return given;
	const first = body.split(/\r?\n/).find((l) => l.trim()) ?? "";
	return oneLine(first, MAX_SUBJECT_CHARS) || "(no subject)";
}

export const itemsFile = (memberDir: string): string => path.join(memberDir, INBOX_FILE);
export const capsFile = (memberDir: string): string => path.join(memberDir, CAPS_FILE);

function decodeParty(v: unknown): InboxParty | undefined {
	if (!isRecord(v) || !isStr(v.role, 200) || !isStr(v.workerId, 40) || !v.role) return undefined;
	if (v.workerId !== "parent" && !WORKER_ID.test(v.workerId)) return undefined;
	return { role: v.role, workerId: v.workerId };
}
function decodeItem(v: unknown): InboxItem | undefined {
	if (!isRecord(v) || !isItemId(v.id) || !isStr(v.teamId, 40) || !TEAM_ID.test(v.teamId)) return undefined;
	const from = decodeParty(v.from);
	const to = decodeParty(v.to);
	if (!from || !to) return undefined;
	if (!INBOX_KINDS.includes(v.kind as InboxKind) || typeof v.urgent !== "boolean") return undefined;
	if (!isStr(v.subject, MAX_SUBJECT_CHARS * 2) || !isStr(v.body, MAX_BODY_CHARS * 2) || !isNum(v.sentAt)) return undefined;
	if (v.status !== "new" && v.status !== "read" && v.status !== "addressed") return undefined;
	const item: InboxItem = {
		id: v.id, teamId: v.teamId, from, to, kind: v.kind as InboxKind, urgent: v.urgent, subject: v.subject, body: v.body,
		sentAt: v.sentAt, status: v.status,
	};
	if (isItemId(v.replyTo)) item.replyTo = v.replyTo;
	if (isStr(v.broadcastId, 64) && v.broadcastId) item.broadcastId = v.broadcastId;
	if (Array.isArray(v.movedFrom)) {
		const moves = v.movedFrom.flatMap((m): InboxMove[] => {
			if (!isRecord(m) || !isStr(m.workerId, 40) || !isStr(m.role, 200) || !isNum(m.at) || (m.why !== "handover" && m.why !== "forward")) return [];
			return [{ workerId: m.workerId, role: m.role, at: m.at, why: m.why }];
		});
		if (moves.length) item.movedFrom = moves;
	}
	if (isNum(v.readAt)) item.readAt = v.readAt;
	if (isNum(v.addressedAt)) item.addressedAt = v.addressedAt;
	if (isStr(v.note, MAX_NOTE_CHARS * 2) && v.note) item.note = v.note;
	if (isNum(v.listedAt)) item.listedAt = v.listedAt;
	if (isRecord(v.returned) && isNum(v.returned.at) && isStr(v.returned.why, 500)) item.returned = { at: v.returned.at, why: v.returned.why };
	return item;
}

/** Apply one parsed line to a member's folded items; anything malformed is ignored. */
function applyOp(items: Map<string, InboxItem>, raw: unknown): void {
	if (!isRecord(raw) || raw.v !== 1) return;
	switch (raw.op) {
		case "add": {
			const item = decodeItem(raw.item);
			if (item) items.set(item.id, item);
			return;
		}
		case "status": {
			const item = isItemId(raw.id) ? items.get(raw.id) : undefined;
			if (!item || !isNum(raw.at) || (raw.status !== "new" && raw.status !== "read" && raw.status !== "addressed")) return;
			item.status = raw.status;
			if (raw.status === "read") item.readAt = raw.at;
			if (raw.status === "addressed") item.addressedAt = raw.at;
			if (isStr(raw.note, MAX_NOTE_CHARS * 2) && raw.note) item.note = raw.note;
			return;
		}
		case "listed": {
			if (!Array.isArray(raw.ids) || !isNum(raw.at)) return;
			for (const id of raw.ids) {
				const item = isItemId(id) ? items.get(id) : undefined;
				if (item) item.listedAt = raw.at;
			}
			return;
		}
		case "move": {
			// The item left this member's inbox; the destination file holds it now.
			if (isItemId(raw.id)) items.delete(raw.id);
			return;
		}
		case "return": {
			const item = isItemId(raw.id) ? items.get(raw.id) : undefined;
			if (item && isNum(raw.at) && isStr(raw.why, 500)) item.returned = { at: raw.at, why: raw.why };
			return;
		}
	}
}

/** Fold one file's text: a torn or unknown line is skipped. Pure; never throws. */
export function foldItemsText(text: string): Map<string, InboxItem> {
	const items = new Map<string, InboxItem>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			continue;
		}
		applyOp(items, raw);
	}
	return items;
}

/** Fold one member's file; a missing or unreadable file is an empty inbox. Never throws. */
export function foldItemsFile(file: string): Map<string, InboxItem> {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return new Map();
	}
	return foldItemsText(text);
}

/** One member's items, oldest first. */
export function readMemberItems(memberDir: string): InboxItem[] {
	return [...foldItemsFile(itemsFile(memberDir)).values()].sort(byId);
}

/** Every member's items in one team, by worker ID. Never throws. */
export function readTeamInboxes(mailboxRoot: string, teamId: string): Map<string, InboxItem[]> {
	const out = new Map<string, InboxItem[]>();
	let names: string[];
	try {
		names = fs.readdirSync(path.join(mailboxRoot, teamId)).filter((n) => WORKER_ID.test(n));
	} catch {
		return out;
	}
	for (const workerId of names.sort()) out.set(workerId, readMemberItems(path.join(mailboxRoot, teamId, workerId)));
	return out;
}

/** Whether a member child on inbox-aware code announced it (member.ts writes caps.json at load). */
export function hasInboxCaps(memberDir: string): boolean {
	try {
		const v = JSON.parse(fs.readFileSync(capsFile(memberDir), "utf8"));
		return isRecord(v) && typeof v.inbox === "number" && v.inbox >= 1;
	} catch {
		return false;
	}
}
/** Member side: announce inbox-aware tools. */
export function writeInboxCaps(memberDir: string): void {
	const file = capsFile(memberDir);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify({ inbox: 1 })}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(tmp, file);
}

export interface NewItem {
	teamId: string;
	from: InboxParty;
	to: InboxParty;
	kind: InboxKind;
	body: string;
	subject?: string;
	urgent?: boolean;
	replyTo?: string;
	broadcastId?: string;
	/** Default "new"; an instruction copy (history) is stored "read". */
	status?: InboxStatus;
	/** The worker it was first sent to, when Sova forwarded it to a successor at once. */
	forwardedFrom?: InboxParty;
}
export interface StatusResult { id: string; ok: boolean; reason?: string; item?: InboxItem }
interface MemberFile { teamId: string; workerId: string; file: string; items: Map<string, InboxItem>; bytes: number; closed: number }

/**
 * The parent's writer. It folds every member file under the root once, then keeps the fold in
 * memory and appends one op per change (fsync'd). Single writer: never construct two over one root.
 */
export class InboxStore {
	readonly root: string;
	private readonly now: () => number;
	private readonly keepClosed: number;
	private readonly members = new Map<string, MemberFile>();
	/** Item id → worker ID holding it now. */
	private readonly holder = new Map<string, string>();
	private seq = 0;

	constructor(root: string, opts: { now?: () => number; keepClosed?: number } = {}) {
		this.root = root;
		this.now = opts.now ?? Date.now;
		this.keepClosed = opts.keepClosed ?? KEEP_CLOSED_ITEMS;
		this.load();
	}

	private load(): void {
		try {
			const hint = JSON.parse(fs.readFileSync(path.join(this.root, SEQ_FILE), "utf8"));
			if (isRecord(hint) && isNum(hint.seq)) this.seq = hint.seq;
		} catch {
			/* No hint yet. */
		}
		let teams: string[];
		try {
			teams = fs.readdirSync(this.root).filter((n) => TEAM_ID.test(n));
		} catch {
			return;
		}
		for (const teamId of teams) {
			let names: string[];
			try {
				names = fs.readdirSync(path.join(this.root, teamId)).filter((n) => WORKER_ID.test(n));
			} catch {
				continue;
			}
			for (const workerId of names) {
				const file = itemsFile(path.join(this.root, teamId, workerId));
				let bytes = 0;
				try {
					bytes = fs.statSync(file).size;
				} catch {
					continue;
				}
				const items = foldItemsFile(file);
				const m: MemberFile = { teamId, workerId, file, items, bytes, closed: 0 };
				this.members.set(workerId, m);
				for (const item of items.values()) {
					if (!isOpen(item)) m.closed++;
					this.seq = Math.max(this.seq, itemSeq(item.id));
					// A move torn between its two writes leaves the item in both files: the later holder wins.
					const prev = this.holder.get(item.id);
					const prevItem = prev ? this.members.get(prev)?.items.get(item.id) : undefined;
					if (!prevItem || (item.movedFrom?.length ?? 0) > (prevItem.movedFrom?.length ?? 0)) this.holder.set(item.id, workerId);
				}
			}
		}
	}

	private member(teamId: string, workerId: string): MemberFile {
		let m = this.members.get(workerId);
		if (!m) {
			const dir = path.join(this.root, teamId, workerId);
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			m = { teamId, workerId, file: itemsFile(dir), items: new Map(), bytes: 0, closed: 0 };
			this.members.set(workerId, m);
		}
		return m;
	}

	private append(m: MemberFile, op: InboxOp): void {
		const line = `${JSON.stringify(op)}\n`;
		const fd = fs.openSync(m.file, "a", 0o600);
		try {
			fs.writeSync(fd, line);
			try {
				fs.fsyncSync(fd);
			} catch {
				/* Some filesystems refuse fsync; the write itself stands. */
			}
		} finally {
			fs.closeSync(fd);
		}
		m.bytes += Buffer.byteLength(line);
	}

	/** Store a new item in its recipient's inbox; returns it with its id. */
	add(input: NewItem): InboxItem {
		const body = input.body.length > MAX_BODY_CHARS ? input.body.slice(0, MAX_BODY_CHARS) : input.body;
		const at = this.now();
		const item: InboxItem = {
			id: itemIdOf(++this.seq),
			teamId: input.teamId,
			from: { ...input.from },
			to: { ...input.to },
			kind: input.kind,
			urgent: Boolean(input.urgent),
			subject: subjectOf(body, input.subject),
			body,
			sentAt: at,
			status: input.status ?? "new",
			...(input.replyTo ? { replyTo: input.replyTo } : {}),
			...(input.broadcastId ? { broadcastId: input.broadcastId } : {}),
			...(input.forwardedFrom ? { movedFrom: [{ workerId: input.forwardedFrom.workerId, role: input.forwardedFrom.role, at, why: "forward" as const }] } : {}),
		};
		if (item.status === "read") item.readAt = at;
		if (item.status === "addressed") item.addressedAt = at;
		const m = this.member(input.teamId, input.to.workerId);
		this.append(m, { v: 1, op: "add", item });
		m.items.set(item.id, item);
		if (!isOpen(item)) m.closed++;
		this.holder.set(item.id, m.workerId);
		this.maybeCompact(m);
		return { ...item };
	}

	/** The item as its current holder has it (status lookups follow moves). */
	get(id: string): InboxItem | undefined {
		const w = this.holder.get(id);
		const item = w ? this.members.get(w)?.items.get(id) : undefined;
		return item && { ...item };
	}
	holderOf(id: string): string | undefined {
		return this.holder.get(id);
	}

	/** A member's items, oldest first: open ones only, or the newest `limit` of every status. */
	list(workerId: string, opts: { open?: boolean; limit?: number } = {}): InboxItem[] {
		const all = [...(this.members.get(workerId)?.items.values() ?? [])].sort(byId);
		const picked = opts.open ? all.filter(isOpen) : all;
		return (opts.limit ? picked.slice(-opts.limit) : picked).map((i) => ({ ...i }));
	}
	/** What a worker sent, wherever it is now, oldest first. */
	sentBy(workerId: string, limit = 50): InboxItem[] {
		const out: InboxItem[] = [];
		for (const m of this.members.values()) for (const item of m.items.values()) if (item.from.workerId === workerId) out.push({ ...item });
		return out.sort(byId).slice(-limit);
	}
	openCount(workerId: string): number {
		let n = 0;
		for (const item of this.members.get(workerId)?.items.values() ?? []) if (isOpen(item)) n++;
		return n;
	}
	openCounts(teamId: string): Map<string, number> {
		const out = new Map<string, number>();
		for (const m of this.members.values()) if (m.teamId === teamId) out.set(m.workerId, this.openCount(m.workerId));
		return out;
	}
	/** Open, new and never listed: what the next wake must list. */
	unlisted(workerId: string): InboxItem[] {
		return this.list(workerId, { open: true }).filter((i) => i.status === "new" && i.listedAt === undefined);
	}
	/** Open and still new (listed or not): what a wake shows. */
	unread(workerId: string): InboxItem[] {
		return this.list(workerId, { open: true }).filter((i) => i.status === "new");
	}
	/** Members with a file, by team (for re-waking after a reload). */
	workers(): { teamId: string; workerId: string }[] {
		return [...this.members.values()].map((m) => ({ teamId: m.teamId, workerId: m.workerId }));
	}

	/** Mark items the member holds: read (only from new) or addressed (from any open state). */
	setStatus(workerId: string, ids: readonly string[], status: "read" | "addressed", note?: string): StatusResult[] {
		const m = this.members.get(workerId);
		const cleanNote = note === undefined ? undefined : oneLine(note, MAX_NOTE_CHARS) || undefined;
		return ids.map((id): StatusResult => {
			const item = m?.items.get(id);
			if (!m || !item) {
				const now = this.holder.get(id);
				return { id, ok: false, reason: now ? `${id} is not in your inbox (it is with ${this.members.get(now)?.items.get(id)?.to.role ?? now})` : `No item ${id}` };
			}
			if (item.kind === "instruction" || item.returned) return { id, ok: false, reason: `${id} is ${item.returned ? "returned" : "an instruction (history only)"}`, item: { ...item } };
			if (status === "read" && item.status !== "new") return { id, ok: true, item: { ...item } };
			if (status === "addressed" && item.status === "addressed" && cleanNote === undefined) return { id, ok: true, item: { ...item } };
			const at = this.now();
			const wasOpen = isOpen(item);
			this.append(m, { v: 1, op: "status", id, status, at, ...(cleanNote ? { note: cleanNote } : {}) });
			item.status = status;
			if (status === "read") item.readAt = at;
			else item.addressedAt = at;
			if (cleanNote) item.note = cleanNote;
			if (wasOpen && !isOpen(item)) m.closed++;
			return { id, ok: true, item: { ...item } };
		});
	}

	/** An accepted wake listed these items. */
	markListed(workerId: string, ids: readonly string[]): void {
		const m = this.members.get(workerId);
		if (!m) return;
		const held = ids.filter((id) => m.items.has(id));
		if (!held.length) return;
		const at = this.now();
		this.append(m, { v: 1, op: "listed", ids: held, at });
		for (const id of held) m.items.get(id)!.listedAt = at;
	}

	/**
	 * Move an item to another member (a successor): it keeps its id and sender, records whom it
	 * moved from, and is listed to its new holder: listedAt cleared, and an open item is new again
	 * (its new holder has read nothing; an addressed one stays addressed). The destination is
	 * written first, so a torn move leaves it in both files and the fold keeps the newer holder.
	 */
	move(id: string, to: InboxParty, why: "handover" | "forward"): InboxItem | undefined {
		const fromId = this.holder.get(id);
		const src = fromId ? this.members.get(fromId) : undefined;
		const item = src?.items.get(id);
		if (!src || !item || to.workerId === src.workerId) return undefined;
		const at = this.now();
		const { listedAt: _listed, readAt: _read, ...rest } = item;
		const moved: InboxItem = { ...rest, ...(item.status === "read" ? { status: "new" as const } : item.readAt !== undefined && item.status === "addressed" ? { readAt: item.readAt } : {}), to: { ...to }, movedFrom: [...(item.movedFrom ?? []), { workerId: item.to.workerId, role: item.to.role, at, why }] };
		const dst = this.member(src.teamId, to.workerId);
		this.append(dst, { v: 1, op: "add", item: moved });
		dst.items.set(id, moved);
		if (!isOpen(moved)) dst.closed++;
		this.append(src, { v: 1, op: "move", id, to: { ...to }, at, why });
		src.items.delete(id);
		if (!isOpen(item)) src.closed = Math.max(0, src.closed - 1);
		this.holder.set(id, dst.workerId);
		return { ...moved };
	}
	/** Move every open item a member holds; returns the moved items. */
	moveOpen(fromWorkerId: string, to: InboxParty, why: "handover" | "forward"): InboxItem[] {
		const ids = this.list(fromWorkerId, { open: true }).map((i) => i.id);
		return ids.flatMap((id) => {
			const moved = this.move(id, to, why);
			return moved ? [moved] : [];
		});
	}

	/** Mark an item returned to its sender (not addressed); the caller tells the sender. */
	returnItem(id: string, why: string): InboxItem | undefined {
		const w = this.holder.get(id);
		const m = w ? this.members.get(w) : undefined;
		const item = m?.items.get(id);
		if (!m || !item || !isOpen(item)) return undefined;
		const at = this.now();
		const reason = oneLine(why, 300);
		this.append(m, { v: 1, op: "return", id, at, why: reason });
		item.returned = { at, why: reason };
		m.closed++;
		this.maybeCompact(m);
		return { ...item };
	}
	returnOpen(workerId: string, why: string): InboxItem[] {
		return this.list(workerId, { open: true }).flatMap((i) => {
			const r = this.returnItem(i.id, why);
			return r ? [r] : [];
		});
	}

	private maybeCompact(m: MemberFile): void {
		if (m.closed > this.keepClosed + COMPACT_SLACK || m.bytes > COMPACT_BYTES) this.compact(m.workerId);
	}

	/** Rewrite a member's file: every open item and the newest `keepClosed` others (tmp + rename). */
	compact(workerId: string): void {
		const m = this.members.get(workerId);
		if (!m) return;
		const all = [...m.items.values()].sort(byId);
		const open = all.filter(isOpen);
		const closedAll = all.filter((i) => !isOpen(i));
		const closed = this.keepClosed > 0 ? closedAll.slice(-this.keepClosed) : [];
		const keep = [...open, ...closed].sort(byId);
		// Never reuse an id even when the newest one is dropped here.
		try {
			const tmpSeq = path.join(this.root, `${SEQ_FILE}.tmp`);
			fs.writeFileSync(tmpSeq, `${JSON.stringify({ seq: this.seq })}\n`, { mode: 0o600 });
			fs.renameSync(tmpSeq, path.join(this.root, SEQ_FILE));
		} catch {
			return; // Without the hint a dropped id could come back: keep the file whole instead.
		}
		const text = keep.map((item) => JSON.stringify({ v: 1, op: "add", item } satisfies InboxOp)).join("\n") + (keep.length ? "\n" : "");
		const tmp = `${m.file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(tmp, m.file);
		const kept = new Set(keep.map((i) => i.id));
		for (const id of [...m.items.keys()]) if (!kept.has(id)) {
			m.items.delete(id);
			if (this.holder.get(id) === workerId) this.holder.delete(id);
		}
		m.closed = closed.length;
		m.bytes = Buffer.byteLength(text);
	}
}
