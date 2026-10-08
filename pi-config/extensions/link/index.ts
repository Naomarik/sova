/**
 * link: the tools of a session linked with sessions on other Sova mesh hosts (§mesh.links/tools).
 *
 * `link_members`, `link_send`, `link_inbox` and the file tools `link_offer`, `link_accept`,
 * `link_decline` and `link_offers`, with a fixed schema, exist only in a session that is a link member:
 *
 * - **Born** (`member`): one the Overseer created as a link member (Sova's marker, fixed at its
 *   creation), said with the `sova-link-tools` flag `member`. The tools are registered at
 *   `session_start` (pi applies flag values only after every extension has loaded, so never in the
 *   factory body), before its first request, and never withdrawn.
 * - **Joined** (`legacy` flag, `has` = `joined`): any other session Sova hosts, once the server's
 *   `Symbol.for("sova:link-live")` hook (installed by Sova, asked by session id; absent in a TUI or
 *   a worker) says it is in a live link: at `session_start`, `before_agent_start`, or `turn_end`, so a
 *   session linked mid-run declares them in the request that carries the steered partner message
 *   (pi builds that request's loadout after `turn_end`, before `turn_start`).
 *
 * A claude-code session reaches them through its provider's `mcp__sova__` bridge, and a changed tool
 * set restarts its CLI, so the tools are turned on once and taken back only at a compaction; each
 * tool refuses with a sentence when the session is in no link.
 *
 * A joined session, and one whose transcript already declares the tools (`legacy`: a session an
 * earlier build hosted, when every session had them), withdraws them at a compaction that finds it in
 * no live link (re-registered `hidden`, the one way pi takes a tool back), which rebuilds the prompt
 * cache anyway; a compaction while the session is in a live link, or whose host can't say, keeps them
 * for a later one. Never when a link ends, and never at any other moment.
 *
 * Sova sets the `sova-link` flag on every runtime it hosts to its own origin (the real bound port).
 * Without it (a TUI, a worker) nothing is registered and nothing is fetched. Beside it,
 * `sova-link-token` carries the host's per-install token, sent on every call (the host's gate
 * refuses a loopback call without it).
 * Every call goes to the session's own host only (`client.ts`); the host does every peer hop.
 *
 * While linked, each run's prompt gets the `mesh-link` section (`promptSection`), rebuilt only when
 * the set of live link ids changes, so it changes only when a link is made or ended: a changed
 * system prompt restarts a claude-code session's CLI. When the host can't be read at a run start, the last
 * section is kept rather than dropped, for the same reason.
 */
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	LinkClient,
	LinkHostError,
	type MeshLinkView,
	nameFrom,
	NOT_HOSTED,
	NOT_LINKED,
	OFFER_ID_RE,
	promptSection,
	renderAnswer,
	renderInbox,
	renderMembers,
	renderOfferCreate,
	renderOffers,
	renderSend,
	liveLinks,
	sectionKey,
	UNLINKED_REASONS,
} from "./client.ts";

export const FLAG = "sova-link";
export const TOKEN_FLAG = "sova-link-token";
export const TOOLS_FLAG = "sova-link-tools";
export const SECTION = "mesh-link";
/** Sova installs `globalThis[LINK_LIVE](sessionId) => boolean` in the server its sessions run in. */
export const LINK_LIVE = Symbol.for("sova:link-live");
export const TOOL_NAMES = ["link_members", "link_send", "link_inbox", "link_offer", "link_accept", "link_decline", "link_offers"] as const;

/** Whether the transcript's current loadout (its system messages replayed in order, as pi restores
    the active tools on open) declares any link tool. */
export function declaresLinkTools(messages: readonly { role: string }[]): boolean {
	const tools = new Set<string>();
	for (const m of messages) {
		if (m.role !== "system") continue;
		const sys = m as { toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };
		for (const t of sys.toolsRemoved ?? []) tools.delete(t.name);
		for (const t of sys.toolsAdded ?? []) tools.add(t.name);
	}
	return TOOL_NAMES.some((n) => tools.has(n));
}

export default function link(pi: ExtensionAPI, deps: { fetch?: typeof fetch } = {}) {
	pi.registerFlag(FLAG, { description: "Sova sets this to its own origin in the sessions it hosts; the link tools call it", type: "string" });
	pi.registerFlag(TOKEN_FLAG, { description: "Sova sets this to its own access token beside sova-link; the link tools send it back", type: "string" });
	pi.registerFlag(TOOLS_FLAG, {
		description: "Sova sets this beside sova-link: member (the session has the link tools from its start) or legacy (only while its transcript declares them, until its next compaction)",
		type: "string",
	});

	let client: LinkClient | null | undefined;
	const host = (): LinkClient | null => {
		if (client === undefined) {
			const origin = pi.getFlag(FLAG);
			const token = pi.getFlag(TOKEN_FLAG);
			client =
				typeof origin === "string" && /^https?:\/\//.test(origin)
					? new LinkClient(origin, deps.fetch ?? fetch, typeof token === "string" ? token : undefined)
					: null;
		}
		return client;
	};
	/** The last members view, for naming recipients in results. */
	let lastView: MeshLinkView[] = [];
	/** The section the last run got, and the live link ids it was built for: rebuilt only when
	    those change, and kept when a run start can't read the host. */
	let lastSection: string | null = null;
	let lastKey = "";

	/** The seven tools, registered only at session_start and only in a session that gets them. */
	const defs: ToolDefinition<any, any>[] = [];
	/** Why this session has the tools, or null while it has none. */
	let has: "member" | "joined" | "legacy" | null = null;

	const sessionOf = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const text = (t: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text: t }], details });
	/** `asIs`: an answer about one offer, whose host sentence says it all ("No file offer of_… for
	    this session." carries `not-member` but says nothing about the session's links). */
	const refusal = (e: unknown, asIs = false) => {
		if (e instanceof LinkHostError)
			return text(!asIs && e.reason && UNLINKED_REASONS.has(e.reason) ? `${NOT_LINKED} (${e.message})` : e.message, { error: e.reason ?? e.status });
		throw e;
	};

	defs.push({
		name: "link_members",
		label: "Link members",
		description:
			"The links this session is in (sessions on other Sova hosts it can message), and for each partner: its host, session id, title, cwd, model and backend, whether its host is up, and whether it is working or idle.",
		promptSnippet: "List the partner sessions this session is linked with on other hosts",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, signal, _update, ctx) {
			const c = host();
			if (!c) return text(NOT_HOSTED);
			try {
				lastView = await c.members(sessionOf(ctx), { signal });
				return text(renderMembers(lastView), { links: lastView });
			} catch (e) {
				return refusal(e);
			}
		},
	});

	defs.push({
		name: "link_send",
		label: "Link send",
		description:
			"Send a message to partner sessions of this session's link; your host delivers it. `to`: a partner as link_members names it (host/session id), or by host label, session id or title; a list of them, or \"all\"; leave it out when the link has one partner. `link`: the link id, needed only when this session is in more than one link. The result says per partner: started (it was idle and began a turn), delivered (it is busy and sees it at its next step), held for an offline host, or refused with the reason. Acceptance is not proof the partner acted on it.",
		promptSnippet: "Message the partner sessions this session is linked with on other hosts",
		parameters: Type.Object(
			{
				text: Type.String({ description: "The message." }),
				to: Type.Optional(
					Type.Union([Type.String(), Type.Array(Type.String())], {
						description: 'A partner as link_members names it (host/session id), or by host label, session id or title; several; or "all". Optional with one partner.',
					}),
				),
				link: Type.Optional(Type.String({ description: "The link id (lk_…); only when this session is in more than one link." })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal, _update, ctx) {
			const c = host();
			if (!c) return text(NOT_HOSTED);
			if (!params.text.trim()) return text("Nothing to send: the text is empty.");
			try {
				const r = await c.send(
					{ session: sessionOf(ctx), text: params.text, ...(params.to !== undefined ? { to: params.to } : {}), ...(params.link ? { link: params.link } : {}) },
					signal,
				);
				return text(renderSend(r, nameFrom(lastView)), r);
			} catch (e) {
				return refusal(e);
			}
		},
	});

	defs.push({
		name: "link_inbox",
		label: "Link inbox",
		description: "This session's link messages, both directions, newest last: what partners sent it and what it sent them, with each delivery's outcome.",
		promptSnippet: "Read the messages exchanged with linked partner sessions",
		parameters: Type.Object(
			{ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "How many of the newest records (default: all kept, at most 200)." })) },
			{ additionalProperties: false },
		),
		async execute(_id, params, signal, _update, ctx) {
			const c = host();
			if (!c) return text(NOT_HOSTED);
			try {
				const session = sessionOf(ctx);
				const records = await c.inbox(session, params.limit, signal);
				if (!records.length) {
					lastView = await c.members(session, { brief: true, signal });
					if (!lastView.length) return text(NOT_LINKED);
				}
				return text(renderInbox(records, nameFrom(lastView)), { records });
			} catch (e) {
				return refusal(e);
			}
		},
	});

	const badOffer = (offer: string) => (OFFER_ID_RE.test(offer) ? undefined : text(`"${offer}" is not an offer id (of_ and 16 hex digits); link_offers lists them.`));
	/** Names from the last members view, fetched once when there is none yet. */
	const names = async (c: LinkClient, session: string, signal?: AbortSignal) => {
		if (!lastView.length) lastView = await c.members(session, { brief: true, signal }).catch(() => []);
		return nameFrom(lastView);
	};

	defs.push({
		name: "link_offer",
		label: "Link offer",
		description:
			"Offer files or directories to partner sessions of this session's link; your host lists them, packs them once and each partner's host pulls them. `paths`: files or directories on this host, relative to your cwd, `~/…` or absolute; each travels under its own name, so two with the same name are refused. `dest`: a DIRECTORY on the partner's host; each path lands at dest/<its name> (`cp -r a b dest/`), parents are created, existing files are overwritten. Relative dest is under the partner's cwd, `~` its home. Name dest when you know where it goes: the partner's host then pulls at once, with no turn of its agent, and wakes it once when the files land. Without dest the partner's agent gets the offer as a message and answers with link_accept or link_decline (24 h). `dest` may also map partners (as `to` names them) to their own directory. No default excludes: node_modules, build output and caches go unless you `exclude` them (a pattern without / matches any path component, e.g. node_modules or *.log; with / it matches from the offered name, e.g. proj/dist). Symlinks travel as links, never followed. A git worktree's .git is a pointer file with no history; the result warns about it. The result lists files and bytes per partner's answer; you get one message when every partner is done or declined, or at the first failure.",
		promptSnippet: "Send files or directories to linked partner sessions on other hosts",
		parameters: Type.Object(
			{
				paths: Type.Array(Type.String(), { minItems: 1, description: "Files or directories on this host: relative to your cwd, ~/…, or absolute. Each lands at dest/<its name>." }),
				to: Type.Optional(
					Type.Union([Type.String(), Type.Array(Type.String())], {
						description: 'A partner as link_members names it (host/session id), or by host label, session id or title; several; or "all". Optional with one partner.',
					}),
				),
				dest: Type.Optional(
					Type.Union([Type.String(), Type.Record(Type.String(), Type.String())], {
						description:
							"A directory on the partner's host (relative = under its cwd, ~ = its home); each path lands at dest/<its name>. Or an object mapping each partner, as `to` names it, to its own directory. Given: the partner's host takes the files at once. Omitted: the partner's agent answers with link_accept or link_decline.",
					}),
				),
				exclude: Type.Optional(Type.Array(Type.String(), { description: "Patterns to leave out: without / any path component (node_modules, *.log); with / from the offered name (proj/dist). *, ?, **, [...]." })),
				note: Type.Optional(Type.String({ description: "A line for the partner: what this is and what to do with it." })),
				link: Type.Optional(Type.String({ description: "The link id (lk_…); only when this session is in more than one link." })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal, _update, ctx) {
			const c = host();
			if (!c) return text(NOT_HOSTED);
			const paths = params.paths.filter((p) => p.trim());
			if (!paths.length) return text("Nothing to offer: name at least one path.");
			try {
				const session = sessionOf(ctx);
				const r = await c.offer(
					{
						session,
						paths,
						...(params.to !== undefined ? { to: params.to } : {}),
						...(params.dest !== undefined ? { dest: params.dest } : {}),
						...(params.exclude?.length ? { exclude: params.exclude } : {}),
						...(params.note?.trim() ? { note: params.note.trim() } : {}),
						...(params.link ? { link: params.link } : {}),
					},
					signal,
				);
				return text(renderOfferCreate(r, await names(c, session, signal)), r);
			} catch (e) {
				return refusal(e);
			}
		},
	});

	defs.push({
		name: "link_accept",
		label: "Link accept",
		description:
			"Accept a partner's file offer (of_…, from its message or link_offers). `dest`: a DIRECTORY on this host; each offered path lands at dest/<its name>, parents are created and existing files are overwritten. Relative dest is under your cwd, ~ your home. Your host pulls it with no further action; you get one message when it lands or fails.",
		promptSnippet: "Take a linked partner's file offer into a directory on this host",
		parameters: Type.Object(
			{
				offer: Type.String({ description: "The offer id (of_…)." }),
				dest: Type.String({ description: "A directory on this host; each offered path lands at dest/<its name>." }),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal, _update, ctx) {
			const c = host();
			if (!c) return text(NOT_HOSTED);
			const bad = badOffer(params.offer);
			if (bad) return bad;
			if (!params.dest.trim()) return text("Name a destination directory (dest).");
			try {
				const session = sessionOf(ctx);
				const o = await c.accept(params.offer, { session, dest: params.dest }, signal);
				return text(renderAnswer(o, session, await names(c, session, signal)), { offer: o });
			} catch (e) {
				return refusal(e, true);
			}
		},
	});

	defs.push({
		name: "link_decline",
		label: "Link decline",
		description: "Decline a partner's file offer (of_…). Nothing is sent; the partner is told, with your reason if you give one.",
		promptSnippet: "Turn down a linked partner's file offer",
		parameters: Type.Object(
			{
				offer: Type.String({ description: "The offer id (of_…)." }),
				reason: Type.Optional(Type.String({ description: "Why, for the partner." })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal, _update, ctx) {
			const c = host();
			if (!c) return text(NOT_HOSTED);
			const bad = badOffer(params.offer);
			if (bad) return bad;
			try {
				const session = sessionOf(ctx);
				const o = await c.decline(params.offer, { session, ...(params.reason?.trim() ? { reason: params.reason.trim() } : {}) }, signal);
				return text(renderAnswer(o, session, await names(c, session, signal)), { offer: o });
			} catch (e) {
				return refusal(e, true);
			}
		},
	});

	defs.push({
		name: "link_offers",
		label: "Link offers",
		description:
			"This session's file offers, both directions, newest first: what was offered (names, files, bytes, note, warnings) and per recipient its state (offered, accepted, pulling with bytes so far, extracting, done, declined, failed, expired, cancelled, refused), destination and reason.",
		promptSnippet: "Show the file offers exchanged with linked partner sessions and their progress",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, signal, _update, ctx) {
			const c = host();
			if (!c) return text(NOT_HOSTED);
			try {
				const session = sessionOf(ctx);
				const offers = await c.offers(session, signal);
				if (!offers.length) {
					lastView = await c.members(session, { brief: true, signal });
					if (!lastView.length) return text(NOT_LINKED);
				}
				return text(renderOffers(offers, await names(c, session, signal), session), { offers });
			} catch (e) {
				return refusal(e);
			}
		},
	});

	/** Whether the host says this session is in a live link now (Sova's `sova:link-live` hook, by
	    session id); false where there is none (a TUI, a worker, a server without links). */
	const linkedNow = (ctx: ExtensionContext): boolean => {
		const live = (globalThis as Record<symbol, unknown>)[LINK_LIVE];
		if (typeof live !== "function") return false;
		try {
			return (live as (id: string) => unknown)(sessionOf(ctx)) === true;
		} catch {
			return false;
		}
	};
	const register = (why: NonNullable<typeof has>) => {
		for (const def of defs) pi.registerTool(def);
		has = why;
	};
	/** A session with none that is now in a live link joins: the tools from its next request. */
	const join = (ctx: ExtensionContext) => {
		if (has || !host() || pi.getFlag(TOOLS_FLAG) !== "legacy" || !linkedNow(ctx)) return;
		register("joined");
	};

	pi.on("session_start", (_event, ctx) => {
		if (has || !host()) return;
		const mode = pi.getFlag(TOOLS_FLAG);
		if (mode === "member") register("member");
		else if (mode === "legacy" && linkedNow(ctx)) register("joined");
		else if (mode === "legacy" && declaresLinkTools(ctx.sessionManager.buildSessionProjection().messages)) register("legacy");
	});

	// Linked while it runs: registered at the turn's end, before pi takes the steered partner message
	// and builds the next request's loadout, so that request declares them (quirk P23).
	pi.on("turn_end", (_event, ctx) => join(ctx));

	// A joined session, or one from before, keeps its tools until a compaction finds it in no live
	// link: the compaction rebuilds the prompt cache (a claude-code CLI restarts after one), so
	// dropping them then costs nothing extra. Never at any other moment, and a born member never.
	pi.on("session_compact", async (_event, ctx) => {
		const c = host();
		if ((has !== "legacy" && has !== "joined") || !c) return;
		try {
			if (liveLinks(await c.members(sessionOf(ctx), { brief: true })).length) return;
		} catch (e) {
			// The host's answer (no link routes, not linked) is no live link; no answer at all keeps them.
			if (!(e instanceof LinkHostError && e.status >= 400 && e.status < 500)) return;
		}
		for (const def of defs) pi.registerTool({ ...def, exposure: "hidden" });
		has = null;
		lastKey = "";
		lastSection = null;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		join(ctx);
		const c = host();
		if (!c || !has) return;
		try {
			const view = await c.members(sessionOf(ctx), { brief: true });
			lastView = view;
			const key = sectionKey(view);
			if (key !== lastKey) {
				lastKey = key;
				lastSection = promptSection(view);
			}
		} catch (e) {
			// A 4xx is the host's answer (no link routes, not linked): no section. No answer at all
			// keeps the last one: dropping it for one run would restart a claude-code CLI twice.
			if (e instanceof LinkHostError && e.status >= 400 && e.status < 500) {
				lastKey = "";
				lastSection = null;
			}
		}
		if (lastSection) event.systemPromptOptions.sections[SECTION] = lastSection;
	});
}
