#!/usr/bin/env node
// Mock OAuth token server for the mesh lab: SINGLE-USE refresh tokens, like OpenAI Codex and
// Anthropic. Every refresh consumes the presented refresh token and issues a new pair; presenting a
// consumed (or revoked) token answers `invalid_grant`. Every refresh is logged with the caller's
// address, so a scenario can assert "exactly one refresh happened, the other got invalid_grant".
//
// Node builtins only (it runs in a bare container). No real credential ever reaches it: the lab's
// logins are minted here (`POST /mock/login`).
//
// Token endpoints (the shapes pi-ai and Claude Code parse):
//   POST /oauth/token       form or JSON, grant_type=refresh_token  (OpenAI Codex, auth.openai.com)
//   POST /v1/oauth/token    JSON, grant_type=refresh_token          (Anthropic, platform.claude.com)
//     -> 200 { access_token, refresh_token, expires_in, refresh_token_expires_in, token_type, scope }
//     -> 400 { error: "invalid_grant" }   consumed, revoked or unknown refresh token
//   POST /v1/oauth/revoke, /oauth/revoke  { token }  revokes the token's whole lineage
// Harness endpoints:
//   POST /mock/login  { shape?: "pi"|"claude", account?, accessTtlS? }  -> { lineage, credential }
//        a fresh lineage; `credential` is a ready pi auth.json oauth entry or a Claude
//        `claudeAiOauth` object
//   GET  /mock/events     every refresh/revoke: { at, ip, lineage, gen, outcome }
//   GET  /mock/lineages   per lineage: { gen, account, revoked, refreshes, invalidGrants,
//                         refreshSha256, accessSha256 } (hashes of the CURRENT tokens, for the
//                         convergence check "every host holds the latest lineage")
//   POST /mock/reset      forget everything
//   GET  /healthz
//
// Run: PORT=8080 ACCESS_TTL_S=90 [MOCK_HOST=0.0.0.0] [TLS_CERT=… TLS_KEY=… HTTP_PORT=8080] node server.mjs
// (MOCK_HOST, not HOST: the lab image sets HOST=127.0.0.1 for Sova itself.)
// With TLS it answers https on PORT (default 443: pi's fixed token URLs, name-redirected to this
// container) AND plain http on HTTP_PORT (default 8080) for the harness, over one shared state.
// The access token is a JWT (standard base64, as pi decodes it with atob) carrying the claim
// "https://api.openai.com/auth".chatgpt_account_id, so pi's Codex refresh accepts it.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { fileURLToPath } from "node:url";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

/**
 * @param {{ accessTtlS?: number, refreshTtlS?: number, now?: () => number }} [opts]
 */
export function createMockTokenState(opts = {}) {
  const accessTtlS = opts.accessTtlS ?? 90;
  const refreshTtlS = opts.refreshTtlS ?? 30 * 86400;
  const now = opts.now ?? Date.now;
  /** @type {Map<string, {id: string, account: string, gen: number, revoked: boolean, access: string, refresh: string, accessTtlS: number, refreshes: number, invalidGrants: number}>} */
  const lineages = new Map();
  /** refresh token -> { lineage, gen } for every token ever issued */
  const issued = new Map();
  /** @type {{at: number, ip: string, lineage: string | null, gen: number | null, outcome: string}[]} */
  const events = [];
  let seq = 0;

  function mint(l) {
    const nonce = randomBytes(6).toString("hex");
    const payload = {
      "https://api.openai.com/auth": { chatgpt_account_id: l.account },
      lineage: l.id,
      gen: l.gen,
      exp: Math.floor(now() / 1000) + l.accessTtlS,
    };
    l.access = `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.mock${nonce}`;
    l.refresh = `mock-rt-${l.id}-${l.gen}-${nonce}`;
    issued.set(l.refresh, { lineage: l.id, gen: l.gen });
  }

  function tokenResponse(l) {
    return {
      access_token: l.access,
      refresh_token: l.refresh,
      expires_in: l.accessTtlS,
      refresh_token_expires_in: refreshTtlS,
      token_type: "Bearer",
      scope: "user:inference user:profile",
      id_token: l.access,
    };
  }

  return {
    lineages,
    events,
    login({ shape = "pi", account, accessTtlS: ttl } = {}) {
      const id = `L${++seq}`;
      const l = { id, account: account ?? `acct-${id}`, gen: 0, revoked: false, access: "", refresh: "", accessTtlS: ttl ?? accessTtlS, refreshes: 0, invalidGrants: 0 };
      mint(l);
      lineages.set(id, l);
      const expires = now() + l.accessTtlS * 1000;
      const credential =
        shape === "claude"
          ? {
              accessToken: l.access,
              refreshToken: l.refresh,
              expiresAt: expires,
              refreshTokenExpiresAt: now() + refreshTtlS * 1000,
              scopes: ["user:inference", "user:profile"],
              subscriptionType: "max",
              rateLimitTier: "default_claude_max_20x",
            }
          : { type: "oauth", access: l.access, refresh: l.refresh, expires, accountId: l.account };
      return { lineage: id, credential };
    },
    /** @returns {{ status: number, body: object }} */
    refresh(refreshToken, ip = "?") {
      const hit = typeof refreshToken === "string" ? issued.get(refreshToken) : undefined;
      const l = hit && lineages.get(hit.lineage);
      if (!hit || !l) {
        events.push({ at: now(), ip, lineage: null, gen: null, outcome: "invalid_grant" });
        return { status: 400, body: { error: "invalid_grant", error_description: "unknown refresh token" } };
      }
      if (l.revoked || hit.gen !== l.gen) {
        l.invalidGrants++;
        events.push({ at: now(), ip, lineage: l.id, gen: hit.gen, outcome: l.revoked ? "revoked" : "invalid_grant" });
        return { status: 400, body: { error: "invalid_grant", error_description: l.revoked ? "revoked" : "refresh token already used" } };
      }
      l.gen++;
      l.refreshes++;
      mint(l);
      events.push({ at: now(), ip, lineage: l.id, gen: hit.gen, outcome: "ok" });
      return { status: 200, body: tokenResponse(l) };
    },
    revoke(token, ip = "?") {
      const hit = typeof token === "string" ? issued.get(token) : undefined;
      const l = hit && lineages.get(hit.lineage);
      if (l) l.revoked = true;
      events.push({ at: now(), ip, lineage: l?.id ?? null, gen: hit?.gen ?? null, outcome: "revoke" });
      return { status: 200, body: {} };
    },
    summary() {
      return Object.fromEntries(
        [...lineages.values()].map((l) => [
          l.id,
          {
            gen: l.gen,
            account: l.account,
            revoked: l.revoked,
            refreshes: l.refreshes,
            invalidGrants: l.invalidGrants,
            refreshSha256: sha256(l.refresh),
            accessSha256: sha256(l.access),
          },
        ]),
      );
    },
    reset() {
      lineages.clear();
      issued.clear();
      events.length = 0;
      seq = 0;
    },
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const type = String(req.headers["content-type"] ?? "");
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

/** The request handler over one state; exported so tests can mount it on an ephemeral port. */
export function createHandler(state) {
  return async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const ip = req.socket.remoteAddress ?? "?";
    const url = new URL(req.url ?? "/", "http://mock");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(200, { ok: true });
      if (req.method === "GET" && url.pathname === "/mock/events") return send(200, state.events);
      if (req.method === "GET" && url.pathname === "/mock/lineages") return send(200, state.summary());
      if (req.method !== "POST") return send(404, { error: "not found" });
      const body = await readBody(req);
      switch (url.pathname) {
        case "/oauth/token":
        case "/v1/oauth/token": {
          if (body.grant_type !== "refresh_token") return send(400, { error: "unsupported_grant_type" });
          const r = state.refresh(body.refresh_token, ip);
          return send(r.status, r.body);
        }
        case "/oauth/revoke":
        case "/v1/oauth/revoke": {
          const r = state.revoke(body.token ?? body.refresh_token, ip);
          return send(r.status, r.body);
        }
        case "/mock/login":
          return send(200, state.login(body));
        case "/mock/reset":
          state.reset();
          return send(200, { ok: true });
        default:
          return send(404, { error: "not found" });
      }
    } catch (error) {
      return send(500, { error: String(error?.message ?? error) });
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const state = createMockTokenState({ accessTtlS: Number(process.env.ACCESS_TTL_S ?? 90) });
  const handler = createHandler(state);
  const tls = process.env.TLS_CERT && process.env.TLS_KEY;
  const host = process.env.MOCK_HOST ?? "0.0.0.0";
  const servers = [];
  const listen = (server, port, scheme) => {
    server.listen(port, host, () => console.log(`mock-token-server listening on ${scheme}://${host}:${port}`));
    servers.push(server);
  };
  if (tls) {
    listen(createHttpsServer({ cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }, handler), Number(process.env.PORT ?? 443), "https");
    listen(createHttpServer(handler), Number(process.env.HTTP_PORT ?? 8080), "http");
  } else {
    listen(createHttpServer(handler), Number(process.env.PORT ?? 8080), "http");
  }
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const s of servers) s.close(); process.exit(0); });
}
