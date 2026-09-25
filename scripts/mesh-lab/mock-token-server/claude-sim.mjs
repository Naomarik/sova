#!/usr/bin/env node
// Claude Code credential-store SIMULATOR for the mesh lab and the sync unit tests. The real
// `claude` binary is not downloadable without a real account, and real Claude logins never enter
// the lab, so this reproduces what Claude Code 2.1.282 does to `<claudeDir>/.credentials.json`
// (observed in the binary, see credential-sync.md §2.2):
//
// - reads with O_NOFOLLOW: a symlinked store is refused;
// - refresh: skipped while the access token has > 5 min left (unless forced); takes
//   `<claudeDir>/.oauth_refresh.lock` then the legacy `<realpath claudeDir>.lock` (proper-lockfile,
//   stale 60 s, update 5 s), retrying ELOCKED 5 × 1–2 s; re-reads under the lock and returns
//   "refreshed" if the access token already changed; posts the refresh token; on `invalid_grant`
//   clears the entry to empty tokens + `expiresAt: 0` ONLY if the store still holds the token that
//   failed; on success writes only if the store still holds the posted refresh token;
// - writes IN PLACE (truncate + write, then chmod 0600), not tmp+rename;
// - logout revokes the refresh token, then deletes the file.
//
// It must only ever be pointed at a scratch or container dir, never the real ~/.claude: every
// command needs an explicit --dir, and a dir equal to the invoking user's real ~/.claude is refused.
//
// CLI: node claude-sim.mjs <login|refresh|logout|status> --dir <claudeDir> [--mock <url>] [--force]
//   login   mints a lineage at <mock>/mock/login and writes it
//   refresh posts to <mock>/v1/oauth/token
//   logout  posts to <mock>/v1/oauth/revoke, deletes the file
//   status  prints metadata only (no token values)

import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "claudeAiOauth";
const CLIENT_ID = "mock-claude-code";

function properLockfile() {
  const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return createRequire(piEntry)("proper-lockfile");
}

function guardDir(dir) {
  if (!dir) throw new Error("--dir is required");
  const real = resolve(dir);
  if (real === resolve(join(homedir(), ".claude")) || (existsSync(real) && realpathSync(real) === safeReal(join(homedir(), ".claude")))) {
    throw new Error("refusing to simulate on the real ~/.claude");
  }
  return real;
}
const safeReal = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const credPath = (dir) => join(dir, ".credentials.json");

/** @returns {{ state: "ok"|"missing"|"refused-symlink"|"invalid", data?: any }} */
export function readStore(dir) {
  let fd;
  try {
    fd = openSync(credPath(dir), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === "ELOOP") return { state: "refused-symlink" };
    if (e.code === "ENOENT") return { state: "missing" };
    throw e;
  }
  try {
    return { state: "ok", data: JSON.parse(readFileSync(fd, "utf8")) };
  } catch {
    return { state: "invalid" };
  } finally {
    closeSync(fd);
  }
}

/** In place, as Claude Code writes: truncate, write, then chmod. */
export function writeInPlace(dir, data) {
  const fd = openSync(credPath(dir), "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data));
  } finally {
    closeSync(fd);
  }
  chmodSync(credPath(dir), 0o600);
}

async function takeLocks(dir, { attempts = 5, backoffMs = () => 1000 + Math.random() * 1000 } = {}) {
  const lf = properLockfile();
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {}
  const opts = { realpath: false, stale: 60_000, update: 5_000, onCompromised: () => {} };
  for (let attempt = 1; ; attempt++) {
    let first;
    try {
      first = await lf.lock(join(dir, ".oauth_refresh"), { ...opts, lockfilePath: join(dir, ".oauth_refresh.lock") });
      const second = await lf.lock(real, { ...opts, lockfilePath: `${real}.lock` }).catch(async (e) => {
        await first();
        throw e;
      });
      return async () => {
        await second();
        await first();
      };
    } catch (e) {
      if (e.code !== "ELOCKED" || attempt >= attempts) throw e;
      await new Promise((r) => setTimeout(r, backoffMs()));
    }
  }
}

/**
 * One Claude Code refresh attempt.
 * @returns {Promise<"not_needed"|"no_refresh_token"|"refreshed"|"ok"|"invalid_grant"|"raced"|"refused-symlink"|"missing"|"invalid">}
 */
export async function refresh(dir, mockUrl, { force = false, lockAttempts, lockBackoffMs, now = Date.now } = {}) {
  dir = guardDir(dir);
  const before = readStore(dir);
  if (before.state !== "ok") return before.state;
  const entry = before.data?.[KEY];
  if (!entry?.refreshToken) return "no_refresh_token";
  if (!force && entry.expiresAt - now() > 5 * 60_000) return "not_needed";
  const seenAccess = entry.accessToken;
  const release = await takeLocks(dir, { attempts: lockAttempts, ...(lockBackoffMs ? { backoffMs: lockBackoffMs } : {}) });
  try {
    const locked = readStore(dir);
    if (locked.state !== "ok") return locked.state;
    const current = locked.data?.[KEY];
    if (!current?.refreshToken) return "no_refresh_token";
    if (current.accessToken !== seenAccess) return "refreshed"; // another process refreshed meanwhile
    const posted = current.refreshToken;
    const res = await fetch(new URL("/v1/oauth/token", mockUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: posted, client_id: CLIENT_ID }),
    });
    const body = await res.json().catch(() => ({}));
    const after = readStore(dir);
    const onDisk = after.state === "ok" ? after.data?.[KEY] : undefined;
    if (!res.ok) {
      if (body?.error === "invalid_grant" && onDisk?.refreshToken === posted) {
        writeInPlace(dir, { ...after.data, [KEY]: { ...onDisk, accessToken: "", refreshToken: "", expiresAt: 0 } });
        return "invalid_grant";
      }
      return body?.error === "invalid_grant" ? "raced" : "invalid";
    }
    if (onDisk?.refreshToken !== posted) return "raced";
    writeInPlace(dir, {
      ...after.data,
      [KEY]: {
        ...onDisk,
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: now() + body.expires_in * 1000,
        ...(body.refresh_token_expires_in ? { refreshTokenExpiresAt: now() + body.refresh_token_expires_in * 1000 } : {}),
      },
    });
    return "ok";
  } finally {
    await release();
  }
}

export async function login(dir, mockUrl, { account } = {}) {
  dir = guardDir(dir);
  const res = await fetch(new URL("/mock/login", mockUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shape: "claude", ...(account ? { account } : {}) }),
  });
  const { lineage, credential } = await res.json();
  const cur = readStore(dir);
  if (cur.state === "refused-symlink") return { lineage: null, state: cur.state };
  writeInPlace(dir, { ...(cur.state === "ok" ? cur.data : {}), [KEY]: credential });
  return { lineage, state: "ok" };
}

export async function logout(dir, mockUrl) {
  dir = guardDir(dir);
  const cur = readStore(dir);
  const token = cur.state === "ok" ? cur.data?.[KEY]?.refreshToken : undefined;
  if (token && mockUrl) {
    await fetch(new URL("/v1/oauth/revoke", mockUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, token_type_hint: "refresh_token" }),
    }).catch(() => {});
  }
  rmSync(credPath(dir), { force: true });
}

/** Metadata only: never a token. */
export function status(dir) {
  dir = guardDir(dir);
  const cur = readStore(dir);
  if (cur.state !== "ok") return { state: cur.state };
  const e = cur.data?.[KEY];
  if (!e) return { state: "no-entry" };
  return {
    state: e.accessToken && e.refreshToken && e.expiresAt > 0 ? "live" : "dead",
    expiresAt: e.expiresAt,
    refreshSha256: e.refreshToken ? createHash("sha256").update(e.refreshToken).digest("hex") : null,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const dir = arg("dir");
  const mock = arg("mock") ?? process.env.MOCK_TOKEN_URL;
  const run = async () => {
    switch (cmd) {
      case "login":
        return login(dir, mock, { account: arg("account") });
      case "refresh":
        return { outcome: await refresh(dir, mock, { force: rest.includes("--force") }) };
      case "logout":
        await logout(dir, mock);
        return { ok: true };
      case "status":
        return status(dir);
      default:
        throw new Error("usage: claude-sim.mjs <login|refresh|logout|status> --dir <claudeDir> [--mock <url>] [--force]");
    }
  };
  run().then(
    (r) => console.log(JSON.stringify(r)),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
