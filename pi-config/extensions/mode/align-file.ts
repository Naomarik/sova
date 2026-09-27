/**
 * The align tool's `fromFile` reader. Node builtins only, so align.test.ts tests it directly.
 *
 * A hosted runtime lives in Sova's server process, so this read must never block or balloon it: only
 * a regular file (a FIFO with no writer would block the event loop for good, /dev/zero would grow
 * memory without bound), opened non-blocking, checked on the open descriptor, and read up to a cap.
 * In a remote session every file tool runs on the target and the cwd is a local placeholder: the
 * worker wrote the JSON over there, so a local read would miss it or read the wrong file. Refused.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";

/** An alignment is a page of text; a file past this is not one. */
export const ALIGN_FILE_MAX_BYTES = 256 * 1024;

function sizeText(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/**
 * The file's text, resolved against `cwd` (an absolute path is taken as is). `remoteTarget`: the
 * session's target when its tools run remotely. Throws an Error whose message says why.
 */
export function readAlignFile(cwd: string, path: string, remoteTarget?: string): string {
	if (remoteTarget !== undefined) {
		throw new Error(
			`this session's tools run on target "${remoteTarget}", and fromFile reads this machine's disk; create the alignment inline instead, with the fields of the worker's JSON`,
		);
	}
	const fd = openSync(resolve(cwd, path), constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("not a regular file");
		if (stat.size > ALIGN_FILE_MAX_BYTES) throw new Error(`${sizeText(stat.size)} is too large for an alignment (the limit is ${sizeText(ALIGN_FILE_MAX_BYTES)})`);
		// Read at most one byte past the cap: a file that grew since fstat is refused the same way.
		const buffer = Buffer.alloc(ALIGN_FILE_MAX_BYTES + 1);
		let length = 0;
		for (;;) {
			const n = readSync(fd, buffer, length, buffer.length - length, null);
			if (n === 0) break;
			length += n;
			if (length > ALIGN_FILE_MAX_BYTES) throw new Error(`it is too large for an alignment (the limit is ${sizeText(ALIGN_FILE_MAX_BYTES)})`);
		}
		return buffer.toString("utf8", 0, length);
	} finally {
		closeSync(fd);
	}
}
