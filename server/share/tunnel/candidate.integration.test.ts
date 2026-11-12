// A new address waits for its Verify (§mesh.public/where-links-open): on Cloudflare Free with its tunnel up
// (the fake cloudflared, detached driver), a PUT to Account saves a candidate and links keep the Free address;
// a Verify that fails keeps everything as it is, with the reason; one that passes switches to Account. The
// outside check is injected: never the network.
import { dropScratchAgentDir } from "../../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import type { PublicLinksInfo, VerifyResult } from "../../../shared/public-links";

const HOST = "able-baker-charlie-delta.trycloudflare.com";
const ACCOUNT = "https://share.example.com";
process.env.SOVA_QUICK_TUNNEL = "on";
process.env.SOVA_CLOUDFLARED = join(import.meta.dirname, "..", "..", "testing", "fake-cloudflared.mjs");
process.env.SOVA_TUNNEL_DRIVER = "detached";
process.env.SOVA_TUNNEL_VERIFY = "off";
process.env.FAKE_CF_HOSTNAME = HOST;
const { scratchAgentDir } = await import("../../testing/scratch-agent-dir");
const LOG = join(scratchAgentDir, "fake-cf.log");
process.env.FAKE_CF_LOG = LOG;
/** The fake's starts that ran a named (Account) tunnel: argv without --url. */
const accountStarts = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter((l) => l.startsWith("start ") && !l.includes("--url")).length : 0);
for (const k of ["SOVA_SHARE_PUBLIC_URL", "SOVA_SHARE_HOST", "SOVA_SHARE_PORT"]) delete process.env[k];

const store = await import("../../public-links");
const listener = await import("../listener");
const { awaitShareLinks } = await import("../links-events");
const batonLinks = await import("../../baton-links");
const manager = await import("./manager");
const wiring = await import("./wiring");
const { writeAccountToken } = await import("./account-token");
const { mountPublicLinks } = await import("../../public-links-routes");
const { pageHeaders } = await import("../../testing/page");

after(async () => {
  wiring.stopTunnelWiring();
  for (const kind of ["candidate", "share"] as const) await manager.stopTunnel({ kind }, "test over").catch(() => undefined);
  listener.stopShareListener();
  dropScratchAgentDir();
});

/** The outside check: whatever the test says X answers now. */
let answers = false;
const checked: string[] = [];
const verify = async (url: string): Promise<VerifyResult> => {
  checked.push(url);
  return answers ? { ok: true, status: 404 } : { ok: false, error: "Couldn't connect" };
};
const app = new Hono();
mountPublicLinks(app, { routed: async () => [], gateways: async () => [], verify });
const call = async (method: string, url: string, body?: unknown) =>
  (await app.request(url, { method, headers: { "Content-Type": "application/json", ...pageHeaders() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();

test("on Free with its tunnel up, a move to Account waits for its Verify; a failed one changes nothing, a passed one switches", async () => {
  await listener.startShareListener(process.env);
  await wiring.startTunnelWiring({ env: process.env });
  store.recordTunnelConsent();
  await awaitShareLinks(() => batonLinks.mintLink({ orgId: "o1", sessionId: "s1", n: 1, personId: "p1" }));
  const free = `https://${HOST}`;
  assert.equal(listener.shareState().publicUrl, free, "control: Free's tunnel is up and links use it");
  // The fake's Account ingress points at the listener Free bound (what the dashboard step says).
  process.env.FAKE_CF_INGRESS = `http://127.0.0.1:${listener.shareListenerState()!.port}`;
  writeAccountToken(Buffer.from(JSON.stringify({ a: "acct", t: "tunnel", s: "secret-value" })).toString("base64"));

  const put = (await call("PUT", "/api/public-links", { route: "account", account: { publicUrl: ACCOUNT } })) as PublicLinksInfo;
  assert.equal(put.file.route, "quick", "the route stays Free");
  assert.equal(put.share.publicUrl, free);
  assert.deepEqual([put.candidate?.route, put.candidate?.publicUrl], ["account", ACCOUNT]);
  assert.equal(listener.shareState().publicUrl, free, "links keep opening where they open now");

  // X doesn't answer: nothing changes, and the reason is kept for the page.
  const failed = (await call("POST", "/api/public-links/verify")) as VerifyResult;
  assert.deepEqual([failed.ok, failed.error], [false, "Couldn't connect"]);
  assert.deepEqual(checked, [ACCOUNT], "the candidate's address is what was checked");
  assert.equal(accountStarts(), 1, "its own Account tunnel ran for the check, beside Free's");
  assert.equal(listener.shareState().publicUrl, free);
  assert.equal(manager.tunnelStatus({ kind: "candidate" }).state, "stopped", "the candidate's tunnel ran only for the check");
  const after1 = (await call("GET", "/api/public-links")) as PublicLinksInfo;
  assert.equal(after1.candidate?.failure?.reason, "Couldn't connect");
  assert.equal(after1.file.route, "quick");

  // X answers: it becomes the route.
  answers = true;
  const passed = (await call("POST", "/api/public-links/verify")) as VerifyResult;
  assert.equal(passed.ok, true);
  const now = (await call("GET", "/api/public-links")) as PublicLinksInfo;
  assert.equal(now.file.route, "account");
  assert.equal(now.candidate, undefined, "no candidate left");
  assert.deepEqual([listener.shareState().publicUrl, listener.shareState().source, listener.shareState().state], [ACCOUNT, "account", "verified"]);
  assert.equal(manager.tunnelStatus({ kind: "share" }).mode, "account", "Account's tunnel took over");
});

test("on a working Account, a new token waits with its setup: the live tunnel keeps its token and address until Verify passes", async () => {
  const { tokenFile } = await import("./account-token");
  assert.equal(listener.shareState().source, "account", "control: the first test left a verified Account");
  const tokenA = readFileSync(tokenFile(), "utf8");
  const startsBefore = accountStarts();
  const tokenB = Buffer.from(JSON.stringify({ a: "acct", t: "tunnel-b", s: "other-secret" })).toString("base64");
  await app.request("/api/public-links/account-token", { method: "PUT", headers: { "Content-Type": "application/json", ...pageHeaders() }, body: JSON.stringify({ token: tokenB }) });
  assert.equal(readFileSync(tokenFile(), "utf8"), tokenA, "the live token is untouched");
  assert.equal(accountStarts(), startsBefore, "nothing restarted");

  // A new address with it: waits.
  const moved = (await call("PUT", "/api/public-links", { route: "account", account: { publicUrl: "https://new.example.com" } })) as PublicLinksInfo;
  assert.deepEqual([moved.file.account?.publicUrl, moved.candidate?.publicUrl], [ACCOUNT, "https://new.example.com"]);
  assert.equal(listener.shareState().publicUrl, ACCOUNT);

  // The same address with the new token: waits too (a new tunnel to check), and a pass takes the token over.
  const same = (await call("PUT", "/api/public-links", { route: "account", account: { publicUrl: ACCOUNT } })) as PublicLinksInfo;
  assert.equal(same.candidate?.publicUrl, ACCOUNT, "a candidate even at the same address");
  assert.equal(readFileSync(tokenFile(), "utf8"), tokenA, "still the old token live");
  answers = true;
  assert.equal(((await call("POST", "/api/public-links/verify")) as VerifyResult).ok, true);
  assert.notEqual(readFileSync(tokenFile(), "utf8"), tokenA, "the verified token is the live one now");
  assert.ok(readFileSync(tokenFile(), "utf8").includes(tokenB));
  assert.equal(listener.shareState().publicUrl, ACCOUNT);
  assert.equal(((await call("GET", "/api/public-links")) as PublicLinksInfo).candidate, undefined);
});
