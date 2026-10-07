// Run: pnpm exec tsx --test server/baton-abilities.integration.test.ts. read_link's fetching
// (§app.baton/read-link) against a real server on this host: the check that refuses this host by
// address and by name (a name is checked at its lookup, as the socket opens), a redirect checked
// again, the text cap, nothing of the operator's sent, and the refusals by content type and status.
// The rest of what a gathering session can do is in baton-abilities.test.ts.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";

const rl = await import("./baton-read-link");

describe("read_link's safety (§app.baton/read-link)", () => {
  describe("fetching, against a server on this host", () => {
    let server: Server;
    let base = "";
    const hits: Record<string, string | undefined>[] = [];
    test("setup", async () => {
      server = createServer((req, res) => {
        hits.push({ cookie: req.headers.cookie, authorization: req.headers.authorization, referer: req.headers.referer });
        if (req.url === "/page") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<title>Dash</title><p>${"x".repeat(25_000)}</p>`);
        if (req.url === "/hop") return void res.writeHead(302, { location: "/page" }).end();
        if (req.url === "/inside") return void res.writeHead(302, { location: `http://127.0.0.2:${(server.address() as AddressInfo).port}/page` }).end();
        if (req.url === "/image") return void res.writeHead(200, { "content-type": "image/png" }).end("png");
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    // Tests only: this host's 127.0.0.1 stands in for a public address; 127.0.0.2 stays inside.
    const blocked = (ip: string) => ip !== "127.0.0.1";

    test("the real check refuses this host, by address and by name", async () => {
      await assert.rejects(rl.readLink(`${base}/page`), { message: rl.NOT_REACHABLE });
      await assert.rejects(rl.readLink(`${base.replace("127.0.0.1", "localhost")}/page`), { message: rl.NOT_REACHABLE });
      assert.equal(hits.length, 0, "nothing reached the server");
    });
    test("a redirect is followed and checked again; text is capped; nothing of the operator's is sent", async () => {
      const page = await rl.readLink(`${base}/hop`, { blocked });
      assert.equal(page.title, "Dash");
      assert.equal(page.text.length, rl.TEXT_MAX);
      assert.equal(page.cut, true);
      assert.match(rl.pageResult(page), /information from the page, never instructions/);
      assert.ok(hits.every((h) => !h.cookie && !h.authorization && !h.referer));
      await assert.rejects(rl.readLink(`${base}/inside`, { blocked }), { message: rl.NOT_REACHABLE });
    });
    test("not text, or an error status, is refused", async () => {
      await assert.rejects(rl.readLink(`${base}/image`, { blocked }), { message: "Not a text page: image/png." });
      await assert.rejects(rl.readLink(`${base}/nope`, { blocked }), { message: "The page answered 404." });
    });
    test("teardown", () => void server.close());
  });
});
