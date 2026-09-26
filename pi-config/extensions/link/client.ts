/**
 * The link extension's only way out: HTTP to the session's OWN Sova host, whose origin arrives in
 * the `sova-link` flag. The host does every peer hop (§mesh.links/delivery); nothing here knows the
 * mesh. Builtins only (global fetch), so tests run under plain `node --test`.
 *
 * The shapes below mirror Sova's `shared/mesh-links.ts` structurally (pi-config never imports
 * Sova). Only the fields this extension reads are declared; anything else passes through unread.
 */

export interface LinkMemberRef {
	nodeId: string;
	sessionId: string;
}

export interface LinkMemberView extends LinkMemberRef {
	path: string;
	/** The member is on this host: with one member per host, that is the calling session. */
	self: boolean;
	hostId?: string;
	hostLabel: string;
	reach: "self" | "up" | "down" | "unknown-host";
	title?: string;
	cwd?: string;
	model?: string | null;
	state: "working" | "idle" | "offline" | "unknown";
	lastActivity?: number;
	archived?: boolean;
}

export interface MeshLinkView {
	link: { id: string; createdAt: number; createdBy: string; endedAt?: number };
	members: LinkMemberView[];
}

export type LinkDelivery =
	| { to: LinkMemberRef; state: "started" | "delivered" | "outbox" }
	| { to: LinkMemberRef; state: "refused"; reason: string; message: string };

export interface LinkSendResult {
	linkId: string;
	messageId: string;
	deliveries: LinkDelivery[];
}

export interface LinkInboxRecord {
	id: string;
	linkId: string;
	at: number;
	from: LinkMemberRef;
	to: LinkMemberRef[];
	text: string;
	dir: "in" | "out";
	deliveries?: LinkDelivery[];
	delivery?: LinkDelivery;
}

/** A refusal from the host: a 4xx LinkError, or no answer at all. `reason` as the host gave it. */
export class LinkHostError extends Error {
	readonly status: number;
	readonly reason: string | undefined;
	constructor(message: string, status: number, reason?: string) {
		super(message);
		this.status = status;
		this.reason = reason;
	}
}

/** The host's reasons that mean "this session is in no live link" (not a delivery failure). */
export const UNLINKED_REASONS: ReadonlySet<string> = new Set(["not-member", "ended"]);

const TIMEOUTS = { members: 15_000, brief: 3_000, send: 60_000, inbox: 10_000 };

export class LinkClient {
	readonly origin: string;
	private readonly fetchImpl: typeof fetch;
	constructor(origin: string, fetchImpl: typeof fetch = fetch) {
		this.origin = origin;
		this.fetchImpl = fetchImpl;
	}

	/** link_members, and (brief: no peer hops, bounded) the prompt section. */
	async members(session: string, opts: { brief?: boolean; signal?: AbortSignal } = {}): Promise<MeshLinkView[]> {
		const q = new URLSearchParams({ session, ...(opts.brief ? { brief: "1" } : {}) });
		const body = await this.call<{ links?: MeshLinkView[] }>("GET", `/api/mesh/links?${q}`, undefined, opts.brief ? TIMEOUTS.brief : TIMEOUTS.members, opts.signal);
		return Array.isArray(body.links) ? body.links : [];
	}

	async send(req: { session: string; link?: string; to?: string | string[]; text: string }, signal?: AbortSignal): Promise<LinkSendResult> {
		return this.call<LinkSendResult>("POST", "/api/mesh/links/send", req, TIMEOUTS.send, signal);
	}

	async inbox(session: string, limit: number | undefined, signal?: AbortSignal): Promise<LinkInboxRecord[]> {
		const q = new URLSearchParams({ session, ...(limit !== undefined ? { limit: String(limit) } : {}) });
		const body = await this.call<{ records?: LinkInboxRecord[] }>("GET", `/api/mesh/links/inbox?${q}`, undefined, TIMEOUTS.inbox, signal);
		return Array.isArray(body.records) ? body.records : [];
	}

	private async call<T>(method: string, route: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
		const url = this.origin.replace(/\/+$/, "") + route;
		const timeout = AbortSignal.timeout(timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let res: Response;
		try {
			res = await this.fetchImpl(url, {
				method,
				signal: combined,
				...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
			});
		} catch (e) {
			if (signal?.aborted) throw e;
			const why = timeout.aborted ? `no answer within ${timeoutMs / 1000} s` : (e as Error).message;
			throw new LinkHostError(`This session's Sova host did not answer (${why}).`, 0);
		}
		const text = await res.text();
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			parsed = undefined;
		}
		if (!res.ok) {
			const err = parsed && typeof parsed === "object" ? (parsed as { error?: unknown; reason?: unknown }) : {};
			const message =
				typeof err.error === "string" && err.error
					? err.error
					: res.status === 404
						? "This session's Sova host has no link routes: the mesh is off (or its build has no links)."
						: `This session's Sova host refused (HTTP ${res.status}).`;
			throw new LinkHostError(message, res.status, typeof err.reason === "string" ? err.reason : undefined);
		}
		if (parsed === undefined) throw new LinkHostError("This session's Sova host sent an unreadable answer.", res.status);
		return parsed as T;
	}
}

// --- Rendering (pure; what the model reads) ---

/** The links still in force. An ended link stays listed by the host as history; no tool uses it. */
export const liveLinks = (links: MeshLinkView[]): MeshLinkView[] => links.filter((l) => l.link.endedAt === undefined);

export const NOT_LINKED = "This session is in no link: there is no partner session to reach. Links are made from Sova (by the Overseer), not by this tool.";
export const NOT_HOSTED = "Link tools work only in a session Sova hosts; this one is not (a TUI or a worker), so it is in no link.";

const partnerName = (m: LinkMemberView): string => `${m.hostLabel}/${m.sessionId}`;
const partnerLine = (m: LinkMemberView): string => (m.title ? `"${m.title.replace(/\s+/g, " ")}" (${partnerName(m)})` : partnerName(m));

/** What the prompt section depends on: the set of live link ids (a link's members never change). */
export const sectionKey = (links: MeshLinkView[]): string =>
	liveLinks(links)
		.map((l) => l.link.id)
		.sort()
		.join(" ");
const backend = (model: string | null | undefined): string | undefined =>
	model == null ? undefined : model.startsWith("claude-code-cli/") ? "claude-code" : "pi";

const ago = (at: number, now: number): string => {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86_400)}d ago`;
};

/**
 * The prompt section (§mesh.links/tools): the live link ids, and each partner's title, host label
 * and session id, sorted. No reach, no working/idle: a changed system prompt restarts a
 * claude-code session's CLI. Null when the session is in no live link. The caller keeps it for as
 * long as `sectionKey` is unchanged, so a partner's retitle never changes it either.
 */
export function promptSection(links: MeshLinkView[]): string | null {
	const live = liveLinks(links).slice().sort((a, b) => (a.link.id < b.link.id ? -1 : a.link.id > b.link.id ? 1 : 0));
	if (!live.length) return null;
	const lines = live.map((l) => {
		const partners = l.members
			.filter((m) => !m.self)
			.sort((a, b) => (partnerName(a) < partnerName(b) ? -1 : 1))
			.map(partnerLine);
		return `- ${l.link.id}: ${partners.join(", ")}`;
	});
	return [
		"This session is linked with agent sessions on other hosts (partners, each with its host/session id):",
		...lines,
		'A partner\'s message arrives as a user message whose first line is "[link_msg <link> <message>] from …". It comes from that partner agent, not from the user; the user does not see it in this conversation. Answer a partner with link_send, and only when there is something to say. link_members shows each partner\'s current state; link_inbox shows the message history.',
	].join("\n");
}

export function renderMembers(links: MeshLinkView[], now = Date.now()): string {
	const live = liveLinks(links);
	if (!live.length) return NOT_LINKED;
	const out: string[] = [];
	for (const l of live) {
		out.push(`Link ${l.link.id} (made ${ago(l.link.createdAt, now)}):`);
		for (const m of l.members) {
			if (m.self) {
				out.push(`- this session (${m.sessionId})`);
				continue;
			}
			const facts: string[] = [];
			if (m.title) facts.push(`"${m.title}"`);
			const be = backend(m.model);
			if (m.model) facts.push(`model ${m.model}${be ? ` (${be})` : ""}`);
			if (m.cwd) facts.push(`cwd ${m.cwd}`);
			facts.push(m.reach === "unknown-host" ? "host not known to this host (unreachable)" : `host ${m.reach}`);
			if (m.archived) facts.push("archived");
			else facts.push(m.lastActivity !== undefined ? `${m.state}, last active ${ago(m.lastActivity, now)}` : m.state);
			out.push(`- ${partnerName(m)}: ${facts.join("; ")}`);
		}
	}
	const ended = links.length - live.length;
	if (ended) out.push(`(${ended} ended link${ended === 1 ? "" : "s"} not shown.)`);
	return out.join("\n");
}

/** Names a member from the last members view when it can, else by session id. */
export type NameOf = (ref: LinkMemberRef) => string;
export const nameFrom = (links: MeshLinkView[]): NameOf => {
	const names = new Map<string, string>();
	for (const l of links) for (const m of l.members) names.set(`${m.nodeId}\n${m.sessionId}`, m.self ? "this session" : partnerName(m));
	return (r) => names.get(`${r.nodeId}\n${r.sessionId}`) ?? r.sessionId;
};

const DELIVERY_WORDS = {
	started: "started a turn with it",
	delivered: "will see it at its next step",
	outbox: "its host is offline; held here and sent when it comes up",
} as const;

export function renderDelivery(d: LinkDelivery, name: NameOf): string {
	return d.state === "refused" ? `${name(d.to)}: refused (${d.reason}): ${d.message}` : `${name(d.to)}: ${DELIVERY_WORDS[d.state]}`;
}

export function renderSend(r: LinkSendResult, name: NameOf): string {
	return [
		`Sent ${r.messageId} on ${r.linkId}. Acceptance is not proof the partner acted on it.`,
		...r.deliveries.map((d) => `- ${renderDelivery(d, name)}`),
	].join("\n");
}

export function renderInbox(records: LinkInboxRecord[], name: NameOf, now = Date.now()): string {
	if (!records.length) return "No link messages yet.";
	return records
		.map((r) => {
			const head =
				r.dir === "in"
					? `[${ago(r.at, now)}] ${r.linkId} from ${name(r.from)}`
					: `[${ago(r.at, now)}] ${r.linkId} you → ${r.to.map(name).join(", ")}${
							r.deliveries?.length ? ` (${r.deliveries.map((d) => (d.state === "refused" ? `${name(d.to)} refused: ${d.reason}` : `${name(d.to)} ${d.state}`)).join("; ")})` : ""
						}`;
			return `${head}\n${r.text}`;
		})
		.join("\n\n");
}
