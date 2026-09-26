/**
 * link: the tools of a session linked with sessions on other Sova mesh hosts (§mesh.links/tools).
 *
 * `link_members`, `link_send` and `link_inbox` are registered at load in EVERY session, with a fixed
 * schema, whether or not the session is linked: a claude-code session reaches them through its
 * provider's `mcp__sova__` bridge, and a tool set that changed when a link was made would change
 * that session's tools mid-conversation. Each tool refuses with a sentence when the session is in
 * no link.
 *
 * Sova sets the `sova-link` flag on every runtime it hosts to its own origin (the real bound port).
 * Without the flag (a TUI, a worker) the extension is inert: the tools refuse, nothing is fetched.
 * Every call goes to the session's own host only (`client.ts`); the host does every peer hop.
 *
 * While linked, each run's prompt gets the `mesh-link` section (`promptSection`), rebuilt only when
 * the set of live link ids changes, so it changes only when a link is made or ended: a changed
 * system prompt restarts a claude-code session's CLI. When the host can't be read at a run start, the last
 * section is kept rather than dropped, for the same reason.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	LinkClient,
	LinkHostError,
	type MeshLinkView,
	nameFrom,
	NOT_HOSTED,
	NOT_LINKED,
	promptSection,
	renderInbox,
	renderMembers,
	renderSend,
	sectionKey,
	UNLINKED_REASONS,
} from "./client.ts";

export const FLAG = "sova-link";
export const SECTION = "mesh-link";

export default function link(pi: ExtensionAPI, deps: { fetch?: typeof fetch } = {}) {
	pi.registerFlag(FLAG, { description: "Sova sets this to its own origin in the sessions it hosts; enables the link tools", type: "string" });

	let client: LinkClient | null | undefined;
	const host = (): LinkClient | null => {
		if (client === undefined) {
			const origin = pi.getFlag(FLAG);
			client = typeof origin === "string" && /^https?:\/\//.test(origin) ? new LinkClient(origin, deps.fetch ?? fetch) : null;
		}
		return client;
	};
	/** The last members view, for naming recipients in results. */
	let lastView: MeshLinkView[] = [];
	/** The section the last run got, and the live link ids it was built for: rebuilt only when
	    those change, and kept when a run start can't read the host. */
	let lastSection: string | null = null;
	let lastKey = "";

	const sessionOf = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const text = (t: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text: t }], details });
	const refusal = (e: unknown) => {
		if (e instanceof LinkHostError) return text(e.reason && UNLINKED_REASONS.has(e.reason) ? `${NOT_LINKED} (${e.message})` : e.message, { error: e.reason ?? e.status });
		throw e;
	};

	pi.registerTool({
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

	pi.registerTool({
		name: "link_send",
		label: "Link send",
		description:
			"Send a message to partner sessions of this session's link; your host delivers it. `to`: a partner by host label, session id or title, a list of them, or \"all\"; leave it out when the link has one partner. `link`: the link id, needed only when this session is in more than one link. The result says per partner: started (it was idle and began a turn), delivered (it is busy and sees it at its next step), held for an offline host, or refused with the reason. Acceptance is not proof the partner acted on it.",
		promptSnippet: "Message the partner sessions this session is linked with on other hosts",
		parameters: Type.Object(
			{
				text: Type.String({ description: "The message." }),
				to: Type.Optional(
					Type.Union([Type.String(), Type.Array(Type.String())], {
						description: 'A partner (host label, session id or title), several, or "all". Optional with one partner.',
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

	pi.registerTool({
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

	pi.on("before_agent_start", async (event, ctx) => {
		const c = host();
		if (!c) return;
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
