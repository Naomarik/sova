// The tunnel routes and the setting's doors, in process (§mesh.tunnel/turn-on, §mesh.public/sharing-off,
// §mesh.public/broken-links): Turn On passes only the page's own click; PUT /api/public-links refuses a chat,
// the Overseer, an extension and a peer but passes the operator's token script; the server-written keys
// are never a PUT's; a Copy click under Free records the link's hand-out. A throwaway agent dir.
import { dropScratchAgentDir } from "../../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { after, afterEach, describe, test } from "node:test";
import { Hono } from "hono";

process.env.SOVA_QUICK_TUNNEL = "on";
process.env.SOVA_CLOUDFLARED = "off";

const store = await import("../../public-links");
const { mountPublicLinks } = await import("../../public-links-routes");
const { pageHeaders } = await import("../../testing/page");
const { sovaToken, TOKEN_HEADER } = await import("../../auth");
const { CALLER_HEADER } = await import("../../caller-keys");
const batonLinks = await import("../../baton-links");
const handouts = await import("./handouts");
const { handedOutHashes, HANDED_OUT_MAX } = await import("./routes");

after(dropScratchAgentDir);
const { candidateFile } = await import("../candidate");
afterEach(() => {
  for (const f of [store.publicLinksFile(), store.tunnelConsentFile(), candidateFile()]) rmSync(f, { force: true });
  handouts.resetHandoutsCache();
});

function app(): Hono {
  const a = new Hono();
  mountPublicLinks(a, { routed: async () => [], gateways: async () => [] });
  return a;
}
const json = { "Content-Type": "application/json" };
/** Who calls: the page; a chat's tool (its caller key, beside the page's cookie); a script with only the token. */
const CALLERS = {
  page: () => pageHeaders(),
  chat: () => ({ [CALLER_HEADER]: "a-chat-key", ...pageHeaders() }),
  script: () => ({ [TOKEN_HEADER]: sovaToken() }),
} as const;
const call = (a: Hono, method: string, url: string, who: keyof typeof CALLERS, body?: unknown) =>
  a.request(url, { method, headers: { ...json, ...CALLERS[who]() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("Turn On", () => {
  test("only the page's own click turns on public links; a chat and a token script are refused and nothing changes", async () => {
    const a = app();
    for (const who of ["chat", "script"] as const) {
      const res = await call(a, "POST", "/api/public-links/turn-on", who);
      assert.equal(res.status, 403, who);
      assert.equal(((await res.json()) as { yourClick?: boolean }).yourClick, true);
      assert.equal(store.readTunnelConsent(), null, `${who}: consentAt stays unset`);
    }
    const res = await call(a, "POST", "/api/public-links/turn-on", "page");
    assert.equal(res.status, 200);
    const info = (await res.json()) as { consentAt?: number | null; implicit?: boolean };
    assert.equal(typeof info.consentAt, "number", "the answer carries the click");
    assert.equal(store.readTunnelConsent(), info.consentAt);
    assert.equal(info.implicit, true, "no address chosen: Free by default");
  });

  test("before Turn On the answer says so: consentAt null, and links carry quick-turn-on", async () => {
    const info = (await (await app().request("/api/public-links")).json()) as { consentAt?: number | null; share: { warningCode?: string }; tunnel?: { cloudflared: { found: boolean } } };
    assert.equal(info.consentAt, null);
    assert.equal(info.share.warningCode, "quick-turn-on");
    assert.equal(info.tunnel?.cloudflared.found, false, "cloudflared looked for (none here)");
  });
});

describe("Try Again", () => {
  test("only the page; and with nothing shared under Free nothing starts (nothing runs at idle)", async () => {
    const { tunnelStatus } = await import("./manager");
    const a = app();
    store.recordTunnelConsent();
    assert.equal((await call(a, "POST", "/api/public-links/tunnel/start", "chat")).status, 403);
    const res = await call(a, "POST", "/api/public-links/tunnel/start", "page");
    assert.equal(res.status, 200);
    assert.equal(tunnelStatus({ kind: "share" }).state, "stopped", "no live link: no tunnel");
  });
});

describe("PUT /api/public-links: where links open stays the user's", () => {
  test("a chat can't leave Off or pick Free; the operator's token script can (option c)", async () => {
    const a = app();
    assert.equal((await call(a, "PUT", "/api/public-links", "page", { route: "off" })).status, 200);
    assert.equal(store.readPublicLinksSetting().sharingOff, true, "control: Off picked");
    const refused = await call(a, "PUT", "/api/public-links", "chat", { route: "quick" });
    assert.equal(refused.status, 403);
    assert.equal(store.readPublicLinksSetting().sharingOff, true, "still off");
    const ok = await call(a, "PUT", "/api/public-links", "script", { route: "quick" });
    assert.equal(ok.status, 200);
    assert.equal(store.readPublicLinksSetting().file.route, "quick");
  });

  test("the server-written keys are never a PUT's: consentAt, offChosenAt and verifiedAt are 400 and write nothing", async () => {
    const a = app();
    for (const key of ["consentAt", "offChosenAt", "verifiedAt"]) {
      const res = await call(a, "PUT", "/api/public-links", "page", { route: "off", [key]: 5 });
      assert.equal(res.status, 400, key);
      assert.equal(store.readStoredPublicLinks().kind, "missing", `${key}: nothing written`);
    }
    assert.equal(store.readTunnelConsent(), null);
  });

  test("a PUT that leaves an old Off as it is answers implicit, as GET does", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(store.publicLinksFile(), JSON.stringify({ version: 1, route: "off" }));
    const a = app();
    const put = (await (await call(a, "PUT", "/api/public-links", "page", { ingressPort: 4803 })).json()) as { implicit?: boolean; file: { route: unknown } };
    const got = (await (await a.request("/api/public-links")).json()) as { implicit?: boolean };
    assert.deepEqual([put.file.route, put.implicit, got.implicit], ["quick", true, true]);
  });

  test("Account needs a saved token first", async () => {
    const res = await call(app(), "PUT", "/api/public-links", "page", { route: "account", account: { publicUrl: "https://share.example.com" } });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "Paste the tunnel's token first.");
  });

  test("Off reads as sharing off in the answer", async () => {
    const info = (await (await call(app(), "PUT", "/api/public-links", "page", { route: "off" })).json()) as { sharingOff?: boolean; consentAt?: unknown };
    assert.equal(info.sharingOff, true);
    assert.equal("consentAt" in info, false, "Turn On is Free's only");
  });
});

describe("a Copy click under Free records the hand-out", () => {
  test("the body's rule: full links of the share kinds, or token hashes; anything else is refused whole", () => {
    const token = "A".repeat(43);
    assert.deepEqual(handedOutHashes({ links: [{ url: `https://a-b.trycloudflare.com/s/${token}` }] }), [handouts.tokenHash(token)]);
    assert.deepEqual(handedOutHashes({ links: [{ id: "f".repeat(64) }] }), ["f".repeat(64)]);
    for (const bad of [null, {}, { links: "x" }, { links: [{ url: "https://x/p/abc" }] }, { links: [{ url: "not a url" }] }, { links: [{ id: "short" }] }, { links: Array.from({ length: HANDED_OUT_MAX + 1 }, () => ({ id: "f".repeat(64) })) }])
      assert.equal(handedOutHashes(bad), null, JSON.stringify(bad)?.slice(0, 60));
  });

  test("only a live link, only under Free", async () => {
    const a = app();
    const token = batonLinks.mintLink({ orgId: "o1", sessionId: "s1", n: 1, personId: "p1" });
    const h = handouts.tokenHash(token);
    const body = { links: [{ url: `https://a-b.trycloudflare.com/h/${token}` }, { id: "e".repeat(64) }] };
    // Under Free (the default here).
    const res = (await (await call(a, "POST", "/api/public-links/handed-out", "page", body)).json()) as { noted: number };
    assert.equal(res.noted, 1, "the unknown hash isn't live: not noted");
    assert.equal(typeof handouts.handedAt(h), "number");
    // Off: nothing is recorded.
    handouts.resetHandoutsCache();
    rmSync(store.publicLinksFile(), { force: true });
    await call(a, "PUT", "/api/public-links", "page", { route: "off" });
    assert.equal(((await (await call(a, "POST", "/api/public-links/handed-out", "page", body)).json()) as { noted: number }).noted, 0);
  });
});

describe("a new address waits for its Verify while today's route works", () => {
  const GW = (publicUrl: string) => ({ publicUrl, front: "caddy", sharePort: 4802, acceptFrom: "all" }) as const;

  test("the rule: only a move to Account or this host as gateway, at another address, while today's route works", async () => {
    const { waitsForVerify } = await import("../../public-links-routes");
    const quick = { version: 1, route: "quick" } as const;
    const self = (u: string) => ({ version: 1, route: "self", gateway: GW(u) }) as const;
    const account = { version: 1, route: "account", account: { publicUrl: "https://a.example.com" } } as const;
    const rows: [string, Parameters<typeof waitsForVerify>, boolean][] = [
      ["Free works → Account", [account, quick, true], true],
      ["Free works → own server", [self("https://s.example.com"), quick, true], true],
      ["own server works → a new address", [self("https://new.example.com"), self("https://s.example.com"), true], true],
      ["own server works → same address (another field)", [self("https://s.example.com"), self("https://s.example.com"), true], false],
      ["nothing works yet (a fresh computer) → Account", [account, quick, false], false],
      ["→ Free switches at once", [quick, account, true], false],
      ["→ Off switches at once", [{ version: 1, route: "off" }, quick, true], false],
      ["→ Through switches at once", [{ version: 1, route: { via: { nodeId: "n1" } } }, quick, true], false],
    ];
    for (const [name, args, want] of rows) assert.equal(waitsForVerify(...args), want, name);
  });

  test("a fresh computer (Free not up) takes the new route at once: no candidate", async () => {
    const a = app();
    const info = (await (await call(a, "PUT", "/api/public-links", "page", { route: "self", gateway: GW("https://s.example.com") })).json()) as { file: { route: unknown }; candidate?: unknown };
    assert.equal(info.file.route, "self");
    assert.equal(info.candidate, undefined);
  });

  test("while one waits, public-links.json is untouched; cancel is the same door as PUT", async () => {
    const a = app();
    await call(a, "PUT", "/api/public-links", "page", { route: "self", gateway: GW("https://s.example.com") });
    store.writeServerFields({ verifiedAt: Date.now() });
    const before = readFileSync(store.publicLinksFile(), "utf8");
    const info = (await (await call(a, "PUT", "/api/public-links", "page", { route: "self", gateway: GW("https://new.example.com") })).json()) as { file: { gateway?: { publicUrl: string } }; candidate?: { publicUrl: string; route: string } };
    assert.equal(info.file.gateway?.publicUrl, "https://s.example.com", "links keep today's address");
    assert.deepEqual([info.candidate?.route, info.candidate?.publicUrl], ["self", "https://new.example.com"]);
    assert.equal(readFileSync(store.publicLinksFile(), "utf8"), before, "the setting file isn't written");
    assert.equal((await call(a, "DELETE", "/api/public-links/candidate", "chat")).status, 403);
    assert.ok(existsSync(candidateFile()), "a chat cancels nothing");
    const cancelled = (await (await call(a, "DELETE", "/api/public-links/candidate", "script")).json()) as { candidate?: unknown };
    assert.equal(cancelled.candidate, undefined);
    assert.ok(!existsSync(candidateFile()));
  });

  test("a route chosen outright (Free, Off, Through) replaces a waiting candidate", async () => {
    const a = app();
    await call(a, "PUT", "/api/public-links", "page", { route: "self", gateway: GW("https://s.example.com") });
    store.writeServerFields({ verifiedAt: Date.now() });
    await call(a, "PUT", "/api/public-links", "page", { route: "self", gateway: GW("https://new.example.com") });
    assert.ok(existsSync(candidateFile()), "control: one waits");
    const info = (await (await call(a, "PUT", "/api/public-links", "page", { route: "off" })).json()) as { file: { route: unknown }; candidate?: unknown };
    assert.deepEqual([info.file.route, info.candidate], ["off", undefined]);
    assert.ok(!existsSync(candidateFile()));
  });
});
