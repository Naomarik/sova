import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { localRequest } from "../../mesh/proxy";
import { yourClickRefusal } from "../../page-only";
import { readPublicLinks } from "../../public-links";
import { readCandidate } from "../candidate";
import { envFileText } from "../../project-services/drivers";
import { stateRoot } from "../../state-root";
import { configureTunnels, stopTunnel } from "./manager";

/**
 * Cloudflare Account's connector token (§mesh.tunnel/account): the token the Cloudflare dashboard shows for a
 * tunnel the user made there, pasted in Settings → Public links. Sova runs that tunnel from it.
 *
 * The token is a credential that runs the tunnel from anywhere. It lives only here, in
 * `<stateRoot>/tunnels/account-token.env` (dir 0700, file 0600, one `TUNNEL_TOKEN=` line; a new one pasted while
 * Account runs or a setup waits for Verify sits in `account-token.candidate.env` until Verify promotes it), and reaches
 * cloudflared only through the unit's own 0600 environment file (the tunnel manager's `account` dep). It is
 * never in public-links.json, a command line, a chat's context, a setup chat's brief, an answer or a log line.
 */

const VAR = "TUNNEL_TOKEN";
/** The longest paste taken: a dashboard token is about 180 characters; a whole install command a little more. */
const MAX_PASTE = 4096;

export const tokenFile = (): string => join(stateRoot(), "tunnels", "account-token.env");
/** A token pasted while a working Account tunnel runs, or while a new setup waits for its Verify: kept apart, so
    today's tunnel keeps its token until Verify promotes the new one (§mesh.public/where-links-open). */
export const candidateTokenFile = (): string => join(stateRoot(), "tunnels", "account-token.candidate.env");

/** The refusal of a paste that isn't the dashboard token's shape (§design.copy-deck/where-links-open). */
export const NOT_A_TOKEN = "That isn't a Cloudflare tunnel token.";

/** One word that could be a token: base64 or base64url, padding allowed. */
const TOKEN_WORD = /^[A-Za-z0-9+/_-]{40,}={0,2}$/;

/**
 * The token in what was pasted, or the refusal. Takes the bare token or the dashboard's whole install line
 * (`cloudflared service install <token>`, `cloudflared tunnel run --token <token>`), whose last word is the
 * token. The dashboard token is base64 JSON naming the account (`a`), the tunnel (`t`) and its secret (`s`).
 * The answer never repeats the paste.
 */
export function validAccountToken(raw: unknown): { ok: true; token: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.length > MAX_PASTE) return { ok: false, error: NOT_A_TOKEN };
  const words = raw.trim().split(/\s+/);
  const token = words[words.length - 1] ?? "";
  if (!TOKEN_WORD.test(token)) return { ok: false, error: NOT_A_TOKEN };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return { ok: false, error: NOT_A_TOKEN };
  }
  const p = parsed as Record<string, unknown> | null;
  const field = (k: string) => typeof p?.[k] === "string" && (p[k] as string).length > 0;
  if (!p || typeof p !== "object" || Array.isArray(p) || !field("a") || !field("t") || !field("s")) return { ok: false, error: NOT_A_TOKEN };
  return { ok: true, token };
}

/** The saved token, or null when none is saved or the file holds no token. Never logged. */
export const readAccountToken = (): string | null => tokenIn(tokenFile());

/** The token a candidate Account setup runs from: one pasted for it, else the saved one. */
export const readCandidateToken = (): string | null => tokenIn(candidateTokenFile()) ?? readAccountToken();

function tokenIn(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const m = new RegExp(`^${VAR}='([^'\\n]*)'$`, "m").exec(text);
  const v = validAccountToken(m?.[1] ?? "");
  return v.ok ? v.token : null;
}

/** A token is saved, or one waits as a candidate's. */
export const hasAccountToken = (): boolean => readAccountToken() !== null || tokenIn(candidateTokenFile()) !== null;

/** A token was pasted that waits for a Verify (today's tunnel still runs on the saved one). */
export const hasCandidateToken = (): boolean => tokenIn(candidateTokenFile()) !== null;

/** Saves a token `validAccountToken` passed: 0600 from its first byte, then renamed over the old one. */
export function writeAccountToken(token: string, file = tokenFile()): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, envFileText({ [VAR]: token }), { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
}

export function deleteAccountToken(): void {
  rmSync(tokenFile(), { force: true });
  dropCandidateToken();
}

/** The candidate's token becomes the saved one (at the Verify that promotes the candidate); no-op when none waits. */
export function promoteCandidateToken(): void {
  if (tokenIn(candidateTokenFile()) === null) return dropCandidateToken();
  renameSync(candidateTokenFile(), tokenFile());
}

/** The candidate's token is dropped (Cancel, or a route chosen outright). */
export function dropCandidateToken(): void {
  rmSync(candidateTokenFile(), { force: true });
}

/**
 * The tunnel manager's `account` dep: what an Account tunnel runs from, or null when the route isn't Account,
 * it has no address, or no token is saved (the manager then starts nothing and reports `no-token`).
 */
export function accountTunnel(): { token: string; publicUrl: string } | null {
  const file = readPublicLinks();
  if (file.route !== "account" || !file.account?.publicUrl) return null;
  const token = readAccountToken();
  return token ? { token, publicUrl: file.account.publicUrl } : null;
}

/** What the routes do to a running Account tunnel when its token is removed (the tunnel manager; tests pass their
    own). A new token never restarts it: it waits as the candidate's until Verify (share-wiring's promotion). */
export interface AccountTunnelControl {
  stop(why: string): Promise<unknown>;
}

const notFound = (c: Context) => c.json({ error: "Not found" }, 404);
const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) });
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PUT and DELETE /api/public-links/account-token (§mesh.tunnel/account). Main listener only (a peer's or a
 * relayed request gets the plain 404, as the rest of /api/public-links), and only the person's own click in the
 * page (§app.access/your-click). The answer says only whether a token is saved.
 */
const SHARE = { kind: "share" } as const;
const MANAGER: AccountTunnelControl = { stop: (why) => stopTunnel(SHARE, why) };

/** Also hands the tunnel manager its `account` dep, once, as the routes mount at server start. */
export function mountAccountRoutes(app: Hono, control: () => Promise<AccountTunnelControl> = async () => MANAGER): void {
  configureTunnels({ account: accountTunnel });
  app.put("/api/public-links/account-token", small, async (c) => {
    if (!localRequest(c)) return notFound(c);
    const refused = yourClickRefusal(c, "accountToken");
    if (refused) return refused;
    const body = (await c.req.json().catch(() => undefined)) as { token?: unknown } | undefined;
    const v = validAccountToken(body?.token);
    if (!v.ok) return c.json({ error: v.error }, 400, NO_STORE);
    // A working Account tunnel, or a setup waiting for its Verify: the new token waits beside the saved one and
    // nothing restarts; Verify promotes it. Otherwise nothing runs on a token yet, and it is simply saved.
    if (readPublicLinks().route === "account" || readCandidate() !== null) writeAccountToken(v.token, candidateTokenFile());
    else writeAccountToken(v.token);
    return c.json({ hasToken: true }, 200, NO_STORE);
  });

  app.delete("/api/public-links/account-token", async (c) => {
    if (!localRequest(c)) return notFound(c);
    const refused = yourClickRefusal(c, "accountToken");
    if (refused) return refused;
    const had = existsSync(tokenFile());
    deleteAccountToken();
    if (had && readPublicLinks().route === "account") await (await control()).stop("token removed").catch((err) => console.warn(`[tunnel] account tunnel stop failed: ${err instanceof Error ? err.message : String(err)}`));
    return c.json({ hasToken: false }, 200, NO_STORE);
  });
}
