// §mesh.lan/proposals: Settings → Extensions' "Let {name} link computers without asking". Only the person's own click
// in Sova's page turns it on or off, and it holds only for the version approved when it was turned on. Through the
// real routes (server/app.ts, no listener); what a trusted extension's proposal does is in server/mesh/proposals.test.ts.
import { dropScratchAgentDir, scratchAgentDir } from "./testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { ExtensionsInstalled } from "../shared/extension-loader";

delete process.env.SOVA_EXTENSIONS_FILE;
after(() => dropScratchAgentDir());

const gate = await import("./extension-gate");
const { linkTrusted, linkTrustFile } = await import("./extension-link-trust");
const { buildApp } = await import("./app");
const { pageHeaders } = await import("./testing/page");
const { extensionKeys } = await import("./extension-keys");
const { setExtensionKeyCheck } = await import("./auth");

const { app } = buildApp({ extensionEntriesOf: async () => [] });
const dist = join(scratchAgentDir, "company-dist");
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "index.html"), "<!doctype html><title>stub</title>");
const RAW = { id: "company", title: "Company", description: "A test double", icon: "branch", dist };
const listFile = join(scratchAgentDir, "sova", "extensions.json");
const call = (url: string, body: unknown, headers: Record<string, string>, env?: Record<string, unknown>) =>
  app.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, env);
const turn = (on: boolean, headers: Record<string, string> = pageHeaders(), env?: Record<string, unknown>) => call("/api/extensions/company/link-trust", { on }, headers, env);
const token = () => pageHeaders().cookie!.split("=")[1]!;
/** The row Settings → Extensions draws. */
const row = async () => ((await (await app.request("/api/extensions/installed", { headers: pageHeaders() })).json()) as ExtensionsInstalled).rows.find((r) => r.id === "company")!;

/** Approve the entry as Install does; a later approval is a later moment. */
async function approve(code = "c1") {
  await new Promise((r) => setTimeout(r, 2));
  const entry = gate.entryHash(RAW);
  gate.recordApproval("company", { version: gate.versionOf(entry, code), entry, code, sig: "s" });
  gate.setCodeReading("company", { sig: "s", code });
}

beforeEach(async () => {
  writeFileSync(listFile, JSON.stringify({ version: 1, extensions: [RAW] }));
  gate.resetGateForTest();
  gate.migrateTrust(() => ({}));
  gate.forgetApproval("company");
  await approve();
  assert.equal((await turn(false)).status, 200);
});

describe("who turns it on and off", () => {
  test("only the person's own click in Sova's page: an extension's key, its page or a frame, a script, a chat, a peer and no mark are refused", async () => {
    setExtensionKeyCheck({ isKey: (v: string) => v === "ext-key", idOf: (v: string) => (v === "ext-key" ? "company" : null), socket() {} } as never);
    try {
      const refused: Array<[string, Record<string, string>, Record<string, unknown>?]> = [
        ["the extension's key", { "x-sova-token": "ext-key" }],
        ["its page", { ...pageHeaders(), referer: "http://127.0.0.1/ext/company/" }],
        ["a frame", { ...pageHeaders(), "sec-fetch-dest": "iframe" }],
        ["a script", { "x-sova-token": token() }],
        ["a chat", { "x-sova-caller": "k", "x-sova-token": token() }],
        ["no mark", {}],
        ["a peer", pageHeaders(), { meshPeer: { id: "other", nodeId: "n" } }],
      ];
      for (const on of [true, false]) {
        if (!on) assert.equal((await turn(true)).status, 200, "the page turns it on");
        for (const [who, headers, env] of refused) {
          const res = await turn(!on, headers, env);
          assert.ok(res.status === 403 || res.status === 404, `${on ? "off" : "on"} → ${!on} by ${who}: ${res.status}`);
          assert.equal(linkTrusted("company"), !on, `${who} changed nothing`);
        }
      }
      // The your-click refusal's words, once (the deck's sentence).
      const words = ((await (await turn(true, { "x-sova-token": "ext-key" })).json()) as { error: string }).error;
      assert.equal(words, "Only the user lets an extension link computers without asking. Ask them to turn it on in Settings → Extensions. Nothing changed.");
    } finally {
      setExtensionKeyCheck(extensionKeys);
    }
  });

  test("the page turns it on and off; the row shows it; the file is the user's alone", async () => {
    assert.equal((await row()).linkTrust, false, "off at first");
    assert.equal((await turn(true)).status, 200);
    assert.equal(linkTrusted("company"), true);
    assert.equal((await row()).linkTrust, true);
    assert.equal(statSync(linkTrustFile()).mode & 0o777, 0o600);
    assert.equal((await turn(false)).status, 200);
    assert.equal(linkTrusted("company"), false);
    assert.equal((await call("/api/extensions/company/link-trust", { on: "yes" }, pageHeaders())).status, 400);
    assert.equal((await call("/api/extensions/nope/link-trust", { on: true }, pageHeaders())).status, 404);
  });
});

describe("it holds for the version approved when it was turned on", () => {
  test("approving the extension again turns it off for good; while its code isn't what was approved (Changed) it does nothing", async () => {
    assert.equal((await turn(true)).status, 200);
    gate.setCodeReading("company", { sig: "s2", code: "c2" });
    assert.equal(linkTrusted("company"), false, "Changed: the code running isn't the code approved");
    assert.equal((await row()).linkTrust, undefined, "a Changed row has no switch");
    await approve("c2");
    assert.equal(linkTrusted("company"), false, "a new version approved: off");
    await approve("c2");
    assert.equal(linkTrusted("company"), false, "approved again, the same version: still off");
    assert.equal((await turn(true)).status, 200, "the person may turn it on again for this version");
    assert.equal(linkTrusted("company"), true);
  });

  test("an extension that isn't on as approved can't be trusted", async () => {
    gate.forgetApproval("company");
    const res = await turn(true);
    assert.equal(res.status, 409, "waiting for approval");
    assert.equal(linkTrusted("company"), false);
    await approve();
    writeFileSync(listFile, JSON.stringify({ version: 1, extensions: [{ ...RAW, off: true }] }));
    assert.equal((await turn(true)).status, 409, "turned off");
  });
});
