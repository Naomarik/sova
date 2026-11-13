/**
 * The `align` tool's call and result renderers for the pi terminal (align-tool.ts registers them).
 *
 * render never throws: anything unreadable falls back to the result's text.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { alignStatus, alignStatusWord, normalizeAlignDetails, openQuestionsOf, reviewLines, openText, recommendedText, toMarkdown } from "./align.ts";

// ── The tool row ─────────────────────────────────────────────────────────────

function opWord(op: Record<string, unknown>): string {
	const q = op.q ?? op.qs;
	const qs = Array.isArray(q) ? q.join(",") : typeof q === "string" ? q : "";
	switch (op.op) {
		case "create":
			// An older session's call imported with create + fromFile.
			return op.fromFile !== undefined ? `import ${String(op.fromFile)}` : `create "${String(op.title ?? "")}"`;
		case "import":
			return `import ${String(op.path ?? "")}`;
		case "status":
			return `→ ${String(op.to ?? "?")}`;
		case "edit":
		case "edit_rejected":
			return `edit ${typeof op.id === "string" ? op.id : "title"}`;
		case "edit_question":
			return `edit ${qs}`;
		case "edit_doc":
			return `edit ${["title", "summary"].filter((k) => op[k] !== undefined).join(",") || "title"}`;
		case "remove":
			return `remove ${Array.isArray(op.ids) ? op.ids.join(",") : ""}`;
		case "accept_all":
			return "accept all";
		case "drop_question":
			return `drop ${qs}`;
		case "drop":
		case "drop_alignment":
			return qs ? `drop ${qs}` : "drop";
		default:
			return qs ? `${String(op.op)} ${qs}` : String(op.op ?? "?");
	}
}

/** One dim line: "◇ align al_3 · decide q3 · accept all · → implementing". */
export function renderAlignCall(args: unknown, theme: Theme): Component {
	const a = (args ?? {}) as { doc?: unknown; ops?: unknown };
	const ops = Array.isArray(a.ops) ? a.ops.filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null) : [];
	const target = typeof a.doc === "string" ? ` ${a.doc}` : "";
	const words = ops.map(opWord).join(" · ");
	return new Text(theme.fg("dim", `◇ align${target}${words ? ` · ${words}` : ""}`), 0, 0);
}

/**
 * The result: the document's line and what changed, then its open questions with the
 * recommendations (the whole document when expanded). An exemption is one line; anything
 * unreadable falls back to the result's text.
 */
export function renderAlignResult(result: { content?: unknown; details?: unknown }, expanded: boolean, theme: Theme): Component {
	const details = normalizeAlignDetails(result.details);
	const fallback = Array.isArray(result.content)
		? result.content
				.map((c) => (typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
				.join("\n")
		: "";
	if (!details) return new Text(theme.fg("dim", fallback), 0, 0);
	if (details.exempt) return new Text(theme.fg("dim", `No alignment needed: ${details.exempt.why}`), 0, 0);
	const doc = details.doc;
	if (!doc) return new Text(theme.fg("dim", expanded ? fallback : fallback.split("\n")[0] ?? ""), 0, 0);
	if (expanded) return new Text(toMarkdown(doc), 0, 0);
	const status = alignStatus(doc);
	const tone = status === "aligning" ? "accent" : status === "dropped" ? "dim" : "success";
	const lines = [
		`${theme.fg(tone, theme.bold(`${doc.id} ${doc.title}`))} ${theme.fg("dim", `· ${alignStatusWord(status)} · ${openText(doc)} · v${doc.rev}${details.line ? ` · ${details.line}` : ""}`)}`,
		...openQuestionsOf(doc).map((q) => `  ${theme.fg("accent", q.id)} ${q.topic}: ${q.ask} ${theme.fg("dim", `(rec: ${recommendedText(q)})`)}`),
		// The review record (adversarial review): only a document that carries one has these lines.
		...reviewLines(doc).map((l) => theme.fg("dim", `  ${l}`)),
	];
	return new Text(lines.join("\n"), 0, 0);
}
