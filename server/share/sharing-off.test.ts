// Off turns sharing off (§mesh.public/sharing-off): every store that makes a public link refuses
// before it writes, whoever calls it, and the app answers 403 sharing-off; a baton still works, with
// no link. In process, a throwaway agent dir.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";

const { SHARING_OFF_ERROR, SHARING_OFF_MESSAGE } = await import("../../shared/public-links");
const store = await import("../public-links");
const { stateRoot } = await import("../state-root");
const { SharingOffError, assertSharingOn, isSharingOffError, sharingOff } = await import("./sharing-off");
const batonLinks = await import("../baton-links");
const personLinks = await import("../person-links");
const previewLinks = await import("../preview-links");
const sessionShares = await import("../session-shares");
const { tourShares } = await import("../tours/shares");
const baton = await import("../baton");

after(dropScratchAgentDir);

const turnOff = () => {
  const r = store.patchPublicLinks({ route: "off" });
  assert.ok("file" in r && store.readPublicLinksSetting().sharingOff, "control: the setting reads sharing off");
};
afterEach(() => {
  for (const f of ["public-links.json", "baton-links.json", "person-links.json", "preview-links.json", "session-shares.json"]) rmSync(join(stateRoot(), f), { force: true });
});

/** Every public-link mint, called as its callers do; the arguments are only shaped enough to reach the store. */
const MINTS: [string, () => unknown][] = [
  ["h: a hand-off link", () => batonLinks.mintLink({ orgId: "o1", sessionId: "s1", n: 1, personId: "p1" })],
  ["i: an owner link", () => personLinks.mintOwnerLink("o1", "p1")],
  ["p: a preview", () => previewLinks.mintPreview({ projectId: "proj", port: 5173, days: 1 }, new Set())],
  ["p: a person's own preview link", () => previewLinks.mintSibling("pv_x", "person:p1")],
  ["s: a session share", () => sessionShares.createShare({ sessionId: "s1", sessionPath: "/x.jsonl", title: "T", mode: "live", cut: null, from: null, days: 1 as never, labels: ["A"], anyone: false })],
  ["s: one more recipient", () => sessionShares.addRecipient("ss_x", { label: "B" })],
  ["s: a recipient's new link", () => sessionShares.relinkRecipient("ss_x", "r_x")],
  ["t: a tour link", () => tourShares().create("s1", "t1", "e1", "pv", new Date(Date.now() + 86_400_000).toISOString())],
  // A live link's life lengthened is a share too.
  ["p: a preview extended", () => previewLinks.extendPreview("pv_x", 1)],
  ["p: a running copy's link shared again", () => previewLinks.renewPreview("pv_x", 1)],
  ["s: a share extended", () => sessionShares.extendShare("ss_x", 7 as never)],
];

describe("while sharing is off", () => {
  test("every public-link store refuses with sharing-off before it writes, whoever calls it", () => {
    turnOff();
    for (const [name, mint] of MINTS) {
      assert.throws(mint, (err: unknown) => isSharingOffError(err) && (err as Error).message === SHARING_OFF_MESSAGE, name);
    }
    for (const f of ["baton-links.json", "person-links.json", "preview-links.json", "session-shares.json"]) {
      const p = join(stateRoot(), f);
      assert.ok(!existsSync(p) || !/"hash"/.test(readFileSync(p, "utf8")), `${f}: nothing written`);
    }
  });

  test("with sharing on, no store answers sharing-off (control: the refusal is Off's, not the arguments')", () => {
    for (const [name, mint] of MINTS) {
      try {
        mint();
      } catch (err) {
        assert.ok(!isSharingOffError(err), `${name}: refused for another reason only`);
      }
    }
    assert.match(batonLinks.mintLink({ orgId: "o1", sessionId: "s1", n: 1, personId: "p1" }), /^[A-Za-z0-9_-]{43}$/, "a hand-off link is made");
  });

  test("only an Off picked from the list is sharing off: no file, an old Off and an unreadable file are not", () => {
    writeFileSync(store.publicLinksFile(), JSON.stringify({ version: 1, route: "off" }));
    assert.equal(sharingOff(), false, "an Off saved before the list: Free by default");
    writeFileSync(store.publicLinksFile(), "{ not json");
    assert.equal(sharingOff(), false, "unreadable: links stay local-only, sharing stays on");
    assert.doesNotThrow(() => assertSharingOn());
    turnOff();
    assert.equal(sharingOff({ SOVA_SHARE_PUBLIC_URL: "https://pin.example.com" }), false, "an env pin wins over Off");
    assert.throws(() => assertSharingOn(), SharingOffError);
  });

  test("a baton still works with no public link: its mint makes none, and nobody waits for one", async () => {
    turnOff();
    baton.mintForEffect({ orgId: "o1", sessionId: "s1", n: 1, personId: "p1", key: "k" });
    assert.deepEqual(batonLinks.liveLinks("s1", 1), [], "no hand-off link");
    // Would wait a minute for a token that never comes; sharing off answers at once.
    assert.equal(await baton.takeMinted("s1", 1, "p1", 60_000), undefined);
  });

  test("the app answers a refused mint 403 with code sharing-off, never a 500", async () => {
    const { Hono } = await import("hono");
    const { sharingOffResponse } = await import("./sharing-off");
    const app = new Hono();
    // As server/app.ts's onError: the mapping first, any other error a 500.
    app.onError((err, c) => sharingOffResponse(err, c) ?? c.json({ error: "x" }, 500));
    app.post("/mint", () => {
      assertSharingOn();
      return new Response("made");
    });
    turnOff();
    const res = await app.request("/mint", { method: "POST" });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: SHARING_OFF_MESSAGE, code: SHARING_OFF_ERROR });
    const appTs = readFileSync(join(import.meta.dirname, "..", "app.ts"), "utf8");
    assert.match(appTs, /onError\(\(err, c\) => \{\n\s+\/\/[^\n]*\n\s+const off = sharingOffResponse\(err, c\);/, "server/app.ts maps it first");
  });
});
