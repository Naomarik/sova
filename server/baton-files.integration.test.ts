// Run: pnpm exec tsx --test server/baton-files.integration.test.ts. A person's files in a gathering
// chat (§app.baton/files, §app/file-intake) on real things: the file route's body cap and its own
// upload timer on a real share listener, over raw HTTP on 127.0.0.1, and inspect_files running a
// real command on a file the person sent. The rest is baton-files.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { MB } from "../shared/baton";
import { piSession } from "./harness/pi/testing/handle";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-files-int-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_SHARE_PUBLIC_URL;
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const { inspectFilesTool } = await import("./baton-files");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { createShareApp } = await import("./share/routes");
const { createShareServer } = await import("./share/listener");
const { FILE_BODY_MAX } = await import("./share/edge");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

const T = "A".repeat(43);

describe("the edge", () => {
  describe("on a listener", async () => {
    const server = createShareServer({
      headersMs: 300,
      requestMs: 300,
      uploadMs: 300,
      fileUploadMs: 1500,
      checkMs: 50,
      dispatch: (req, res) => {
        let n = 0;
        req.on("data", (d: Buffer) => (n += d.length));
        req.on("end", () => res.writeHead(200, { "Content-Type": "text/plain" }).end(String(n)));
      },
      upgrade: (_req, socket) => void socket.destroy(),
      client: () => "one-address",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    after(() => {
      server.close();
      server.closeAllConnections();
    });
    const raw = (head: string, body: Buffer = Buffer.alloc(0), wait = 0) =>
      new Promise<string>((resolve) => {
        const sock = connect(port, "127.0.0.1", () => {
          sock.write(head);
          setTimeout(() => sock.writable && sock.write(body), wait);
        });
        let data = "";
        sock.on("data", (d) => {
          data += d;
          if (data.includes("\r\n")) (sock.destroy(), resolve(data.split("\r\n")[0]!));
        });
        sock.on("error", () => resolve(data));
        sock.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
      });
    const post = (path: string, len: number) => `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Length: ${len}\r\n\r\n`;

    test("20 MB passes on /file; past its cap is 413, and 16 KB + 1 on /message still is", async () => {
      assert.match(await raw(post(`/api/h/${T}/file`, 20 * MB), Buffer.alloc(20 * MB, 1)), /^HTTP\/1\.1 200/);
      assert.match(await raw(post(`/api/h/${T}/file`, FILE_BODY_MAX + 1)), /^HTTP\/1\.1 413/);
      assert.match(await raw(post(`/api/h/${T}/message`, 16 * 1024 + 1)), /^HTTP\/1\.1 413/);
      assert.match(await raw(post(`/api/h/${T}/image`, 11 * MB)), /^HTTP\/1\.1 413/, "the photo cap is unchanged");
    });

    test("each upload has its own time: a slow file body outlives the photo's timer, a slow photo body doesn't", async () => {
      assert.match(await raw(post(`/api/h/${T}/file`, 10), Buffer.alloc(10, 1), 700), /^HTTP\/1\.1 200/);
      assert.match(await raw(post(`/api/h/${T}/image`, 10), Buffer.alloc(10, 1), 700), /^HTTP\/1\.1 408/);
      assert.match(await raw(post(`/api/h/${T}/message`, 10), Buffer.alloc(10, 1), 700), /^HTTP\/1\.1 408/);
    });
  });
});

describe("the gathering model", () => {
  test("inspect_files runs a command on the file the person sent", async () => {
    const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
    mkdirSync(join(root, "proj"));
    const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
    const alex = await orgs.addPerson(org.id, { name: "Alex Rivera", role: "Data" });
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: alex.id, publicTitle: "The latest dump", goal: "Get Alex's latest JSON dump", abilities: { files: true } });
    const chat = await acquireChat(c.path);
    Object.defineProperty(piSession(chat), "model", { configurable: true, get: () => ({ provider: "fake", id: "m", input: ["text"] }) });
    (piSession(chat) as unknown as { prompt: unknown }).prompt = async () => {};
    const share = createShareApp();
    const dump = Buffer.from(JSON.stringify({ exportedAt: "2026-10-01", records: [{ id: 1, at: "2026-09-30" }, { id: 2, at: "2026-09-12" }] }));
    const up = await share.request(`/api/h/${c.token}/file`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(dump.length), "X-File-Name": "dump.json" }, body: new Uint8Array(dump) });
    assert.equal(up.status, 201);
    const id = ((await up.json()) as { id: string }).id;
    const sent = await share.request(`/api/h/${c.token}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "", files: [id] }) });
    assert.ok(sent.ok, String(sent.status));
    const out = await inspectFilesTool(c.sessionId).execute("t", { command: "jq '.records | length' dump.json" }, undefined, undefined, undefined);
    assert.match((out.content[0] as { text: string }).text, /\n2\n/);
  });
});
