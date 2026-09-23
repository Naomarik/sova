/**
 * The `/explain` contract: where a page lives, what `meta.json` must contain,
 * and what the parent session records for it. Nothing here imports pi, so the
 * store can be exercised (and the web app's expectations checked) in plain tests.
 *
 * Store layout, one directory per explanation, kept forever:
 *
 *   ~/.pi/agent/explanations/<id>/index.html   self-contained page, zero external requests
 *   ~/.pi/agent/explanations/<id>/meta.json    { id, topic, summary, parentSessionId, cwd, createdAt, model }
 *
 * `id` is the directory name and matches [A-Za-z0-9_-]+, so it is safe in a URL
 * path segment and as a filesystem name.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** customType of the session entry (`pi.appendEntry`). */
export const EXPLAIN_ENTRY_TYPE = "explain-doc";
/** Legal explanation ids (also the directory name). */
export const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ID_LENGTH = 120;
const MAX_SLUG_LENGTH = 48;

/** `meta.json`, written by the child and normalized by the parent. */
export interface ExplainMeta {
	id: string;
	topic: string;
	/** One honest paragraph from the child; never a heading or a bullet list. */
	summary: string;
	parentSessionId: string;
	cwd: string;
	/** ISO 8601. */
	createdAt: string;
	/** Model id the child actually ran on. */
	model: string;
}

/** Everything the parent knows before the child runs; the child cannot change it. */
export type KnownMeta = Omit<ExplainMeta, "summary">;

/**
 * Payload of an `explain-doc` entry.
 *
 * `error` and `note` are the two halves of "the run went wrong", and they mean
 * different things to a reader:
 *
 *   error   FATAL. There is no servable page at the store path; nothing to open.
 *   note    Advisory. The page IS complete on disk and opens normally, but the
 *           run errored or was aborted afterwards, so treat the page as possibly
 *           unfinished work rather than a clean result.
 *
 * At most one of them is ever set, and a successful run sets neither.
 *
 * `status: "running"` marks the provisional entry appended when the child is
 * spawned, so the row is visible for the whole run and not only at the end.
 * The value space is exactly "running" or absent: the final entry (same `id`,
 * appended when the run settles) never carries the field, so it supersedes the
 * running one and every entry written before the field existed stays valid.
 * A running entry has an empty summary and never `error` or `note`.
 */
export interface ExplainEntryData {
	id: string;
	topic: string;
	summary: string;
	createdAt: string;
	parentSessionId: string;
	/** Model that produced the page; also stamped in the page's byline. Omitted, never "", when unknown. */
	model?: string;
	error?: string;
	note?: string;
	/** Only on the provisional entry of a run still in progress; see above. */
	status?: "running";
}

/** What went wrong, and whether it cost the reader the page. */
export type ExplainProblem = { kind: "error" | "note"; text: string };

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
	return configured || join(homedir(), ".pi", "agent");
}

/** Root of the permanent store. */
export function explanationsRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), "explanations");
}

export function isExplanationId(id: unknown): id is string {
	return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH && ID_PATTERN.test(id);
}

/** Readable, id-legal stem of a topic; never empty. */
export function slugify(topic: string): string {
	const slug = topic
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH)
		.replace(/-+$/g, "");
	return slug || "explanation";
}

/**
 * `<slug>-<base36 ms>`: stable enough to recognize, unique enough that two
 * explanations of the same topic never collide. `taken` is consulted so a
 * re-run inside the same millisecond still gets its own directory.
 */
export function newId(topic: string, now: number = Date.now(), taken: (id: string) => boolean = () => false): string {
	const base = `${slugify(topic)}-${Math.max(0, Math.floor(now)).toString(36)}`;
	if (!taken(base)) return base;
	for (let n = 2; n < 1000; n++) {
		const candidate = `${base}-${n}`;
		if (!taken(candidate)) return candidate;
	}
	return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

export function storeDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
	if (!isExplanationId(id)) throw new Error(`Invalid explanation id: ${JSON.stringify(id)}`);
	return join(explanationsRoot(env), id);
}

export function indexPath(dir: string): string {
	return join(dir, "index.html");
}

export function metaPath(dir: string): string {
	return join(dir, "meta.json");
}

/** Create the directory the child writes into. Readable by the web app, hence the default mode. */
export function ensureStoreDir(dir: string): string {
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Atomic: a reader never sees a half-written `meta.json`, and the web app's
 * "meta present ⇒ the page is servable" rule cannot be broken by a torn write.
 * Callers must have validated `index.html` first.
 */
export function writeMeta(dir: string, meta: ExplainMeta): void {
	const temp = join(dir, `.meta.json.${process.pid}.tmp`);
	writeFileSync(temp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
	try {
		renameSync(temp, metaPath(dir));
	} catch (error) {
		try {
			rmSync(temp, { force: true });
		} catch {
			/* The temp file is dotted and ignored by readers. */
		}
		throw error;
	}
}

/**
 * A `meta.json` with no page next to it breaks "meta present ⇒ servable", and
 * the child writes the two files itself, so a child that inverted the order and
 * then died can leave exactly that. Dropping it is best effort: the failure is
 * recorded in the session entry either way.
 */
export function dropOrphanMeta(dir: string): boolean {
	if (!existsSync(metaPath(dir))) return false;
	try {
		rmSync(metaPath(dir), { force: true });
		return true;
	} catch {
		return false;
	}
}

/** Parsed `meta.json`, or undefined when it is missing or not JSON. */
export function readMeta(dir: string): unknown {
	try {
		return JSON.parse(readFileSync(metaPath(dir), "utf8"));
	} catch {
		return undefined;
	}
}

/** One paragraph: whitespace collapsed, markdown list/heading markers off the front. */
export function oneParagraph(text: unknown, max = 1200): string {
	if (typeof text !== "string") return "";
	const flat = text
		.replace(/\s+/g, " ")
		.replace(/^\s*(?:[#>*-]+\s*)+/, "")
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The parent owns every field except `summary`: the child can get its own model
 * id or the session id wrong, and a bad value would poison the store and the
 * session entry. Returns the meta that should be on disk.
 */
export function normalizeMeta(raw: unknown, known: KnownMeta): ExplainMeta {
	const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return { ...known, summary: oneParagraph(record.summary) };
}

export function metaMatches(raw: unknown, meta: ExplainMeta): boolean {
	if (!raw || typeof raw !== "object") return false;
	const record = raw as Record<string, unknown>;
	return (Object.keys(meta) as (keyof ExplainMeta)[]).every((key) => record[key] === meta[key]);
}

/** Tags where an `href` fetches something instead of just pointing at it. */
const HREF_FETCHES = new Set(["link", "script", "use", "image"]);
const REMOTE = /^(?:https?:|ftp:)?\/\//i;

/**
 * Anything that makes the page hit the network when it is OPENED — subresources
 * only. A citation `<a href="https://…">` is not one of them: it fetches nothing
 * until the reader clicks it, and marking it would train everyone to ignore this
 * warning. (Found by the first live run, which cited three RFCs and blog posts.)
 */
export function scanExternalRefs(html: string): string[] {
	const found = new Set<string>();
	for (const tag of html.matchAll(/<\s*([a-zA-Z][\w:-]*)\b([^>]*)>/g)) {
		const name = tag[1].toLowerCase();
		for (const attribute of tag[2].matchAll(/\b([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
			const key = attribute[1].toLowerCase();
			const value = (attribute[2] ?? attribute[3] ?? attribute[4] ?? "").trim();
			const fetches = key === "src" || key === "srcset" || key === "poster" || key === "data" || ((key === "href" || key === "xlink:href") && HREF_FETCHES.has(name));
			if (!fetches) continue;
			// srcset is a comma-separated candidate list, each "<url> <descriptor>".
			const urls = key === "srcset" ? value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0] ?? "") : [value];
			for (const url of urls) if (REMOTE.test(url)) found.add(url.slice(0, 120));
		}
	}
	for (const match of html.matchAll(/url\(\s*['"]?((?:https?:)?\/\/[^)'"]+)/gi)) found.add(match[1].slice(0, 120));
	for (const match of html.matchAll(/@import\s+['"]((?:https?:)?\/\/[^'"]+)/gi)) found.add(match[1].slice(0, 120));
	return [...found];
}

/**
 * Page requirements that are cheap to verify: what a phone reader notices when
 * it is missing, and what the web app's gallery thumbnail needs.
 *
 * The thumbnail renders the stored file in an `<iframe sandbox="">`, which runs
 * NO scripts at all. The `?theme=` script is still required (it is the contract,
 * and the standalone page needs it), but it must only ever *override* a page
 * that already looks right without it — hence the `prefers-color-scheme` check
 * and the one-script rule.
 */
export function pageWarnings(html: string): string[] {
	const warnings: string[] = [];
	if (!/<meta[^>]+name=["']viewport["']/i.test(html)) warnings.push("no viewport meta tag");
	if (!/[?&]theme=|searchParams|location\.search/i.test(html)) warnings.push("no ?theme= handling");
	if (!/prefers-color-scheme/i.test(html)) warnings.push("no prefers-color-scheme fallback (the sandboxed thumbnail runs no scripts)");
	const scripts = [...html.matchAll(/<script\b/gi)].length;
	if (scripts > 1) warnings.push(`${scripts} scripts (only the inline theme script is allowed; the thumbnail runs none of them)`);
	if (/<svg\b/i.test(html) && !/viewBox=/i.test(html)) warnings.push("an SVG without viewBox");
	// The byline is what makes the producing model visible in the cropped thumbnail.
	if (!/Explained by/i.test(html)) warnings.push("no model byline under the title");
	return warnings;
}

export interface StoreCheck {
	ok: boolean;
	/** Present when the store is usable. */
	meta?: ExplainMeta;
	/** Why the store is unusable. */
	error?: string;
	/** Non-fatal: the page exists but deviates from the contract. */
	warnings: string[];
}

/**
 * Validate what the child left behind, and repair `meta.json` when the child
 * wrote it wrong, skipped it, or corrupted it. A missing or empty `index.html`
 * is the only fatal case: without the page there is nothing to record.
 */
export function validateStore(dir: string, known: KnownMeta): StoreCheck {
	const warnings: string[] = [];
	let html: string;
	try {
		const stats = statSync(indexPath(dir));
		if (!stats.isFile() || stats.size === 0) return fatal(dir, `index.html is empty or not a file: ${indexPath(dir)}`, warnings);
		html = readFileSync(indexPath(dir), "utf8");
	} catch {
		return fatal(dir, `no index.html was written to ${dir}`, warnings);
	}
	const raw = readMeta(dir);
	if (raw === undefined) warnings.push("meta.json was missing or unreadable (rewritten)");
	const meta = normalizeMeta(raw, known);
	if (!meta.summary) warnings.push("meta.json had no summary");
	if (!metaMatches(raw, meta)) {
		try {
			writeMeta(dir, meta);
		} catch (error) {
			return fatal(dir, `could not write meta.json: ${String(error)}`, warnings);
		}
	}
	const external = scanExternalRefs(html);
	if (external.length) warnings.push(`page makes external requests: ${external.slice(0, 3).join(", ")}`);
	warnings.push(...pageWarnings(html));
	return { ok: true, meta, warnings };
}

/**
 * No page means nothing for the web app to serve, so a `meta.json` the child
 * left behind is removed here rather than in every caller.
 */
function fatal(dir: string, error: string, warnings: string[]): StoreCheck {
	if (dropOrphanMeta(dir)) warnings.push("removed a meta.json that had no page next to it");
	return { ok: false, error, warnings };
}

/**
 * The session entry for a finished run. At most one of `error` (fatal: no page)
 * and `note` (advisory: the page is there) is ever set.
 */
export function entryData(meta: ExplainMeta, problem?: ExplainProblem): ExplainEntryData {
	const data: ExplainEntryData = {
		id: meta.id,
		topic: meta.topic,
		summary: meta.summary,
		createdAt: meta.createdAt,
		parentSessionId: meta.parentSessionId,
	};
	// Absent rather than empty: a reader that renders whatever is present must
	// never end up displaying a model named "".
	if (meta.model) data.model = meta.model;
	if (problem?.text) data[problem.kind] = problem.text;
	return data;
}

/**
 * The provisional entry for a run that has just been spawned: what the parent
 * knows, an empty summary, and `status: "running"`. Its final entry (same id,
 * from `entryData`) supersedes it when the run settles.
 */
export function runningEntryData(known: KnownMeta): ExplainEntryData {
	return { ...entryData({ ...known, summary: "" }), status: "running" };
}

/** True when a directory already holds an explanation. */
export function storeExists(dir: string): boolean {
	return existsSync(dir);
}
