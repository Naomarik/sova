/**
 * realpath that survives macOS TCC-protected directories.
 *
 * Under Bun on macOS, `realpathSync` on a TCC-protected directory (~/Library/Cookies, Safari, Mail,
 * Messages, Application Support/com.apple.TCC, ...) throws EPERM ("lstat ...") although
 * `lstatSync`/`statSync` on the same path succeed. The Seatbelt backend hides exactly those
 * directories, so a plain realpath there failed every profile build.
 *
 * Only on darwin and only for EPERM/EACCES, the path is resolved one component at a time instead:
 * the parent is resolved (with the same tolerance) and the leaf appended; a leaf that `lstat` shows
 * is a symlink is followed by hand (bounded), so the result is still the canonical spelling a deny
 * rule must name. Everywhere else (any other platform, any other error) this is exactly
 * `realpathSync(p)`: same call, same result, same throw.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The fs calls the fallback makes; injectable so tests can simulate EPERM anywhere. */
export interface RealpathIo {
	realpath(p: string): string;
	lstat(p: string): { isSymbolicLink(): boolean };
	readlink(p: string): string;
}

export const defaultIo: RealpathIo = {
	realpath: (p) => realpathSync(p),
	lstat: (p) => lstatSync(p),
	readlink: (p) => readlinkSync(p),
};

const MAX_HOPS = 40;

export function tolerantRealpath(p: string, io: RealpathIo = defaultIo, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "darwin") return io.realpath(p);
	return darwinRealpath(p, io, 0);
}

function darwinRealpath(p: string, io: RealpathIo, hops: number): string {
	try {
		return io.realpath(p);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EPERM" && code !== "EACCES") throw err;
		const parent = dirname(p);
		if (parent === p) throw err;
		let isLink = false;
		try {
			isLink = io.lstat(p).isSymbolicLink();
		} catch (e) {
			const c = (e as NodeJS.ErrnoException).code;
			// Gone after all: the caller's not-found walk handles it.
			if (c === "ENOENT" || c === "ENOTDIR") throw e;
			// lstat refused too: nothing can follow a link no one can read; spell the leaf lexically.
		}
		if (isLink) {
			if (hops >= MAX_HOPS) throw err;
			return darwinRealpath(resolve(parent, io.readlink(p)), io, hops + 1);
		}
		return join(darwinRealpath(parent, io, hops), basename(p));
	}
}
