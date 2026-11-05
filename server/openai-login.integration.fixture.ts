// Test-only: a stand-in for OpenAI's sign-in, loaded into a throwaway Sova server as a Bun preload
// (BUN_OPTIONS="--preload <this file>"), so pi's own openai-codex login runs end to end with no
// network. It answers only auth.openai.com's device-code, token and chatgpt.com's usage endpoints;
// every other request goes to the real fetch untouched.
//
// FAKE_OPENAI_LOGIN: "code" (default) offers the device code; "refuse" answers the code request 404,
// as OpenAI does for an account without device codes, so Sova falls back to the browser route.
// FAKE_OPENAI_APPROVE: a file; the device code is approved once it exists (until then: pending).
// The browser route's token exchange accepts the code "fake-good-code" only.
// Tokens are short fakes built at runtime: a JWT-shaped access token carrying the profile email and
// the ChatGPT account id, so pi stores it and Sova reads the email from it.
import { existsSync } from "node:fs";

export const FAKE_EMAIL = "fake-user@example.invalid";
export const FAKE_ACCOUNT_ID = "fake-acct-01";
export const FAKE_REFRESH = "fake-rt-01";
export const FAKE_USER_CODE = "FAKE-1234";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
/** A JWT-shaped fake access token (no real signature). */
export function fakeAccessToken(email = FAKE_EMAIL, accountId = FAKE_ACCOUNT_ID): string {
  return [b64({ alg: "none" }), b64({ "https://api.openai.com/profile": { email }, "https://api.openai.com/auth": { chatgpt_account_id: accountId } }), "fake-sig"].join(".");
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fake(url: URL, init: RequestInit | undefined): Response | null {
  const mode = process.env.FAKE_OPENAI_LOGIN ?? "code";
  if (url.host === "auth.openai.com") {
    if (url.pathname === "/api/accounts/deviceauth/usercode") {
      if (mode === "refuse") return json(404, { error: "not_found" });
      return json(200, { device_auth_id: "fake-dev-01", user_code: FAKE_USER_CODE, interval: 1 });
    }
    if (url.pathname === "/api/accounts/deviceauth/token") {
      const approve = process.env.FAKE_OPENAI_APPROVE;
      if (!approve || !existsSync(approve)) return json(403, { error: { code: "deviceauth_authorization_pending" } });
      return json(200, { authorization_code: "fake-dev-code", code_verifier: "fake-verifier" });
    }
    if (url.pathname === "/oauth/token") {
      const body = new URLSearchParams(typeof init?.body === "string" ? init.body : String(init?.body ?? ""));
      const code = body.get("code");
      if (body.get("grant_type") !== "authorization_code" || (code !== "fake-good-code" && code !== "fake-dev-code")) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: fakeAccessToken(), refresh_token: FAKE_REFRESH, expires_in: 864_000 });
    }
    return json(404, { error: "not_found" });
  }
  if (url.host === "chatgpt.com" && url.pathname === "/backend-api/wham/usage") {
    return json(200, { plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_after_seconds: 3600 } } });
  }
  return null;
}

if (process.env.FAKE_OPENAI_LOGIN !== undefined) {
  const real = globalThis.fetch;
  const patched = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      // not absolute: the real fetch says so
    }
    if (init?.signal?.aborted) throw new Error("aborted");
    const answer = url ? fake(url, init) : null;
    return answer ?? real(input, init);
  }) as typeof fetch;
  globalThis.fetch = Object.assign(patched, real);
}
