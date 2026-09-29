/**
 * The `Also changes:` line: one grammar, one parser, for every reader (the pi check in spec-guard.ts, the
 * Claude Code Stop hook, the A/B harness scorer). Plain node: no imports, erasable TypeScript only.
 *
 * Grammar (spec-mode.md states it in one sentence):
 *   line  := "Also changes: none" | "Also changes: " item ("; " item)*
 *   item  := ids [separator description]
 *   ids   := §full-id ("," (§full-id | /suffix))*      a /suffix replaces the preceding full id's last segment
 *   separator := " — " | " – " | " - " | ":" | "(" …   anything after the ids is description
 * Only the ids leading each `;`-separated item are named; a § inside a description never counts. Markdown
 * emphasis around the line and backticks are ignored, as is a final period. A line that starts "Also
 * changes" but breaks the grammar is a format error, reported as such, never read as a list.
 */

/** A full § id. */
const FULL_ID = String.raw`§[A-Za-z0-9](?:[\w.\-/]*[\w-])?`;
/** A suffix id (`/leaf`), completed from the preceding full id. */
const SUFFIX_ID = String.raw`/[\w-](?:[\w.\-/]*[\w-])?`;
const LEAD = new RegExp(`^(${FULL_ID})`);
const NEXT = new RegExp(`^\\s*,\\s*(${FULL_ID}|${SUFFIX_ID})(?![\\w.\\-/])`);
/** Another item hidden in a description: a sentence or clause that starts with `§id:` / `§id —`. */
const HIDDEN_ITEM = new RegExp(`(?:^|[.!?]\\s+)(${FULL_ID})\\s*(?::|\\s[—–-]\\s)`);

/** The line a reply writes, right above its last line, when the computed foreign list is wrong. */
export const ALSO_CHANGES_OVERRIDE = "Spec check override:";
/** `Plumbing: <path> — <why>`: a changed file no claim maps that changes no user-visible behavior. */
export const PLUMBING_LINE = "Plumbing:";
/** `Deferred: §X, §Y — <why>`: draft records left unpromoted at a landing, the § they leave stale named. */
export const DEFERRED_LINE = "Deferred:";

export interface AlsoChangesItem {
	/** The § this item names, suffixes completed. */
	ids: string[];
	/** Everything after the ids (separator included), trimmed. */
	text: string;
}

export type AlsoChangesLine =
	| { ok: true; none: boolean; ids: string[]; items: AlsoChangesItem[] }
	| { ok: false; error: string };

/** A /suffix completed from a full id: its last `/` segment replaced (appended when it has none). */
export function completeSuffix(full: string, suffix: string): string {
	const cut = full.lastIndexOf("/");
	return cut < 0 ? `${full}${suffix}` : `${full.slice(0, cut)}${suffix}`;
}

/** The reply's last non-empty line, trimmed. */
export function lastLine(text: string): string {
	const lines = text.trimEnd().split("\n");
	return (lines[lines.length - 1] ?? "").trim();
}

/** Whether a line tries to be the `Also changes:` line (well-formed or not). */
export function looksLikeAlsoChanges(line: string): boolean {
	return /^\W*Also changes\b/i.test(line.trim());
}

/**
 * Parse one line. undefined: not an `Also changes` line at all. `{ ok: false, error }`: it tries to be one
 * but breaks the grammar. `{ ok: true }`: `none`, or the ids each item leads with.
 */
export function parseAlsoChangesLine(raw: string): AlsoChangesLine | undefined {
	const line = raw.trim().replace(/^[*_]+|[*_]+$/g, "").replace(/`/g, "").trim();
	if (!looksLikeAlsoChanges(line)) return undefined;
	const m = /^Also changes: (.*)$/.exec(line);
	if (!m) return { ok: false, error: 'the line must start exactly "Also changes: "' };
	const body = m[1].trim().replace(/\.$/, "").trim();
	if (!body) return { ok: false, error: "the line names nothing: write `none` or the § it changes" };
	if (/^none\b/i.test(body)) {
		if (new RegExp(FULL_ID).test(body)) return { ok: false, error: "the line says none but names a §" };
		return { ok: true, none: true, ids: [], items: [] };
	}
	const items: AlsoChangesItem[] = [];
	const ids: string[] = [];
	for (const part of body.split(";").map((p) => p.trim()).filter(Boolean)) {
		const lead = LEAD.exec(part);
		if (!lead) return { ok: false, error: `each item starts with the § it names ("${part.slice(0, 40)}" doesn't)` };
		const named = [lead[1]];
		let rest = part.slice(lead[0].length);
		let full = lead[1];
		for (let next = NEXT.exec(rest); next; next = NEXT.exec(rest)) {
			const id = next[1].startsWith("/") ? completeSuffix(full, next[1]) : next[1];
			if (!next[1].startsWith("/")) full = id;
			named.push(id);
			rest = rest.slice(next[0].length);
		}
		const text = rest.trim();
		const hidden = HIDDEN_ITEM.exec(text.replace(/^[—–:-]\s*/, ""));
		if (hidden) return { ok: false, error: `separate items with ";" (${hidden[1]} reads as a new item inside a description)` };
		items.push({ ids: named, text });
		for (const id of named) if (!ids.includes(id)) ids.push(id);
	}
	if (!items.length) return { ok: false, error: "the line names nothing: write `none` or the § it changes" };
	return { ok: true, none: false, ids, items };
}

/** The ids a well-formed line names ([] for none); undefined for anything else, a format error included. */
export function parseAlsoChanges(line: string): string[] | undefined {
	const p = parseAlsoChangesLine(line);
	return p?.ok ? p.ids : undefined;
}

/**
 * The reply without its closing `Also changes:` line (and an override line right above it): for readers
 * that show or classify a reply (feeds, summaries, previews), where the line is bookkeeping, not content.
 */
export function stripAlsoChanges(text: string): string {
	const lines = text.trimEnd().split("\n");
	if (!lines.length || !looksLikeAlsoChanges(lines[lines.length - 1])) return text;
	lines.pop();
	if (lines.length && lines[lines.length - 1].trim().startsWith(ALSO_CHANGES_OVERRIDE)) lines.pop();
	return lines.join("\n").trimEnd();
}

const lineBody = (raw: string, tag: string): string | undefined => {
	const line = raw.trim().replace(/^[*_]+|[*_]+$/g, "").replace(/`/g, "").trim();
	return line.startsWith(tag) ? line.slice(tag.length).trim() : undefined;
};
/** The text before a line's reason (` — `, ` – `, ` - `). */
const beforeReason = (body: string): { head: string; why: string } => {
	const m = /\s[—–-]\s/.exec(body);
	return m ? { head: body.slice(0, m.index).trim(), why: body.slice(m.index + m[0].length).trim() } : { head: body, why: "" };
};

/** Paths the reply's `Plumbing: <path>[, <path>] — <why>` lines name (a reason is required). */
export function plumbingPaths(reply: string): string[] {
	const out: string[] = [];
	for (const raw of reply.split("\n")) {
		const body = lineBody(raw, PLUMBING_LINE);
		if (body === undefined) continue;
		const { head, why } = beforeReason(body);
		if (!why) continue;
		for (const p of head.split(/,\s*/).map((x) => x.trim()).filter(Boolean)) out.push(p.replace(/^\.\//, ""));
	}
	return out;
}

/** § the reply's `Deferred: §X[, §Y | /suffix] — <why>` lines name (a reason is required). */
export function deferredIds(reply: string): string[] {
	const out: string[] = [];
	for (const raw of reply.split("\n")) {
		const body = lineBody(raw, DEFERRED_LINE);
		if (body === undefined) continue;
		const { head, why } = beforeReason(body);
		if (!why) continue;
		const parsed = parseAlsoChangesLine(`Also changes: ${head}`);
		if (parsed?.ok) out.push(...parsed.ids);
	}
	return out;
}

export interface LandingGate {
	ok: boolean;
	/** Unmapped changed paths no `Plumbing:` line names. */
	missingPlumbing: string[];
	/** Unpromoted records' § no `Deferred:` line names. */
	missingDeferral: string[];
}

/**
 * The landing gate on a reply (merge and promote turns): each changed file no claim maps needs a
 * `Plumbing: <path> — <why>` line (or a claim mapping it, which removes it from `unmappedChanged`), and
 * each unpromoted draft record's § a `Deferred: §X — <why>` line. Shapes as core's `foreign --landing`.
 */
export function landingGate(reply: string, lists: { unmappedChanged?: readonly { path: string }[] | readonly string[]; unpromotedDrafts?: readonly { ids: readonly string[] }[] }): LandingGate {
	const plumbing = plumbingPaths(reply);
	const deferred = deferredIds(reply);
	const paths = (lists.unmappedChanged ?? []).map((e) => (typeof e === "string" ? e : e.path));
	const ids = [...new Set((lists.unpromotedDrafts ?? []).flatMap((d) => d.ids))];
	const missingPlumbing = [...new Set(paths)].filter((p) => !plumbing.includes(p));
	const missingDeferral = ids.filter((id) => !deferred.includes(id));
	return { ok: !missingPlumbing.length && !missingDeferral.length, missingPlumbing, missingDeferral };
}
