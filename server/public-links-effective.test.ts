// Run: pnpm test server/public-links-effective.test.ts. A throwaway PI_CODING_AGENT_DIR in the OS temp dir.
// The effective Public links setting (PublicLinksReading): which stored file reads as Cloudflare Free,
// as sharing off, or as a setup that can't be read (never Free), with and without SOVA_QUICK_TUNNEL=off;
// the PUT's offChosenAt and account rules; the Turn On consent file.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-public-links-eff-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent"), { recursive: true });
for (const k of ["SOVA_SHARE_PUBLIC_URL", "SOVA_SHARE_HOST", "SOVA_SHARE_PORT", "SOVA_SHARE_PREVIEW_URL"]) delete process.env[k];

const store = await import("./public-links");

after(() => rmSync(root, { recursive: true, force: true }));

const ON: NodeJS.ProcessEnv = {};
const TESTS_OFF: NodeJS.ProcessEnv = { SOVA_QUICK_TUNNEL: "off" };
const GATEWAY = { publicUrl: "https://share.example.com", front: "caddy", sharePort: 4802, acceptFrom: "all" } as const;
const ACCOUNT = { publicUrl: "https://links.example.com" } as const;

function reset(): void {
  rmSync(store.publicLinksFile(), { force: true, recursive: true });
  rmSync(store.tunnelConsentFile(), { force: true });
}
function stored(value: unknown): void {
  mkdirSync(dirname(store.publicLinksFile()), { recursive: true });
  writeFileSync(store.publicLinksFile(), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
const quiet = <T>(fn: () => T): T => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
};

describe("the effective setting", () => {
  afterEach(reset);

  type Row = { name: string; file: unknown | undefined | "dir"; on: [route: unknown, implicit: boolean, broken: boolean, sharingOff: boolean]; off?: [unknown, boolean, boolean, boolean] };
  const rows: Row[] = [
    { name: "no file", file: undefined, on: ["quick", true, false, false], off: ["off", true, false, false] },
    { name: "an Off saved before the Free default", file: { version: 1, route: "off" }, on: ["quick", true, false, false], off: ["off", true, false, false] },
    { name: "an Off saved in the new menu", file: { version: 1, route: "off", offChosenAt: 1_700_000_000_000 }, on: ["off", false, false, true] },
    { name: "Cloudflare Free chosen", file: { version: 1, route: "quick" }, on: ["quick", false, false, false] },
    { name: "Cloudflare Account", file: { version: 1, route: "account", account: ACCOUNT }, on: ["account", false, false, false] },
    { name: "own gateway", file: { version: 1, route: "self", gateway: GATEWAY }, on: ["self", false, false, false] },
    { name: "through a peer", file: { version: 1, route: { via: { nodeId: "nGATEWAYCNTRL" } } }, on: [{ via: { nodeId: "nGATEWAYCNTRL" } }, false, false, false] },
    { name: "not JSON", file: "{ nope", on: ["off", false, true, false] },
    { name: "a malformed own-domain setup", file: { version: 1, route: "self", gateway: { ...GATEWAY, publicUrl: "http://share.example.com" } }, on: ["off", false, true, false] },
    { name: "own domain with a key this build doesn't know", file: { version: 1, route: "self", gateway: GATEWAY, extra: 1 }, on: ["off", false, true, false] },
    { name: "account without its address", file: { version: 1, route: "account" }, on: ["off", false, true, false] },
    { name: "offChosenAt beside another route", file: { version: 1, route: "self", gateway: GATEWAY, offChosenAt: 5 }, on: ["off", false, true, false] },
    { name: "a file that can't be read (a directory)", file: "dir", on: ["off", false, true, false] },
  ];

  for (const row of rows) {
    for (const [label, env, want] of [
      ["Free enabled", ON, row.on],
      ["SOVA_QUICK_TUNNEL=off", TESTS_OFF, row.off ?? row.on],
    ] as const) {
      test(`${row.name}, ${label}`, () => {
        reset();
        mkdirSync(dirname(store.publicLinksFile()), { recursive: true });
        if (row.file === "dir") mkdirSync(store.publicLinksFile(), { recursive: true });
        else if (row.file !== undefined) stored(row.file);
        const r = quiet(() => store.readPublicLinksSetting(env));
        assert.deepEqual([r.file.route, r.implicit, r.broken, r.sharingOff], [...want]);
        assert.deepEqual(quiet(() => store.readPublicLinks(env)), r.file, "readPublicLinks is the reading's file");
      });
    }
  }

  test("a setup that can't be read is never mistaken for one never set up: never Free, even with Free enabled", () => {
    stored({ version: 1, route: "self", gateway: { ...GATEWAY, front: "nginx" } });
    const r = quiet(() => store.readPublicLinksSetting(ON));
    assert.equal(r.broken, true);
    assert.equal(r.implicit, false);
    assert.notEqual(r.file.route, "quick");
    assert.equal(r.sharingOff, false, "sharing stays on: links are local-only with the broken warning");
    assert.equal(quiet(() => store.readStoredPublicLinks()).kind, "broken");
  });

  test("the stored file keeps a legacy Off as off; only the reading turns it into Free", () => {
    stored({ version: 1, route: "off", gateway: GATEWAY });
    assert.deepEqual(store.readStoredPublicLinks(), { kind: "ok", file: { version: 1, route: "off", gateway: GATEWAY } });
    assert.deepEqual(store.readPublicLinks(ON), { version: 1, route: "quick", gateway: GATEWAY }, "the rest of the file is kept");
    rmSync(store.publicLinksFile());
    assert.deepEqual(store.readStoredPublicLinks(), { kind: "missing" });
  });

  test("an env pin wins over the new menu's Off: sharing isn't off while SOVA_SHARE_PUBLIC_URL is set", () => {
    stored({ version: 1, route: "off", offChosenAt: 1 });
    assert.equal(store.readPublicLinksSetting(ON).sharingOff, true);
    assert.equal(store.readPublicLinksSetting({ SOVA_SHARE_PUBLIC_URL: "https://pinned.example.com" }).sharingOff, false);
  });

  test("quickTunnelEnabled: off only for SOVA_QUICK_TUNNEL=off", () => {
    assert.equal(store.quickTunnelEnabled({}), true);
    assert.equal(store.quickTunnelEnabled({ SOVA_QUICK_TUNNEL: "on" }), true);
    assert.equal(store.quickTunnelEnabled({ SOVA_QUICK_TUNNEL: " OFF " }), false);
  });
});

describe("saving", () => {
  afterEach(reset);

  test("route off from a PUT stamps offChosenAt (sharing off); the stamp stays on a second Off and goes with any other route", () => {
    const off = store.patchPublicLinks({ route: "off" }, 1000);
    assert.ok("file" in off);
    assert.deepEqual(off.file, { version: 1, route: "off", offChosenAt: 1000 });
    assert.equal(store.readPublicLinksSetting(ON).sharingOff, true);
    const again = store.patchPublicLinks({ route: "off" }, 2000);
    assert.ok("file" in again && again.file.offChosenAt === 1000);
    const quick = store.patchPublicLinks({ route: "quick" }, 3000);
    assert.ok("file" in quick);
    assert.deepEqual(JSON.parse(readFileSync(store.publicLinksFile(), "utf8")), { version: 1, route: "quick" });
    assert.equal(statSync(store.publicLinksFile()).mode & 0o777, 0o600);
  });

  test("a patch that doesn't set the route leaves a legacy Off as it was (still Free), and answers the effective file", () => {
    stored({ version: 1, route: "off" });
    const r = store.patchPublicLinks({ ingressPort: 4803 }, 1000);
    assert.ok("file" in r);
    assert.deepEqual(r.file, store.readPublicLinks(), "the answer is the effective file (the runner's SOVA_QUICK_TUNNEL=off: off)");
    assert.deepEqual(store.readPublicLinks(ON), { version: 1, route: "quick", ingressPort: 4803 });
    assert.deepEqual(JSON.parse(readFileSync(store.publicLinksFile(), "utf8")), { version: 1, route: "off", ingressPort: 4803 });
  });

  test("offChosenAt and consent can't be sent in a patch", () => {
    assert.ok("error" in store.patchPublicLinks({ route: "off", offChosenAt: 1 }));
    assert.ok("error" in store.patchPublicLinks({ consentAt: 1 }));
  });

  test("account: needs its address; the address is forgiven one trailing slash; it is kept under Free and Off, and dropped for self or via", () => {
    assert.ok("error" in store.patchPublicLinks({ route: "account" }));
    assert.ok("error" in store.patchPublicLinks({ route: "account", account: { publicUrl: "http://links.example.com" } }));
    const r = store.patchPublicLinks({ route: "account", account: { publicUrl: "https://links.example.com/", previewUrl: "https://*.Example.com/" } });
    assert.ok("file" in r);
    assert.deepEqual(r.file, { version: 1, route: "account", account: { publicUrl: "https://links.example.com", previewUrl: "https://*.example.com" } });
    const quick = store.patchPublicLinks({ route: "quick" });
    assert.ok("file" in quick && quick.file.account?.publicUrl === "https://links.example.com");
    const self = store.patchPublicLinks({ route: "self", gateway: GATEWAY });
    assert.ok("file" in self);
    assert.deepEqual(JSON.parse(readFileSync(store.publicLinksFile(), "utf8")), { version: 1, route: "self", gateway: GATEWAY }, "a self file carries no key an older Sova would refuse");
  });

  test("an old-shape own-domain file round-trips byte for byte", () => {
    const text = `${JSON.stringify({ version: 1, route: "self", gateway: GATEWAY, verifiedAt: 5 }, null, 2)}\n`;
    stored(text);
    const r = store.patchPublicLinks({});
    assert.ok("file" in r);
    assert.equal(readFileSync(store.publicLinksFile(), "utf8"), text);
  });

  test("verifiedAt follows the address: kept on an unchanged account address, dropped when it or the route changes", () => {
    store.patchPublicLinks({ route: "account", account: ACCOUNT });
    store.writeServerFields({ verifiedAt: 7 });
    const same = store.patchPublicLinks({ account: ACCOUNT });
    assert.ok("file" in same && same.file.verifiedAt === 7);
    const moved = store.patchPublicLinks({ account: { publicUrl: "https://other.example.com" } });
    assert.ok("file" in moved && moved.file.verifiedAt === undefined);
  });

  test("a server write never replaces a setup that can't be read; a PUT does (saving again fixes it)", () => {
    const bad = `{"version":1,"route":"self","gateway":{"publicUrl":"https://x.example.com","front":"nope"}}`;
    stored(bad);
    const r = quiet(() => store.writeServerFields({ verifiedAt: 9 }));
    assert.equal(r.route, "off");
    assert.equal(readFileSync(store.publicLinksFile(), "utf8"), bad, "left as it was");
    const fixed = quiet(() => store.patchPublicLinks({ route: "self", gateway: GATEWAY }));
    assert.ok("file" in fixed && fixed.file.route === "self");
  });
});

describe("Turn On", () => {
  afterEach(reset);

  test("no consent until recorded; the first time stays; quickTunnelAllowed needs it and Free enabled", () => {
    assert.equal(store.readTunnelConsent(), null);
    assert.equal(store.quickTunnelAllowed(ON), false);
    assert.equal(store.recordTunnelConsent(100), 100);
    assert.equal(store.recordTunnelConsent(200), 100);
    assert.equal(store.readTunnelConsent(), 100);
    assert.equal(statSync(store.tunnelConsentFile()).mode & 0o777, 0o600);
    assert.equal(store.quickTunnelAllowed(ON), true);
    assert.equal(store.quickTunnelAllowed(TESTS_OFF), false);
  });

  test("a bad consent file is no consent", () => {
    mkdirSync(dirname(store.tunnelConsentFile()), { recursive: true });
    writeFileSync(store.tunnelConsentFile(), `{"version":1,"consentAt":"yes"}`);
    assert.equal(store.readTunnelConsent(), null);
  });
});

describe("planning a patch", () => {
  afterEach(reset);

  test("planPublicLinksPatch builds the next stored file and writes nothing; patchPublicLinks writes the same", () => {
    stored({ version: 1, route: "off" });
    const before = readFileSync(store.publicLinksFile(), "utf8");
    const plan = store.planPublicLinksPatch({ route: "account", account: { publicUrl: "https://links.example.com/" } }, 5);
    assert.deepEqual(plan, { file: { version: 1, route: "account", account: ACCOUNT } });
    assert.equal(readFileSync(store.publicLinksFile(), "utf8"), before, "nothing written");
    assert.ok("error" in store.planPublicLinksPatch({ route: "account" }));
    const off = store.planPublicLinksPatch({ route: "off" }, 7);
    assert.ok("file" in off && off.file.offChosenAt === 7, "the stored form: offChosenAt stamped");
    store.patchPublicLinks({ route: "account", account: ACCOUNT });
    assert.deepEqual(JSON.parse(readFileSync(store.publicLinksFile(), "utf8")), plan.file);
  });
});
