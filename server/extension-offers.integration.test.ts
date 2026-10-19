// Run: node scripts/run-tests.mjs server/extension-offers.integration.test.ts
// GET /api/extensions carries what each extension offers (§app.extensions/offers), against a real
// loopback health route: an extension that declares nothing gets exactly the payload it got before
// the field existed, one that declares offers gets them validated, no secret ever rides along, and
// a peer's listed-only entry never carries any. The validator itself is extension-offers.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-ext-offers-int-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.SOVA_EXTENSIONS_FILE = join(tmp, "extensions.json");
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });
const dist = join(tmp, "dist");
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "index.html"), "<!doctype html><title>stub</title>");

const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { clearHealthCache, setPeerExtensions, validateExtension } = await import("./extensions");
const { sovaToken } = await import("./auth");

let backend: Server;
let port = 0;
before(async () => {
  backend = createServer((req, res) => {
    res.writeHead(req.url === "/api/health" ? 200 : 404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  port = (backend.address() as { port: number }).port;
});
after(async () => {
  setPeerExtensions(null);
  await new Promise<void>((r) => backend.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => clearHealthCache());

const write = (extensions: unknown[]) => writeFileSync(process.env.SOVA_EXTENSIONS_FILE!, JSON.stringify({ version: 1, extensions }));
const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id.toUpperCase(), description: "d", icon: "file", dist, api: `http://127.0.0.1:${port}`, ...extra });
const list = async () => {
  const res = await app.request("/api/extensions");
  assert.equal(res.status, 200);
  return { text: await res.clone().text(), json: (await res.json()) as Array<Record<string, unknown>> };
};

describe("GET /api/extensions: offers", () => {
  test("an extension that declares nothing gets exactly today's payload", async () => {
    write([entry("plain"), entry("bare", { description: undefined, icon: undefined })]);
    const { text } = await list();
    assert.equal(text, JSON.stringify([
      { id: "plain", title: "PLAIN", status: "ok", description: "d", icon: "file" },
      { id: "bare", title: "BARE", status: "ok" },
    ]));
  });

  test("declared offers are carried validated, in their own field, the rest of the item unchanged", async () => {
    write([
      entry("tickets", { commands: [{ name: "create", label: "Create Issue", summary: "Files it", params: { t: { type: "string" } } }, { name: "BAD", label: "x" }], screens: ["reply", "nowhere"] }),
      entry("broken", { commands: "nope", screens: 3 }),
    ]);
    const { json } = await list();
    assert.deepEqual(json[0], {
      id: "tickets", title: "TICKETS", status: "ok", description: "d", icon: "file",
      offers: { commands: [{ name: "create", label: "Create Issue", summary: "Files it" }], screens: ["reply"] },
    });
    assert.deepEqual(json[1], { id: "broken", title: "BROKEN", status: "ok", description: "d", icon: "file" }, "nothing valid declared: no offers key");
  });

  test("no secret rides along: the token, keys Sova doesn't know, dist and api never appear", async () => {
    const token = sovaToken();
    write([entry("leaky", { token, env: { SOVA_TOKEN: token }, commands: [{ name: "a", label: "A", token, headers: { "x-sova-token": token } }], screens: ["reply"] })]);
    const { text, json } = await list();
    assert.ok(!text.includes(token), "the token is not in the payload");
    assert.ok(!text.includes(dist) && !text.includes(String(port)), "dist and api are not in the payload");
    assert.deepEqual(json[0]!.offers, { commands: [{ name: "a", label: "A" }], screens: ["reply"] });
  });

  test("a peer's listed-only entry carries no offers, whatever it declared", async () => {
    write([]);
    const v = validateExtension(entry("remote", { commands: [{ name: "a", label: "A" }], screens: ["reply"] }));
    assert.ok("entry" in v);
    setPeerExtensions(() => [{ entry: v.entry, installed: false }]);
    try {
      const { json } = await list();
      assert.equal(json.length, 1);
      assert.equal(json[0]!.id, "remote");
      assert.ok(!("offers" in json[0]!));
    } finally {
      setPeerExtensions(null);
    }
  });
});
