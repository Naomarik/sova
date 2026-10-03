/**
 * The session copy a background fork works in. The child forks this copy (`pi --fork <copy>`),
 * never the parent's own file: pi's fork (`SessionManager.forkFrom` → `loadEntriesFromFile`)
 * appends "\n" to a source whose last line is partial, and the parent may be mid-append right
 * now. The copy also records the parent's cache identity (`./cache.ts`), so the child asks for the
 * parent's warm prompt cache exactly as a UI-created fork does.
 *
 * Builtins only.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORK_CACHE_ENTRY, forkCacheEntry } from "./cache.ts";

const MESSAGE_MARK = '"type":"message"';
const SCAN_CHUNK = 64 * 1024;

/**
 * A parent session can be forked only once it holds a real conversation: pi
 * writes the header line the moment a session starts, so a brand-new session
 * whose first input is a slash command has a file that is only that header — and
 * a fork of it is EMPTY while the UI would claim "forked". So: at least one
 * `"type":"message"` line. Read in chunks with an early exit on the first hit,
 * never JSON-parsed (a substring test; only adversarial JSON could fool it, and
 * session files are not that). Unreadable or missing means not forkable.
 */
export function forkable(sessionFile: string | undefined): sessionFile is string {
	if (!sessionFile) return false;
	let fd: number | undefined;
	try {
		fd = openSync(sessionFile, "r");
		const buffer = Buffer.alloc(SCAN_CHUNK);
		// Keep a tail across chunk boundaries so a mark split between two reads is still found.
		let carry = "";
		for (;;) {
			const read = readSync(fd, buffer, 0, SCAN_CHUNK, null);
			if (read <= 0) return false;
			const text = carry + buffer.toString("latin1", 0, read);
			if (text.includes(MESSAGE_MARK)) return true;
			carry = text.slice(-(MESSAGE_MARK.length - 1));
		}
	} catch {
		return false; // Missing, a directory, unreadable: nothing to fork.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function parsed(line: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(line);
		return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The cache entry to append to a copy of `text` (complete lines only), or undefined when the copy
 * cannot carry one: no header id, or a last line that is not an entry with an id. Only lines
 * that mention the entry type are parsed, so a long parent costs one substring scan.
 */
function cacheEntryLine(text: string): string | undefined {
	const lines = text.split("\n").filter((line) => line.trim());
	const header = parsed(lines[0] ?? "");
	const last = lines.length > 1 ? parsed(lines[lines.length - 1]!) : undefined;
	if (header?.type !== "session" || typeof header.id !== "string" || !header.id) return undefined;
	if (!last || typeof last.id !== "string" || !last.id) return undefined;
	const lineage = lines.filter((line) => line.includes(FORK_CACHE_ENTRY)).map(parsed).filter((entry): entry is Record<string, unknown> => !!entry);
	const ids = new Set(lines.map((line) => /"id":"([^"]*)"/.exec(line)?.[1]));
	let id: string;
	do id = randomBytes(4).toString("hex");
	while (ids.has(id));
	return JSON.stringify(forkCacheEntry(id, last.id, header.id, lineage));
}

/**
 * Copy `source` to `target`, cut after its last newline, and append the fork's cache entry
 * (parented on the last copied entry, so the active branch is unchanged and nothing enters the
 * model's context). The partial line of a parent mid-append is simply left out. False when there
 * is no complete line to copy. A copy that cannot carry the entry is still a valid fork; it just
 * asks for its own cache key.
 */
export function copyForFork(source: string, target: string): boolean {
	let fd: number | undefined;
	let bytes: Buffer;
	try {
		fd = openSync(source, "r");
		const size = fstatSync(fd).size;
		bytes = Buffer.alloc(size);
		let off = 0;
		while (off < size) {
			const read = readSync(fd, bytes, off, size - off, off);
			if (read <= 0) break;
			off += read;
		}
		bytes = bytes.subarray(0, off);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	const end = bytes.lastIndexOf(0x0a);
	if (end < 0) return false;
	const copy = bytes.subarray(0, end + 1);
	const entry = cacheEntryLine(copy.toString("utf8"));
	writeFileSync(target, entry ? Buffer.concat([copy, Buffer.from(`${entry}\n`)]) : copy, { mode: 0o600 });
	return true;
}

/** Delete the entries of `dir` older than `maxAgeMs` that `keep` does not claim: copies and session dirs a dead parent left behind. */
export function sweepStale(dir: string, maxAgeMs: number, now: number, keep: (name: string) => boolean = () => false): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const path = join(dir, name);
		try {
			if (!keep(name) && now - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { recursive: true, force: true });
		} catch {
			/* Raced with another sweep. */
		}
	}
}
