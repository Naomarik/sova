/**
 * The host side of the sandbox's network (plan v2 §3.3): an allowlisting HTTP CONNECT and plain
 * HTTP proxy listening on a Unix socket, one per session. The sandbox has no network of its own
 * (--unshare-net); the backend binds this socket in and relays 127.0.0.1:3128 to it, so the only
 * way out is through here. Hosts not on the allowlist get 403; allowlisted names that resolve to
 * loopback, link-local or unspecified addresses are refused too, so no allowlist entry (or DNS
 * answer) can reach Sova's own API or a cloud metadata endpoint.
 *
 * Node builtins only; runs inside the pi process, so every socket error is handled here and none
 * may throw into the host.
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** GitHub and the package registries (brief decision 5); user-editable in the policy file. */
export const DEFAULT_PROXY_ALLOW: readonly string[] = [
	"github.com", "api.github.com", "codeload.github.com", "*.githubusercontent.com",
	"registry.npmjs.org", "registry.yarnpkg.com",
	"pypi.org", "files.pythonhosted.org",
	"crates.io", "static.crates.io", "index.crates.io",
	"repo1.maven.org", "repo.maven.apache.org", "repo.clojars.org", "clojars.org",
	"proxy.golang.org", "sum.golang.org",
];

export const DEFAULT_PROXY_PORTS: readonly number[] = [80, 443];

/** The deny text; `DENIAL_SIGNATURES` in the Linux backend matches it. */
export const PROXY_DENY_TEXT = "not in the sandbox proxy allowlist";

const SUN_PATH_MAX = 107;

/**
 * A socket path short enough for sun_path (108 bytes): a per-user runtime dir, never the agent
 * dir (under a worktree that alone overflows the limit). Hidden inside the sandbox by --tmpfs /run
 * (or the private /tmp) and bound back in at one fixed path.
 */
export function proxySocketPath(sessionId: string, runtimeDir = process.env.XDG_RUNTIME_DIR): string {
	const dir = runtimeDir ? join(runtimeDir, "sova-sandbox") : join(tmpdir(), `sova-sandbox-${process.getuid?.() ?? "u"}`);
	const file = join(dir, `${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.sock`);
	if (Buffer.byteLength(file) > SUN_PATH_MAX) throw new Error(`proxy socket path is too long for a Unix socket: ${file}`);
	return file;
}

function normalizeHost(host: string): string {
	let h = host.trim().toLowerCase();
	if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
	while (h.endsWith(".")) h = h.slice(0, -1);
	return h;
}

/** Exact names, or `*.example.com` for any subdomain (not the apex). IP literals only if listed exactly. */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
	const h = normalizeHost(host);
	if (!h) return false;
	for (const raw of allow) {
		const a = normalizeHost(raw);
		if (!a) continue;
		if (a.startsWith("*.")) {
			if (!isIP(h) && h.endsWith(a.slice(1))) return true;
		} else if (a === h) return true;
	}
	return false;
}

/** Addresses no sandboxed request may reach, whatever name led there. */
export function forbiddenAddress(address: string): boolean {
	const a = address.toLowerCase();
	if (isIP(a) === 4) {
		const [o1, o2] = a.split(".").map(Number) as [number, number];
		return o1 === 127 || o1 === 0 || (o1 === 169 && o2 === 254);
	}
	if (a.startsWith("::ffff:")) return forbiddenAddress(a.slice(7));
	return a === "::1" || a === "::" || a.startsWith("fe80:");
}

export type ProxyDecision = { host: string; port: number; method: string; allowed: boolean; reason?: string };

export interface ProxyOptions {
	socket: string;
	allow: readonly string[];
	ports?: readonly number[];
	onDecision?: (d: ProxyDecision) => void;
	/** Test seam: resolve a host name. Defaults to the system resolver. */
	resolve?: (host: string) => Promise<string>;
}

export interface ProxyHandle {
	readonly socket: string;
	setAllow(allow: readonly string[]): void;
	close(): Promise<void>;
}

function parseAuthority(authority: string): { host: string; port: number } | undefined {
	const m = /^\[([^\]]+)\]:(\d+)$/.exec(authority) ?? /^([^:]+):(\d+)$/.exec(authority);
	if (!m) return undefined;
	const port = Number(m[2]);
	return port > 0 && port < 65536 ? { host: m[1]!, port } : undefined;
}

export async function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
	let allow = [...opts.allow];
	const ports = new Set(opts.ports ?? DEFAULT_PROXY_PORTS);
	const resolveHost = opts.resolve ?? (async (host: string) => (await lookup(host)).address);
	const open = new Set<Socket>();
	const track = (s: Socket) => {
		open.add(s);
		s.on("close", () => open.delete(s));
		s.on("error", () => s.destroy());
	};

	/** Allowlist, port and address checks; returns the address to connect to, or the refusal. */
	const decide = async (host: string, port: number, method: string): Promise<{ address: string } | { status: number; reason: string }> => {
		const h = normalizeHost(host);
		let verdict: { address: string } | { status: number; reason: string };
		if (!hostAllowed(h, allow)) verdict = { status: 403, reason: `sova sandbox: ${h} is ${PROXY_DENY_TEXT}` };
		else if (!ports.has(port)) verdict = { status: 403, reason: `sova sandbox: port ${port} is ${PROXY_DENY_TEXT}` };
		else {
			try {
				const address = isIP(h) ? h : await resolveHost(h);
				verdict = forbiddenAddress(address)
					? { status: 403, reason: `sova sandbox: ${h} resolves to ${address}, a local address, which is ${PROXY_DENY_TEXT}` }
					: { address };
			} catch (err) {
				verdict = { status: 502, reason: `sova sandbox proxy: cannot resolve ${h}: ${(err as Error).message}` };
			}
		}
		try {
			opts.onDecision?.({ host: h, port, method, allowed: "address" in verdict, ...("reason" in verdict ? { reason: verdict.reason } : {}) });
		} catch {}
		return verdict;
	};

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		track(req.socket);
		const refuse = (status: number, reason: string) => {
			if (res.headersSent) return void res.destroy();
			res.writeHead(status, { "content-type": "text/plain", "x-sova-sandbox": "denied", connection: "close" });
			res.end(reason + "\n");
		};
		let url: URL;
		try {
			url = new URL(req.url ?? "");
		} catch {
			return refuse(400, "sova sandbox proxy: expected an absolute http:// URL");
		}
		if (url.protocol !== "http:") return refuse(400, `sova sandbox proxy: ${url.protocol} is not proxied; use CONNECT`);
		const port = url.port ? Number(url.port) : 80;
		void decide(url.hostname, port, req.method ?? "GET").then((v) => {
			if (!("address" in v)) return refuse(v.status, v.reason);
			const headers = { ...req.headers };
			for (const k of Object.keys(headers)) if (k.startsWith("proxy-")) delete headers[k];
			const upstream = httpRequest(
				{ host: v.address, port, method: req.method, path: url.pathname + url.search, headers },
				(up) => {
					res.writeHead(up.statusCode ?? 502, up.headers);
					up.pipe(res);
					up.on("error", () => res.destroy());
				},
			);
			upstream.on("error", (err) => refuse(502, `sova sandbox proxy: upstream error: ${err.message}`));
			req.pipe(upstream);
		});
	});

	server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
		track(client);
		const target = parseAuthority(req.url ?? "");
		const refuse = (status: number, reason: string) => {
			const text = reason + "\n";
			client.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\ncontent-type: text/plain\r\nx-sova-sandbox: denied\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
		};
		if (!target) return refuse(400, "sova sandbox proxy: bad CONNECT target");
		void decide(target.host, target.port, "CONNECT").then((v) => {
			if (!("address" in v)) return refuse(v.status, v.reason);
			if (client.destroyed) return;
			const upstream = connect({ host: v.address, port: target.port });
			track(upstream);
			upstream.on("connect", () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length) upstream.write(head);
				upstream.pipe(client);
				client.pipe(upstream);
			});
			upstream.on("error", (err) => {
				if (!client.destroyed) refuse(502, `sova sandbox proxy: upstream error: ${err.message}`);
			});
			client.on("close", () => upstream.destroy());
			upstream.on("close", () => client.destroy());
		});
	});
	server.on("clientError", (_err, socket) => socket.destroy());

	mkdirSync(dirname(opts.socket), { recursive: true, mode: 0o700 });
	rmSync(opts.socket, { force: true });
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(opts.socket, () => {
			server.off("error", reject);
			resolveListen();
		});
	});
	server.on("error", () => {});
	chmodSync(opts.socket, 0o600);

	return {
		socket: opts.socket,
		setAllow(next) {
			allow = [...next];
		},
		close() {
			for (const s of open) s.destroy();
			return new Promise<void>((resolveClose) =>
				server.close(() => {
					rmSync(opts.socket, { force: true });
					resolveClose();
				}),
			);
		},
	};
}
