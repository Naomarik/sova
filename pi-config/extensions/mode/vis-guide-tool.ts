/**
 * The `vis_guide` tool: the drawing rules for one `vis` kind, looked up when the model is about to draw
 * it (minor.ts `visGuide`: vis/shared.md, then that kind's file). It runs in this process, never on a
 * remote target, so it answers in every session the vis minor mode reaches. The host (index.ts) owns
 * when the tool is in the loadout (only while vis is on).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { VIS_GUIDE_NAMES, VIS_OWN_KINDS_HOOK, visGuide } from "./minor.ts";

export const VIS_GUIDE_TOOL = "vis_guide";

export const VIS_GUIDE_DESCRIPTION =
	"Look up one vis catalogue entry before using it: a drawing kind returns shared rules then its syntax/examples; tour returns the core of the tool-backed tour workflow (not a fence); tour-signin, tour-sites, tour-sova and tour-sharing return the parts it names. html and svg share one guide.";

export const VIS_GUIDE_PARAMETERS = Type.Object(
	{ kind: StringEnum(VIS_GUIDE_NAMES, { description: "The drawing kind or tool-backed tour entry, as the vis minor mode lists it, or a part the tour guide names" }) },
	{ additionalProperties: false },
);

/**
 * The server's hook (globalThis, Symbol.for): `(sessionId) => OwnVisKind[]`, the drawing kinds a
 * project or an extension adds to that session (`<owner>.<name>`, fixed for the session when it
 * started), each with the guide the model reads for it. Unset (a terminal, a worker), there are none,
 * and the tool is exactly Sova's kinds.
 */
export { VIS_OWN_KINDS_HOOK };

/** One own kind as the hook gives it: its fence word, its guide, and its line in the tool's words. */
export interface OwnVisKind {
	kind: string;
	guide: string;
	line: string;
}

/** The session's own kinds from the hook: only namespaced words (never one of the built-in kinds, which have no dot). */
export function ownVisKinds(sessionId: string | undefined): OwnVisKind[] {
	const hook = (globalThis as Record<symbol, unknown>)[VIS_OWN_KINDS_HOOK];
	if (typeof hook !== "function" || sessionId === undefined) return [];
	try {
		const got = (hook as (id: string) => unknown)(sessionId);
		if (!Array.isArray(got)) return [];
		return got.filter(
			(k): k is OwnVisKind =>
				!!k && typeof k.kind === "string" && /^[a-z0-9._-]+\.[a-z][a-z0-9-]*$/.test(k.kind) && !VIS_GUIDE_NAMES.includes(k.kind) && typeof k.guide === "string" && typeof k.line === "string",
		);
	} catch {
		return [];
	}
}

/** The guide an own kind's lookup returns: how its fence is written, then the guide its owner wrote. */
export const ownKindGuide = (k: OwnVisKind): string =>
	`vis ${k.kind} is one of this chat's own drawing kinds (${k.line}). Write it as a fenced block whose info string is \`vis ${k.kind}\`; an optional first line \`title: …\` and last line \`caption: …\` frame it, as in Sova's kinds. Its owner's guide:\n\n${k.guide}`;

function visGuideTool(own: readonly OwnVisKind[]) {
	const names = [...VIS_GUIDE_NAMES, ...own.map((k) => k.kind)];
	return {
		name: VIS_GUIDE_TOOL,
		label: "vis guide",
		description: own.length ? `${VIS_GUIDE_DESCRIPTION} This chat also has its own kinds, each drawn as a \`vis <owner>.<name>\` fence: ${own.map((k) => k.line).join("; ")}.` : VIS_GUIDE_DESCRIPTION,
		// No promptSnippet or guidelines: those would put the tool in the system prompt, and turning vis on
		// or off would rewrite it, which a minor toggle must never do. The vis block names the tool.
		parameters: own.length
			? Type.Object({ kind: StringEnum(names, { description: "The drawing kind or tool-backed tour entry, as the vis minor mode lists it, a part the tour guide names, or one of this chat's own kinds" }) }, { additionalProperties: false })
			: VIS_GUIDE_PARAMETERS,
		async execute(_id: string, params: { kind: unknown }) {
			const kind = String(params.kind);
			const mine = own.find((k) => k.kind === kind);
			return { content: [{ type: "text" as const, text: mine ? ownKindGuide(mine) : visGuide(kind) }], details: { kind } };
		},
	};
}

export function registerVisGuideTool(pi: ExtensionAPI): void {
	pi.registerTool(visGuideTool([]));
	// A Sova chat's own kinds (VIS_OWN_KINDS_HOOK), known once the session is: the tool is registered
	// again with them, once, before its first request, so its words never change mid-chat.
	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		let id: string | undefined;
		try {
			id = ctx.sessionManager.getSessionId();
		} catch {
			id = undefined;
		}
		const own = ownVisKinds(id);
		if (own.length) pi.registerTool(visGuideTool(own));
	});
}
