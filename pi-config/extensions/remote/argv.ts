/**
 * Remote targets: the entry schema of ~/.pi/agent/targets.json and the ONE argv builder every
 * caller uses to run a command on a target (the remote extension's tools, Sova's folder browser).
 *
 * Pure and pi-runtime-free (node builtins only): Sova's server imports this file, so keep it
 * that way. Nothing here spawns; callers pass the argv to `spawn(argv[0], argv.slice(1))` with no
 * local shell.
 *
 * Quoting model. A composed argv crosses at most these parsers:
 *   - ssh joins its trailing words and the far login shell parses them: every word of the far argv
 *     is `shQuote`d (`shJoin`), so the far shell rebuilds exactly the argv we built;
 *   - `docker exec` / `incus exec` pass argv through without a shell;
 *   - the innermost `sh -c <script>`: the caller's command is shell code by design, and every value
 *     WE splice into it (cwd, paths) is `shQuote`d.
 * `via` nests one more layer: the inner argv is `shJoin`ed into the outer target's `sh -c`.
 * Single quotes are the only escaping used, and they are exact: inside '…' nothing is special, and
 * a literal ' is written as '\''.
 */
import { homedir } from "node:os";
import { join, posix } from "node:path";

export interface TargetSsh {
	/** Login user; omitted = ssh's default (ssh_config / local user). `root` is allowed. */
	user?: string;
	/** Hostname, IP, ssh_config alias, or (with proxy aws-ssm) the EC2 instance id. */
	host: string;
	port?: number;
	/** Private key PATH (never key material). `~/` is expanded locally. */
	key?: string;
	/** Extra `-o` options, e.g. "ControlMaster=auto". User options win over our defaults except BatchMode. */
	options?: string[];
}

export interface TargetProxy {
	type: "aws-ssm";
	/** AWS profile NAME (credentials stay in ~/.aws). */
	profile?: string;
	region?: string;
	/** Push the key's `.pub` with EC2 Instance Connect before each connection. */
	pushKey?: "ec2-instance-connect";
}

export interface TargetIncus {
	/** Prefix both incus invocations with `sudo -n`. */
	sudo?: boolean;
	/** Outer container that runs incus itself (foldai: "foldai-sandbox"); omitted = the cell is a direct instance. */
	sandbox?: string;
	cell: string;
	uid?: number;
	gid?: number;
}

export interface TargetDocker {
	container: string;
	user?: string;
	/** Prefix with `sudo -n`. */
	sudo?: boolean;
}

export type TargetKind = "ssh" | "incus-cell" | "docker";
export const TARGET_KINDS: readonly TargetKind[] = ["ssh", "incus-cell", "docker"];

export interface Target {
	/** Unique id: [A-Za-z0-9._-]+ and not all dots; used in paths and the `--target` flag. */
	name: string;
	label?: string;
	/**
	 * The ENVIRONMENT: "ssh" = the plain host, "incus-cell" = the `incus` block, "docker" = the `docker` block.
	 * Transport is derived independently: an `ssh` block → ssh; else `via` → nested in that target; else this machine.
	 */
	kind: TargetKind;
	ssh?: TargetSsh;
	proxy?: TargetProxy;
	incus?: TargetIncus;
	docker?: TargetDocker;
	/** Name of another target whose whole chain carries this one (e.g. a container on an ssh host). Ignored when this entry has its own ssh block. */
	via?: string;
	/** Default remote working directory (absolute). */
	cwd?: string;
	env?: Record<string, string>;
}

export interface TargetsFile {
	version: 1;
	targets: Target[];
}

export const DEFAULT_SSH_OPTIONS: readonly string[] = [
	"ControlMaster=auto",
	"ControlPath=~/.ssh/cm-%C",
	"ControlPersist=10m",
	"ConnectTimeout=10", "ServerAliveInterval=15", "ServerAliveCountMax=2"];

// ---------------------------------------------------------------------------
// quoting

/** Always-quoted POSIX shell word. Rejects NUL (cannot travel in argv). */
export function shQuote(value: string): string {
	if (value.includes("\0")) throw new Error("NUL byte in shell value");
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

const SAFE_WORD = /^[A-Za-z0-9_\/.,:=@%+-]+$/;

/** Join argv into one shell command line that a POSIX shell parses back into the same argv. */
export function shJoin(argv: readonly string[]): string {
	return argv.map((w) => (SAFE_WORD.test(w) ? w : shQuote(w))).join(" ");
}

/** A path for a far `sh` script: `~` and `~/rest` expand to $HOME, everything else is quoted data. */
export function shPath(path: string): string {
	if (path === "" || path === "~") return `"$HOME"`;
	if (path.startsWith("~/")) return `"$HOME"/${shQuote(path.slice(2))}`;
	return shQuote(path);
}

// ---------------------------------------------------------------------------
// validation

// Names become a path segment (placeholderRoot), so "." / ".." (any all-dots name) are refused.
const NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Hosts/users/containers become argv words of ssh/docker/incus; a leading "-" would read as an option.
const WORD_RE = /^[A-Za-z0-9_.@:%+\[\]][A-Za-z0-9_.@:%+\[\]\/-]*$/;

/** Problems with one entry ([] = usable). Transport completeness is checked, not reachability. */
export function validateTarget(t: unknown): string[] {
	const errs: string[] = [];
	if (!t || typeof t !== "object") return ["entry is not an object"];
	const x = t as Partial<Target>;
	if (typeof x.name !== "string" || !NAME_RE.test(x.name)) errs.push("name must match [A-Za-z0-9._-]+");
	if (!TARGET_KINDS.includes(x.kind as TargetKind)) errs.push('kind must be "ssh", "incus-cell" or "docker"');
	if (x.label !== undefined && typeof x.label !== "string") errs.push("label must be a string");
	if (x.via !== undefined && (typeof x.via !== "string" || !NAME_RE.test(x.via))) errs.push("via must be a target name");
	if (x.kind === "ssh" && !x.ssh && !x.via) errs.push("kind ssh needs an ssh block (or via)");
	if (x.kind === "incus-cell" && !x.incus) errs.push("kind incus-cell needs an incus block");
	if (x.kind === "docker" && !x.docker) errs.push("kind docker needs a docker block");
	if (x.ssh !== undefined) {
		if (!x.ssh || typeof x.ssh !== "object") errs.push("ssh must be an object");
		else {
			if (typeof x.ssh.host !== "string" || !WORD_RE.test(x.ssh.host)) errs.push("ssh.host is missing or malformed");
			if (x.ssh.user !== undefined && (typeof x.ssh.user !== "string" || !WORD_RE.test(x.ssh.user))) errs.push("ssh.user is malformed");
			if (x.ssh.port !== undefined && !(Number.isInteger(x.ssh.port) && x.ssh.port > 0 && x.ssh.port < 65536)) errs.push("ssh.port must be 1-65535");
			if (x.ssh.key !== undefined && typeof x.ssh.key !== "string") errs.push("ssh.key must be a path");
			if (x.ssh.options !== undefined && !(Array.isArray(x.ssh.options) && x.ssh.options.every((o) => typeof o === "string" && /^[A-Za-z]+[= ]/.test(o))))
				errs.push('ssh.options must be ["Key=value", …]');
		}
	}
	if (x.proxy !== undefined) {
		if (x.proxy.type !== "aws-ssm") errs.push('proxy.type must be "aws-ssm"');
		if (x.proxy.pushKey !== undefined && x.proxy.pushKey !== "ec2-instance-connect") errs.push('proxy.pushKey must be "ec2-instance-connect"');
		if (x.proxy.pushKey && !x.ssh?.key) errs.push("proxy.pushKey needs ssh.key (its .pub is pushed)");
	}
	if (x.incus !== undefined) {
		if (typeof x.incus.cell !== "string" || !WORD_RE.test(x.incus.cell)) errs.push("incus.cell is missing or malformed");
		if (x.incus.sandbox !== undefined && (typeof x.incus.sandbox !== "string" || !WORD_RE.test(x.incus.sandbox))) errs.push("incus.sandbox is malformed");
		for (const k of ["uid", "gid"] as const) if (x.incus[k] !== undefined && !(Number.isInteger(x.incus[k]) && x.incus[k]! >= 0)) errs.push(`incus.${k} must be a non-negative integer`);
	}
	if (x.docker !== undefined) {
		if (typeof x.docker.container !== "string" || !WORD_RE.test(x.docker.container)) errs.push("docker.container is missing or malformed");
		if (x.docker.user !== undefined && (typeof x.docker.user !== "string" || !WORD_RE.test(x.docker.user))) errs.push("docker.user is malformed");
	}
	if (x.cwd !== undefined && (typeof x.cwd !== "string" || !(x.cwd.startsWith("/") || x.cwd === "~" || x.cwd.startsWith("~/")))) errs.push("cwd must be absolute (or ~/…)");
	if (x.env !== undefined) {
		if (!x.env || typeof x.env !== "object") errs.push("env must be an object");
		else for (const [k, v] of Object.entries(x.env)) if (!ENV_KEY_RE.test(k) || typeof v !== "string") errs.push(`env.${k} is not NAME=string`);
	}
	return errs;
}

/** Parse targets.json text. Throws on bad JSON/shape; invalid entries are returned in `invalid`, not thrown. */
export function parseTargetsFile(text: string): { targets: Target[]; invalid: { name: string; errors: string[] }[] } {
	const data = JSON.parse(text) as Partial<TargetsFile>;
	if (!data || typeof data !== "object" || data.version !== 1 || !Array.isArray(data.targets)) throw new Error("targets.json must be {version:1, targets:[…]}");
	const targets: Target[] = [];
	const invalid: { name: string; errors: string[] }[] = [];
	const seen = new Set<string>();
	for (const t of data.targets) {
		const errors = validateTarget(t);
		const name = String((t as { name?: unknown })?.name ?? "?");
		if (!errors.length && seen.has(name)) errors.push("duplicate name");
		if (errors.length) invalid.push({ name, errors });
		else {
			targets.push(t as Target);
			seen.add(name);
		}
	}
	return { targets, invalid };
}

/** Where targets.json lives, given the agent dir ($PI_CODING_AGENT_DIR or ~/.pi/agent). */
export function targetsFilePath(agentDir: string): string {
	return join(agentDir, "targets.json");
}

// ---------------------------------------------------------------------------
// argv

export interface BuildOptions {
	/** Shell code run by `sh -c` on the far side. */
	command: string;
	/** Far working directory; default target.cwd; none = the far login directory. */
	cwd?: string;
	/** Other targets, to resolve `via`. */
	registry?: readonly Target[];
}

function expandHome(p: string): string {
	return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** Escape ssh's %-tokens in a value spliced into ProxyCommand. */
const pct = (s: string) => s.replace(/%/g, "%%");

/** The ProxyCommand for an aws-ssm proxy (ssh expands %h %r %p). */
export function awsSsmProxyCommand(proxy: TargetProxy, key?: string): string {
	const aws = (sub: string[]) => {
		const w = ["aws", ...sub];
		if (proxy.profile) w.push("--profile", proxy.profile);
		if (proxy.region) w.push("--region", proxy.region);
		return w;
	};
	const ssm = shJoin(aws(["ssm", "start-session", "--document-name", "AWS-StartSSHSession"])) + ` --target "$1" --parameters "portNumber=$3"`;
	let script = `exec ${ssm}`;
	const args = ["%h", "%r", "%p"];
	if (proxy.pushKey === "ec2-instance-connect" && key) {
		const push = shJoin(aws(["ec2-instance-connect", "send-ssh-public-key"])) + ` --instance-id "$1" --instance-os-user "$2" --ssh-public-key "file://$4" >/dev/null`;
		script = `${push} && ${script}`;
		args.push(pct(shQuote(`${expandHome(key)}.pub`)));
	}
	return `sh -c ${pct(shQuote(script))} sh ${args.join(" ")}`;
}

/** ssh argv up to and including the destination (the far command string is appended by the caller). */
export function sshPrefix(t: Target): string[] {
	const s = t.ssh;
	if (!s) throw new Error(`target ${t.name}: no ssh block`);
	const argv = ["ssh", "-T", "-o", "BatchMode=yes"];
	for (const o of s.options ?? []) if (!/^ProxyCommand[= ]/i.test(o) || !t.proxy) argv.push("-o", o);
	if (t.proxy) argv.push("-o", `ProxyCommand=${awsSsmProxyCommand(t.proxy, s.key)}`);
	for (const o of DEFAULT_SSH_OPTIONS) argv.push("-o", o);
	if (s.port) argv.push("-p", String(s.port));
	if (s.key) argv.push("-i", expandHome(s.key));
	argv.push("--", s.user ? `${s.user}@${s.host}` : s.host);
	return argv;
}

/** The environment layer (docker / incus / none) ending in `sh -c <script>`, as argv for the far side. */
function environmentArgv(t: Target, script: string, cwd: string | undefined): string[] {
	const inner: string[] = [];
	const env = Object.entries(t.env ?? {});
	if (env.length) inner.push("env", ...env.map(([k, v]) => `${k}=${v}`));
	inner.push("sh", "-c", script);
	if (t.kind === "incus-cell" && t.incus) {
		const i = t.incus;
		const sudo = i.sudo ? ["sudo", "-n"] : [];
		const cell = ["incus", "exec", i.cell];
		if (i.uid !== undefined) cell.push("--user", String(i.uid));
		if (i.gid !== undefined) cell.push("--group", String(i.gid));
		if (cwd && cwd.startsWith("/")) cell.push("--cwd", cwd);
		cell.push("--", ...inner);
		return i.sandbox ? [...sudo, "incus", "exec", i.sandbox, "--", ...cell] : [...sudo, ...cell];
	}
	if (t.kind === "docker" && t.docker) {
		const d = t.docker;
		const argv = [...(d.sudo ? ["sudo", "-n"] : []), "docker", "exec", "-i"];
		if (d.user) argv.push("-u", d.user);
		argv.push(d.container, ...inner);
		return argv;
	}
	return inner;
}

/**
 * Spawn argv running `command` on the target: transport (local · ssh · ssh+aws-ssm · via another
 * target) × environment (none · docker exec · incus exec). stdin is passed through every layer.
 */
export function buildTargetArgv(target: Target, opts: BuildOptions, _seen: Set<string> = new Set()): string[] {
	const cwd = opts.cwd ?? target.cwd;
	const script = cwd ? `cd -- ${shPath(cwd)} || exit 1\n${opts.command}` : opts.command;
	const far = environmentArgv(target, script, cwd);
	if (target.ssh) return [...sshPrefix(target), shJoin(far)];
	if (target.via) {
		if (_seen.has(target.name)) throw new Error(`target ${target.name}: via cycle`);
		_seen.add(target.name);
		const outer = opts.registry?.find((t) => t.name === target.via);
		if (!outer) throw new Error(`target ${target.name}: via target "${target.via}" not found`);
		return buildTargetArgv(outer, { command: shJoin(far), cwd: "", registry: opts.registry }, _seen);
	}
	if (target.kind === "ssh") throw new Error(`target ${target.name}: kind ssh without an ssh block or via`);
	return far;
}

/**
 * Wrap far shell code so it dies with its channel: it runs in its own session (setsid, when the far
 * side has it) with stdin from /dev/null, and a watchdog kills its process group when OUR stdin hits
 * EOF, which happens when the local ssh/docker/incus client is killed (abort, timeout). Without a tty
 * nothing else would signal it. The caller must hold stdin open (`holdStdin`).
 */
export function hangupGuard(command: string): string {
	const q = shQuote(command);
	return [
		// A background job's stdin is /dev/null in sh; keep the channel's stdin on fd 3 for the watchdog.
		`exec 3<&0`,
		`if command -v setsid >/dev/null 2>&1; then setsid sh -c ${q} </dev/null 3<&- & else sh -c ${q} </dev/null 3<&- & fi`,
		`p=$!`,
		`{ cat <&3 >/dev/null; kill -TERM -$p 2>/dev/null || kill -TERM $p 2>/dev/null; } >/dev/null 2>&1 &`,
		`w=$!`,
		`wait $p; rc=$?`,
		`kill $w 2>/dev/null`,
		`exit $rc`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// folder browser

export const LIST_DIRS_MARKER = "@@pi-target-dirs@@";

/**
 * Argv listing the subdirectories of `path` on the target (`~`/empty = far $HOME). `path` is
 * user-supplied and travels as data only. Output: see `parseListDirsOutput`.
 */
export function buildListDirsArgv(target: Target, path: string, registry?: readonly Target[]): string[] {
	const command =
		`cd -- ${shPath(path)} || exit 3; printf '%s\\n' ${shQuote(LIST_DIRS_MARKER)}; pwd -P; ` +
		`for d in * .[!.]* ..?*; do [ -d "$d" ] && printf '%s\\n' "$d"; done; exit 0`;
	return buildTargetArgv(target, { command, cwd: "", registry });
}

/** `{path, dirs}` from buildListDirsArgv's stdout (noise before the marker, e.g. a chatty rc file, is ignored). */
export function parseListDirsOutput(stdout: string): { path: string; dirs: string[] } | null {
	const lines = stdout.split("\n");
	const at = lines.lastIndexOf(LIST_DIRS_MARKER);
	if (at < 0 || lines[at + 1] === undefined) return null;
	const dirs = lines.slice(at + 2).filter((l) => l !== "");
	return { path: lines[at + 1]!, dirs };
}

// ---------------------------------------------------------------------------
// local placeholder cwd

/** Local directory standing in for a remote cwd: <agentDir>/sova/targets/<name>/<remote/abs/path>.
 *  Renamed with the product (the pi-web state root moved to sova/); sessions stored before the
 *  rename carry the legacy root in their headers, so parsers accept BOTH spellings —
 *  legacyPlaceholderRoot exists for exactly those reads (never for new writes). */
export function placeholderRoot(agentDir: string, name: string): string {
	return join(agentDir, "sova", "targets", name);
}

/** The pre-rebrand placeholder root: read-side only (old session headers, old worker spawn cwds). */
export function legacyPlaceholderRoot(agentDir: string, name: string): string {
	return join(agentDir, "pi-web", "targets", name);
}

export function placeholderDir(agentDir: string, name: string, remotePath: string): string {
	// Normalize as an absolute path first so "/../../x" can't climb out of the target's root.
	return join(placeholderRoot(agentDir, name), posix.normalize(`/${remotePath}`));
}

/** Map a local path under the placeholder root back to the remote absolute path; other paths pass through. */
export function toRemotePath(localPath: string, root: string): string {
	if (localPath === root) return "/";
	if (localPath.startsWith(root + "/")) return localPath.slice(root.length);
	return localPath;
}
