/**
 * Pure logic for the extension-toggle extension.
 *
 * No pi imports here so this module stays runnable under plain `node --test`.
 *
 * Model of pi's settings:
 *   - Local auto-discovered extensions (~/.pi/agent/extensions, .pi/extensions)
 *     are enabled/disabled through the top-level `extensions` pattern array in
 *     the corresponding settings.json. Pattern semantics mirror pi's
 *     applyPatterns: plain patterns are includes, `!pat` excludes, `+path`
 *     force-includes an exact path, `-path` force-excludes an exact path.
 *   - Package extensions (npm:/git:/local entries in `packages`) are filtered
 *     through the entry's object form: { source, extensions: [patterns] }.
 *     Omitted key = load all; [] = load none; patterns as above.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export type PackageEntry = string | PackageObject;

export interface PackageObject {
	source: string;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	autoload?: boolean;
	[key: string]: unknown;
}

export interface Settings {
	extensions?: string[];
	packages?: PackageEntry[];
	[key: string]: unknown;
}

export interface ExtResource {
	/** Stable row id: settingsPath + baseDir + fileRel. */
	id: string;
	/** Display name of the extension (package name or directory/file name). */
	name: string;
	/** Extra display context, e.g. "pi-web-access" or "global". */
	origin: string;
	kind: "local" | "package";
	/** File path relative to the pattern baseDir (always posix). */
	fileRel: string;
	baseDir: string;
	settingsPath: string;
	/** Index into settings.packages for package-backed rows. */
	packageIndex?: number;
	enabled: boolean;
}

// ---------------------------------------------------------------------------
// Settings IO

export function readSettings(file: string): Settings {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

export function writeSettings(file: string, settings: Settings): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(settings, null, "\t") + "\n");
	fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Minimal glob matching (subset of minimatch: *, **, ?)

export function globToRegExp(glob: string): RegExp {
	const segs = glob.split("/").map((seg) => {
		if (seg === "**") return "\u0000";
		return seg
			.split("")
			.map((ch) => (ch === "*" ? "\u0001" : ch === "?" ? "\u0002" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
			.join("")
			.replace(/\u0001/g, "[^/]*")
			.replace(/\u0002/g, "[^/]");
	});
	let src = segs.join("/");
	// "**/" -> zero or more leading dirs; "/**" -> zero or more trailing segments
	src = src
		.replace(/\u0000\//g, "(?:[^/]+/)*")
		.replace(/\/\u0000/g, "(?:/[^/]+)*")
		.replace(/\u0000/g, ".*");
	return new RegExp(`^${src}$`);
}

function normalizePattern(p: string): string {
	return p.startsWith("./") ? p.slice(2) : p;
}

/** True when `rel` (posix path relative to baseDir) is matched by `pattern`. */
export function matchRel(rel: string, pattern: string): boolean {
	const p = normalizePattern(pattern);
	const base = path.posix.basename(rel);
	return globToRegExp(p).test(rel) || globToRegExp(p).test(base);
}

/** Exact-path match, mirroring pi's normalizeExactPattern comparison. */
export function matchExact(rel: string, pattern: string): boolean {
	const p = normalizePattern(pattern);
	return p === rel;
}

/**
 * Compute whether a file is enabled under a pattern list, mirroring pi's
 * applyPatterns precedence: includes filter, excludes remove, force-includes
 * add back, force-excludes remove.
 */
export function computeEnabled(rel: string, patterns: string[]): boolean {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceInc: string[] = [];
	const forceExc: string[] = [];
	for (const p of patterns) {
		if (p.startsWith("+")) forceInc.push(p.slice(1));
		else if (p.startsWith("-")) forceExc.push(p.slice(1));
		else if (p.startsWith("!")) excludes.push(p.slice(1));
		else includes.push(p);
	}
	const inIncludes = includes.length === 0 || includes.some((p) => matchRel(rel, p));
	const excluded = excludes.some((p) => matchRel(rel, p));
	const forcedIn = forceInc.some((p) => matchExact(rel, p));
	const forcedOut = forceExc.some((p) => matchExact(rel, p));
	return ((inIncludes && !excluded) || forcedIn) && !forcedOut;
}

/** Toggle a file on/off inside a pattern list; returns the new list. */
export function togglePattern(patterns: string[], rel: string, enable: boolean): string[] {
	let next = patterns.filter((p) => {
		if (enable) {
			// remove any exclude or force-exclude targeting rel
			if (p.startsWith("!") && matchRel(rel, p.slice(1))) return false;
			if (p.startsWith("-") && matchExact(rel, p.slice(1))) return false;
		} else {
			// remove any force-include targeting rel
			if (p.startsWith("+") && matchExact(rel, p.slice(1))) return false;
		}
		return true;
	});
	next = next.filter((p, i) => next.indexOf(p) === i);
	if (enable) {
		if (!computeEnabled(rel, next) && !next.includes(`+${rel}`)) next.push(`+${rel}`);
	} else {
		if (computeEnabled(rel, next) && !next.includes(`!${rel}`)) next.push(`!${rel}`);
	}
	return next;
}

// ---------------------------------------------------------------------------
// Package source resolution

export function npmSpecName(spec: string): string {
	const body = spec.startsWith("npm:") ? spec.slice(4) : spec;
	if (body.startsWith("@")) {
		const i = body.indexOf("@", 1);
		return i > 0 ? body.slice(0, i) : body;
	}
	const i = body.indexOf("@");
	return i > 0 ? body.slice(0, i) : body;
}

export function packageBaseDir(source: string, agentDir: string, settingsDir: string): string | null {
	if (source.startsWith("npm:")) {
		return path.join(agentDir, "npm", "node_modules", npmSpecName(source));
	}
	if (source.startsWith("git:")) {
		return gitBaseDir(source.slice(4), agentDir);
	}
	if (/^(https?|ssh|git):\/\//.test(source)) {
		return gitBaseDir(source, agentDir);
	}
	if (source.startsWith("/") || source.startsWith(".")) {
		return path.resolve(settingsDir, source);
	}
	return null;
}

function gitBaseDir(s: string, agentDir: string): string | null {
	let rest = s;
	if (rest.startsWith("git@")) {
		rest = rest.slice(rest.indexOf("@") + 1).replace(":", "/");
	} else {
		const m = rest.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
		if (m) rest = `${m[1]}/${m[2]}`;
	}
	const slash = rest.indexOf("/");
	if (slash <= 0) return null;
	// drop @ref only when it comes after the first path segment
	const at = rest.lastIndexOf("@");
	if (at > slash) rest = rest.slice(0, at);
	rest = rest.replace(/\.git$/, "");
	const parts = rest.split("/").filter(Boolean);
	if (parts.length < 2) return null;
	return path.join(agentDir, "git", ...parts);
}

// ---------------------------------------------------------------------------
// File enumeration

const CODE_EXT = /\.(ts|js|mts|mjs|cts|cjs)$/;

/** All .ts/.js files under baseDir as posix rel paths, skipping node_modules and dot entries. */
export function walkCodeFiles(baseDir: string, relPrefix = ""): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(baseDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const e of entries) {
		if (e.name.startsWith(".") || e.name === "node_modules") continue;
		const full = path.join(baseDir, e.name);
		const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
		let isDir = e.isDirectory();
		if (e.isSymbolicLink()) {
			try {
				isDir = fs.statSync(full).isDirectory();
			} catch {
				continue;
			}
		}
		if (isDir) out.push(...walkCodeFiles(full, rel));
		else if (e.isFile() && CODE_EXT.test(e.name)) out.push(rel);
	}
	return out.sort();
}

/** Expand a manifest glob/entry (directory, file, or wildcard) to rel file paths. */
export function expandEntry(baseDir: string, entry: string): string[] {
	const clean = normalizePattern(entry);
	if (/[*?]/.test(clean)) {
		return walkCodeFiles(baseDir).filter((rel) => globToRegExp(clean).test(rel) || globToRegExp(clean).test(path.posix.basename(rel)));
	}
	const abs = path.join(baseDir, clean);
	let st: fs.Stats | null = null;
	try {
		st = fs.statSync(abs);
	} catch {
		st = null;
	}
	if (st?.isDirectory()) {
		return walkCodeFiles(abs, clean);
	}
	if (st?.isFile() && CODE_EXT.test(clean)) return [clean];
	return [];
}

/** Manifest extension files for a package/local dir, or [] for conventions. */
export function manifestExtensionFiles(baseDir: string): string[] | null {
	let pkg: { pi?: { extensions?: string[] }; [k: string]: unknown };
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(baseDir, "package.json"), "utf8"));
	} catch {
		return null;
	}
	const globs = pkg?.pi?.extensions;
	if (!Array.isArray(globs)) return null;
	const positives = globs.filter((g): g is string => typeof g === "string" && !g.startsWith("!"));
	const negatives = globs
		.filter((g): g is string => typeof g === "string" && g.startsWith("!"))
		.map((g) => g.slice(1));
	const out = new Set<string>();
	for (const g of positives) {
		for (const rel of expandEntry(baseDir, g)) {
			if (!negatives.some((n) => matchRel(rel, n))) out.add(rel);
		}
	}
	return [...out].sort();
}

/** Extension entry files for a local extension directory, as rel paths from the extensions root. */
export function localDirEntryFiles(dirPath: string, dirRel: string): string[] {
	const manifest = manifestExtensionFiles(dirPath);
	if (manifest) return manifest.map((rel) => `${dirRel}/${rel}`);
	for (const idx of ["index.ts", "index.js"]) {
		if (fs.existsSync(path.join(dirPath, idx))) return [`${dirRel}/${idx}`];
	}
	const conv = path.join(dirPath, "extensions");
	if (fs.existsSync(conv)) return walkCodeFiles(conv, `${dirRel}/extensions`);
	return [];
}

// ---------------------------------------------------------------------------
// Discovery

export interface DiscoveryOpts {
	agentDir?: string;
	cwd: string;
	/** Include project-local (.pi) resources; caller checks project trust. */
	includeProject: boolean;
}

function toPosix(p: string): string {
	return p.split(path.sep).join("/");
}

export function listExtensions(opts: DiscoveryOpts): ExtResource[] {
	const agentDir = opts.agentDir ?? path.join(homedir(), ".pi", "agent");
	const globalSettingsPath = path.join(agentDir, "settings.json");
	const projectSettingsPath = path.join(opts.cwd, ".pi", "settings.json");
	const projectExtDir = path.join(opts.cwd, ".pi", "extensions");
	const out: ExtResource[] = [];

	// --- local global
	const globalSettings = readSettings(globalSettingsPath);
	const globalPats = globalSettings.extensions ?? [];
	const globalExtDir = path.join(agentDir, "extensions");
	for (const r of localDirResources(globalExtDir, globalExtDir, globalPats, globalSettingsPath, "global")) out.push(r);

	// --- local project
	if (opts.includeProject && fs.existsSync(projectExtDir)) {
		const projectSettings = readSettings(projectSettingsPath);
		const projectPats = projectSettings.extensions ?? [];
		for (const r of localDirResources(projectExtDir, projectExtDir, projectPats, projectSettingsPath, "project")) out.push(r);
	}

	// --- packages (global then project)
	collectPackageResources(globalSettings, globalSettingsPath, agentDir, out);
	if (opts.includeProject && fs.existsSync(projectSettingsPath)) {
		collectPackageResources(readSettings(projectSettingsPath), projectSettingsPath, agentDir, out);
	}

	return out;
}

function localDirResources(extDir: string, baseDir: string, patterns: string[], settingsPath: string, origin: string): ExtResource[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(extDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: ExtResource[] = [];
	for (const e of entries) {
		if (e.name.startsWith(".") || e.name === "node_modules") continue;
		const full = path.join(extDir, e.name);
		let isDir = e.isDirectory();
		if (e.isSymbolicLink()) {
			try {
				isDir = fs.statSync(full).isDirectory();
			} catch {
				continue;
			}
		}
		let files: string[];
		if (isDir) {
			files = localDirEntryFiles(full, e.name);
		} else if (e.isFile() && CODE_EXT.test(e.name)) {
			files = [e.name];
		} else {
			continue;
		}
		for (const rel of files) {
			out.push({
				id: `${settingsPath}::${toPosix(baseDir)}::${rel}`,
				name: rel.replace(/\/index\.(ts|js)$/, "").replace(CODE_EXT, "") || rel,
				origin,
				kind: "local",
				fileRel: rel,
				baseDir: toPosix(baseDir),
				settingsPath,
				enabled: computeEnabled(rel, patterns),
			});
		}
	}
	return out;
}

function collectPackageResources(settings: Settings, settingsPath: string, agentDir: string, out: ExtResource[]): void {
	const packages = settings.packages;
	if (!Array.isArray(packages)) return;
	packages.forEach((entry, idx) => {
		const source = typeof entry === "string" ? entry : entry?.source;
		if (typeof source !== "string") return;
		const baseDir = packageBaseDir(source, agentDir, path.dirname(settingsPath));
		if (!baseDir || !fs.existsSync(baseDir)) return;
		const files = manifestExtensionFiles(baseDir) ?? walkCodeFiles(path.join(baseDir, "extensions")).map((r) => `extensions/${r}`);
		if (files.length === 0) return;
		const filters = typeof entry === "object" && Array.isArray(entry.extensions) ? entry.extensions : [];
		const pkgName = readPkgName(baseDir) ?? shortSourceName(source);
		for (const rel of files) {
			out.push({
				id: `${settingsPath}::${toPosix(baseDir)}::${rel}`,
				name: files.length === 1 ? pkgName : `${pkgName}/${rel}`,
				origin: source,
				kind: "package",
				fileRel: rel,
				baseDir: toPosix(baseDir),
				settingsPath,
				packageIndex: idx,
				enabled: computeEnabled(rel, filters),
			});
		}
	});
}

function readPkgName(baseDir: string): string | null {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(baseDir, "package.json"), "utf8"));
		return typeof pkg?.name === "string" ? pkg.name : null;
	} catch {
		return null;
	}
}

/** Short display name for a package source: npm name or last git/local path segment. */
export function shortSourceName(source: string): string {
	if (source.startsWith("npm:")) return npmSpecName(source);
	let s = source.replace(/^git:/, "").replace(/\/\.git$/, "");
	const m = s.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?[^/]+\/(.+)$/);
	if (m) s = m[1];
	else if (s.includes(":")) s = s.split(":").pop()!;
	const at = s.lastIndexOf("@");
	if (at > 0 && at > s.indexOf("/")) s = s.slice(0, at);
	const segs = s.split("/").filter(Boolean);
	return segs[segs.length - 1] ?? source;
}

// ---------------------------------------------------------------------------
// Toggling

/** Apply a toggle for one resource to its settings file. Returns true on change. */
export function applyToggle(res: ExtResource, enable: boolean): boolean {
	const settings = readSettings(res.settingsPath);
	if (res.kind === "local") {
		const pats = settings.extensions ?? [];
		const next = togglePattern(pats, res.fileRel, enable);
		if (arraysEqual(next, pats)) return false;
		if (next.length === 0) delete settings.extensions;
		else settings.extensions = next;
		writeSettings(res.settingsPath, settings);
		return true;
	}

	// package-backed
	const idx = res.packageIndex;
	if (typeof idx !== "number" || !Array.isArray(settings.packages) || settings.packages[idx] === undefined) return false;
	const entry = settings.packages[idx];
	if (typeof entry === "string") {
		if (enable) return false; // string entry loads everything; already on
		settings.packages[idx] = { source: entry, extensions: [`!${res.fileRel}`] };
		writeSettings(res.settingsPath, settings);
		return true;
	}
	const pats = Array.isArray(entry.extensions) ? entry.extensions : [];
	const next = togglePattern(pats, res.fileRel, enable);
	if (arraysEqual(next, pats)) return false;
	if (next.length === 0) delete entry.extensions;
	else entry.extensions = next;
	// revert to string form when no filter keys remain
	const hasFilters = ["extensions", "skills", "prompts", "themes"].some((k) => Array.isArray((entry as PackageObject)[k]));
	if (!hasFilters) settings.packages[idx] = entry.source;
	writeSettings(res.settingsPath, settings);
	return true;
}

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}
