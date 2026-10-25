// Shared by the form sign-in integration files (runner-signin, runner-signin-inplace): a made-up site with a
// native or fetch sign-in form, the script and attempt helpers, and a PNG pixel reader. No tests here.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { normalizeTourScript, type TourScript } from "../../shared/tour";
import { runTourAttempt, type TourAttemptResult, type TourSignInAnswer, type TourSignInNeed } from "./runner";
import type { TourStorageState } from "./runner-protocol";
import type { TourRecordingContext } from "./sandbox";

export const USER = "made-up-canary-user";
export const PASS = "Made-Up-Canary-Pass-7731";
export const CODE = "482913";
/** A made-up account box value (an account code), and what the page pre-fills it with from its host. */
export const ACCOUNT = "made-up-canary-account";
export const PREFILL = "made-up-host-prefill";
export type Mode = { account?: boolean; fetchSubmit?: boolean; code?: boolean; captcha?: boolean; selfSubmit?: boolean; postOnLoad?: boolean; loadsPerSession?: number; formWhenSignedIn?: boolean };
export const BOX = "position:absolute;left:20px;width:200px;height:40px;border:0;background:#ff0000;color:#ff0000";
export const page = (body: string) => `<!doctype html><html><head><title>Made-up site</title><style>body{margin:0;font:18px sans-serif}h1{margin:0 0 12px}</style></head><body>${body}</body></html>`;

export async function site(mode: Mode = {}) {
  const hits = new Map<string, number>();
  const hit = (key: string) => hits.set(key, (hits.get(key) ?? 0) + 1);
  let session = "", pending = "", loads = 0;
  const cookie = (req: IncomingMessage, name: string) => (req.headers.cookie ?? "").split(/;\s*/).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1);
  const read = (req: IncomingMessage) => new Promise<string>(r => { let b = ""; req.on("data", c => { b += c; }); req.on("end", () => r(b)); });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hit(`${req.method} ${url.pathname}`);
    const html = (body: string) => { res.setHeader("content-type", "text/html"); res.end(page(body)); };
    const go = (to: string, set?: string) => { if (set) res.setHeader("set-cookie", set); res.statusCode = 302; res.setHeader("location", to); res.end(); };
    if (req.method === "POST" && url.pathname === "/login") {
      const body = await read(req);
      const v = mode.fetchSubmit ? JSON.parse(body || "{}") as Record<string, string> : Object.fromEntries(new URLSearchParams(body));
      if (v.account !== undefined) { hit("account-sent"); hit(`account=${v.account}`); }
      if (v.username !== USER || v.password !== PASS || (mode.account && v.account !== ACCOUNT)) { if (mode.fetchSubmit) { res.statusCode = 401; res.end(); } else html(`<p>Wrong details</p>${loginForm()}`); return; }
      if (mode.code) { pending = `p${Math.random()}`; go("/code", `pre=${pending}; Path=/; HttpOnly`); return; }
      session = `s${Math.random()}`; loads = 0;
      if (mode.fetchSubmit) { res.setHeader("set-cookie", `sid=${session}; Path=/; HttpOnly`); res.end("{}"); return; }
      go("/account", `sid=${session}; Path=/; HttpOnly`); return;
    }
    if (req.method === "POST" && url.pathname === "/code") {
      const v = Object.fromEntries(new URLSearchParams(await read(req)));
      if (cookie(req, "pre") !== pending || v.code !== CODE) { html("<p>Wrong code</p>"); return; }
      session = `s${Math.random()}`; loads = 0;
      go("/account", `sid=${session}; Path=/; HttpOnly`); return;
    }
    if (req.method !== "GET") { res.end(); return; }
    if (url.pathname === "/login") {
      // Already signed in: the sign-in page sends you on, as sites do.
      // (formWhenSignedIn: a bare sign-in page that shows its form to someone signed in, too.)
      if (session && cookie(req, "sid") === session && !mode.formWhenSignedIn) { go("/account"); return; }
      const extra = (mode.captcha ? `<div class="g-recaptcha" data-sitekey="made-up"></div>` : "")
        + (mode.selfSubmit ? `<script>addEventListener("DOMContentLoaded", () => document.getElementById("f").requestSubmit());</script>` : "")
        + (mode.postOnLoad ? `<script>addEventListener("load", () => { fetch("/login", { method: "POST", body: "username=x&password=y" }).catch(() => {}); });</script>` : "");
      html(loginForm() + extra); return;
    }
    if (url.pathname === "/code") { html(`<form method="post" action="/code"><label>Code <input name="code" autocomplete="one-time-code" inputmode="numeric"></label></form>`); return; }
    if (url.pathname === "/settings/password") {
      html(`<h1>Change password</h1><form><input type="password" aria-label="Current password" style="${BOX};top:300px" value="old"><input type="password" aria-label="New password" style="${BOX};top:400px"></form>`); return;
    }
    if (url.pathname === "/account") {
      if (!session || cookie(req, "sid") !== session) { go("/login"); return; }
      if (mode.loadsPerSession && ++loads > mode.loadsPerSession) { session = "expired"; go("/login"); return; }
      const analytics = url.searchParams.has("analytics") ? `<script>addEventListener("load", () => { fetch("/analytics", { method: "POST", body: "seen" }).catch(() => {}); navigator.sendBeacon("/analytics", "seen"); });</script>` : "";
      html(`<h1>Your account</h1><p>Made-up account page.</p><input autocomplete="username" aria-label="Account name" style="${BOX};top:300px" value="shown"><input type="password" aria-label="Saved password" style="${BOX};top:400px" value="shown">${mode.account ? `<label>Account code <input style="${BOX};top:500px" value="shown"></label>` : ""}${analytics}`); return;
    }
    res.statusCode = 404; res.end();
  });
  // The account box comes first, pre-filled from the host; submit stays disabled until all three hold a value.
  const loginForm = () => `<form id="f" method="post" action="/login">${mode.account ? `<label>Account code <input name="account" value="${PREFILL}"></label>` : ""}<label>Username <input name="username"></label><label>Password <input type="password" name="password" data-testid="password"></label><button>Sign in</button></form>`
    + (mode.account ? `<script>{ const f = document.getElementById("f"), b = f.querySelector("button"); const sync = () => { b.disabled = ![f.account, f.username, f.password].every(i => i.value); }; f.account.value = "${PREFILL}-" + location.hostname; f.addEventListener("input", sync); sync(); }</script>` : "")
    + (mode.fetchSubmit ? `<script>document.getElementById("f").addEventListener("submit", e => { e.preventDefault(); const f = e.target; fetch("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(f.account ? { account: f.account.value } : {}), username: f.username.value, password: f.password.value }) }).then(r => { if (r.ok) location.href = "/account"; }); });</script>` : "");
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, hits: (key: string) => hits.get(key) ?? 0, cookies: () => ({ pre: pending, sid: session }), close: () => { server.closeAllConnections(); server.close(); } };
}

export function script(origin: string, routes: string[], account = false): TourScript {
  const s: TourScript = {
    v: 1, title: "Made-up account", summary: "A signed-in page of a made-up site.", audience: "A reviewer", outcome: "See the account page.",
    source: { kind: "site", origin },
    signIn: { route: "/login", ...(account ? { account: { kind: "role" as const, role: "textbox", name: "Account code" } } : {}), username: { kind: "role", role: "textbox", name: "Username" }, password: { kind: "testId", testId: "password" }, submit: { kind: "role", role: "button", name: "Sign in" }, signedIn: { kind: "role", role: "heading", name: "Your account" } },
    chapters: [{ id: "account", title: "Account" }],
    steps: [{ id: "account", chapter: "account", title: "Account", summary: "The account page.", views: routes.map((route, i) => ({ id: `view-${i + 1}`, title: `View ${i + 1}`, kind: "page" as const, note: "A made-up view.", route, sizes: ["desktop", "phone"] as ("desktop" | "phone")[], actions: {}, marks: [], masks: [] })) }],
  };
  assert.ok(normalizeTourScript(s), "fixture invalid");
  return s;
}
export async function record(s: TourScript, options: { dryRun?: boolean; answer?: (need: TourSignInNeed) => TourSignInAnswer; storage?: TourStorageState } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tour-signin-"));
  const context: TourRecordingContext = { sessionId: "signin", sessionFile: join(root, "chat.jsonl"), cwd: root, agentDir: join(root, "agent"), sandbox: { on: false } };
  const asked: string[] = [];
  const stored: TourStorageState[] = [];
  const answer = options.answer ?? (need => need.fields[0] === "code" ? { code: CODE } : { ...(need.fields[0] === "account" ? { account: ACCOUNT } : {}), username: USER, password: PASS });
  try {
    const result: TourAttemptResult | Error = await runTourAttempt({ context, script: s, tourId: "signin", editionId: "signin-edition", dryRun: options.dryRun ?? true, beforeContact: async () => {},
      ...(options.storage ? { signInStorage: options.storage } : {}),
      onSignIn: async need => { asked.push(need.fields.join("+")); return answer(need); },
      onSignedIn: (_origin, state) => { stored.push(state); },
    }).catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
    return { result, asked, stored };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
export const failed = (r: TourAttemptResult | Error) => r instanceof Error ? `${r.message} ${JSON.stringify((r as { failure?: unknown }).failure ?? "")}` : "recorded";

export function pngPixel(png: Uint8Array, x: number, y: number): number[] {
  const buf = Buffer.from(png); const width = buf.readUInt32BE(16); const channels = buf[25] === 6 ? 4 : 3;
  const chunks: Buffer[] = [];
  for (let i = 8; i < buf.length;) { const length = buf.readUInt32BE(i); if (buf.toString("ascii", i + 4, i + 8) === "IDAT") chunks.push(buf.subarray(i + 8, i + 8 + length)); i += length + 12; }
  const raw = inflateSync(Buffer.concat(chunks)); const stride = width * channels;
  let previous = Buffer.alloc(stride);
  for (let row = 0; row <= y; row++) {
    const offset = row * (stride + 1); const filter = raw[offset]!; const current = Buffer.from(raw.subarray(offset + 1, offset + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? current[i - channels]! : 0; const b = previous[i]!; const c = i >= channels ? previous[i - channels]! : 0;
      const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
      current[i] = (current[i]! + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? pa <= pb && pa <= pc ? a : pb <= pc ? b : c : 0)) & 255;
    }
    previous = current;
  }
  return [...previous.subarray(x * channels, x * channels + 3)];
}
export const MASK = [0x24, 0x2a, 0x30];
