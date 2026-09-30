// Run: pnpm exec tsx --test server/baton-images.test.ts. A person's photos in a gathering chat
// (§app.baton/images): the edge's routes, cap and timer, the metadata stripper, the staging area,
// the upload and message routes, the view's photo numbering, the photo route's headers, the
// author notes, the prompt and the operator's own images. A throwaway PI_CODING_AGENT_DIR in the
// OS temp dir; ~/.pi untouched. No model is called: `session.prompt` is a stand-in.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { BATON_OFFER_ENTRY, BATON_SENT_ENTRY, BATON_WRAPUP_ENTRY, MB, OPERATOR, PHOTO_DEFAULTS, type BatonView } from "../shared/baton";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-images-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_SHARE_PUBLIC_URL;
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const settings = await import("./baton-settings");
const images = await import("./baton-images");
const { PHOTOS_OFF, PHOTOS_ON, renderBatonPrompt } = await import("./baton-loadout");
const { acquireChat, BusyError, disposeAllChats } = await import("./chat-manager");
const { createShareApp } = await import("./share/routes");
const { createShareServer } = await import("./share/listener");
const { bodyMaxFor, shareMayReach, UPLOAD_BODY_MAX } = await import("./share/edge");
const { viewForToken } = await import("./share/hub");
const { routeOf } = await import("./share/router");
const { authorNotes, batonView, labelAuthors } = await import("./baton-view");
const { sessionAttachmentsDir } = await import("./attachments");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });
const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll" });
const start = (to: string | string[], extra: Record<string, unknown> = {}) => baton.createBaton({ orgId: org.id, projectId: project.id, to, publicTitle: "Hosting", goal: "Find the server", ...extra });
const share = createShareApp();

// 8×8 fixtures written by PIL, each with EXIF: orientation 6, a camera make and a GPS IFD.
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4QCsRXhpZgAATU0AKgAAAAgAAwEPAAIAAAALAAAAMgESAAMAAAABAAYAAIglAAQAAAABAAAAPgAAAABGaXh0dXJlQ2FtAAAABAABAAIAAAACTgAAAAACAAUAAAADAAAAdAADAAIAAAACVwAAAAAEAAUAAAADAAAAjAAAAAAAAAAzAAAAAQAAAB4AAAABAAAAAAAAAAEAAAAAAAAAAQAAAAcAAAABAAAAAAAAAAH/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDBooor5w/QD//Z",
  "base64",
);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAApGVYSWZNTQAqAAAACAADAQ8AAgAAAAsAAAAyARIAAwAAAAEABgAAiCUABAAAAAEAAAA+AAAAAEZpeHR1cmVDYW0AAAAEAAEAAgAAAAJOAAAAAAIABQAAAAMAAAB0AAMAAgAAAAJXAAAAAAQABQAAAAMAAACMAAAAAAAAADMAAAABAAAAHgAAAAEAAAAAAAAAAQAAAAAAAAABAAAABwAAAAEAAAAAAAAAAeD/T7UAAAAUSURBVHicYzxhI8eADTBhFR20EgDn/gEyBvIzqQAAAABJRU5ErkJggg==",
  "base64",
);
const WEBP = Buffer.from(
  "UklGRtwAAABXRUJQVlA4WAoAAAAIAAAABwAABwAAVlA4TBEAAAAvB8ABAAdQniLXo/+BiOh/AABFWElGpAAAAE1NACoAAAAIAAMBDwACAAAACwAAADIBEgADAAAAAQAGAACIJQAEAAAAAQAAAD4AAAAARml4dHVyZUNhbQAAAAQAAQACAAAAAk4AAAAAAgAFAAAAAwAAAHQAAwACAAAAAlcAAAAABAAFAAAAAwAAAIwAAAAAAAAAMwAAAAEAAAAeAAAAAQAAAAAAAAABAAAAAAAAAAEAAAAHAAAAAQAAAAAAAAAB",
  "base64",
);
/** What EXIF carries in every fixture: the make (and, beside it, the GPS IFD). */
const MARK = Buffer.from("FixtureCam");
const T = "A".repeat(43);

/** The runtime's model, as the photo check reads it. */
function withModel(chat: Awaited<ReturnType<typeof acquireChat>>, input: string[]): void {
  Object.defineProperty(chat.session, "model", { configurable: true, get: () => ({ provider: "fake", id: "m", input }) });
}
/** session.prompt as a recorder of what the runtime was handed. */
function capture(chat: Awaited<ReturnType<typeof acquireChat>>): { text: string; images?: { type: string; data: string; mimeType: string }[] }[] {
  const got: { text: string; images?: { type: string; data: string; mimeType: string }[] }[] = [];
  (chat.session as unknown as { prompt: unknown }).prompt = async (text: string, opts?: { images?: { type: string; data: string; mimeType: string }[] }) => {
    got.push({ text, ...(opts?.images ? { images: opts.images } : {}) });
  };
  return got;
}
const upload = (token: string, body: Buffer, type = "image/jpeg") =>
  share.request(`/api/h/${token}/image`, { method: "POST", headers: { "Content-Type": type, "Content-Length": String(body.length) }, body: new Uint8Array(body) });
const message = (token: string, body: unknown) => share.request(`/api/h/${token}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
/** A session holding Tony, its runtime open on a model with `input`. */
async function session(input = ["text", "image"]) {
  const c = await start(tony.id);
  const chat = await acquireChat(c.path);
  withModel(chat, input);
  return { c, chat, got: capture(chat) };
}
const staged = (sessionId: string) => {
  const dir = join(images.uploadsRoot(), sessionId);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

describe("the edge", () => {
  test("the photo routes are allowed only as exact shapes", () => {
    assert.ok(shareMayReach("POST", `/api/h/${T}/image`));
    for (const n of ["0", "7", "9999"]) assert.ok(shareMayReach("GET", `/api/h/${T}/img/${n}`), n);
    assert.ok(shareMayReach("HEAD", `/api/h/${T}/img/0`));
    for (const [m, p] of [
      ["GET", `/api/h/${T}/image`],
      ["PUT", `/api/h/${T}/image`],
      ["POST", `/api/h/${T}/img/0`],
      ["GET", `/api/h/${T}/img/01`],
      ["GET", `/api/h/${T}/img/10000`],
      ["GET", `/api/h/${T}/img/-1`],
      ["GET", `/api/h/${T}/img/`],
      ["POST", `/api/h/${T}/image/`],
      ["POST", `/api/h/${T}/../${T}/image`],
      ["POST", `/api/h/${T}/%69mage`],
      ["GET", `/api/h/${T}/img/%30`],
      ["GET", `/api/h/${T}/./img/0`],
    ] as const)
      assert.equal(shareMayReach(m, p), false, `${m} ${p}`);
  });

  test("the body cap is per route: the upload's own, 16 KB for everything else", () => {
    assert.equal(bodyMaxFor(`/api/h/${T}/message`), 16 * 1024);
    assert.equal(bodyMaxFor(`/api/h/${T}/image`), UPLOAD_BODY_MAX);
    assert.ok(UPLOAD_BODY_MAX >= 10 * MB);
  });

  describe("on a listener", async () => {
    const answered: string[] = [];
    const server = createShareServer({
      headersMs: 300,
      requestMs: 300,
      checkMs: 50,
      dispatch: (req, res) => {
        let n = 0;
        req.on("data", (d: Buffer) => (n += d.length));
        req.on("end", () => {
          answered.push(`${req.method} ${n}`);
          res.writeHead(200, { "Content-Type": "text/plain" }).end(String(n));
        });
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
    /** Raw HTTP: `head` then, after `wait` ms, `body`. Resolves the reply's status line. */
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
    const post = (path: string, len: number) => `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: image/jpeg\r\nContent-Length: ${len}\r\n\r\n`;

    test("5 MB passes on /image; 16 KB + 1 on /message and past the upload cap on /image are 413", async () => {
      assert.match(await raw(post(`/api/h/${T}/image`, 5 * MB), Buffer.alloc(5 * MB, 1)), /^HTTP\/1\.1 200/);
      assert.match(await raw(post(`/api/h/${T}/message`, 16 * 1024 + 1)), /^HTTP\/1\.1 413/);
      assert.match(await raw(post(`/api/h/${T}/image`, UPLOAD_BODY_MAX + 1)), /^HTTP\/1\.1 413/);
      assert.match(await raw(`POST /api/h/${T}/image HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n`), /^HTTP\/1\.1 413/, "a length is still required");
    });

    test("the upload has its own time: a slow photo body is not cut at the page's timer, a slow message body is", async () => {
      assert.match(await raw(post(`/api/h/${T}/image`, 10), Buffer.alloc(10, 1), 700), /^HTTP\/1\.1 200/);
      assert.match(await raw(post(`/api/h/${T}/message`, 10), Buffer.alloc(10, 1), 700), /^HTTP\/1\.1 408/);
    });

    test("photo reads count in their own per-address bucket, never the page's 60", async () => {
      const get = (path: string) => raw(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`);
      for (let i = 0; i < 70; i++) assert.match(await get(`/api/h/${T}/img/${i}`), /^HTTP\/1\.1 200/, `read ${i}`);
      assert.match(await get(`/api/h/${T}`), /^HTTP\/1\.1 200/, "the page's own budget is untouched");
    });
  });

  test("the gateway routes the photo paths as the link's own (an `h` row)", () => {
    assert.deepEqual(routeOf(`/api/h/${T}/image`), { kind: "h", token: T });
    assert.deepEqual(routeOf(`/api/h/${T}/img/12`), { kind: "h", token: T });
    assert.equal(routeOf(`/api/h/${T}/img/01`), null);
  });
});

describe("the metadata stripper", () => {
  const decodes = async (b: Buffer, mime: string) => (await resizeImage(new Uint8Array(b), mime, { maxWidth: 4, maxHeight: 4 }))?.originalWidth;

  test("a JPEG with GPS EXIF comes out with none of it, and still decodes", async () => {
    assert.ok(JPEG.includes(MARK) && JPEG.includes(Buffer.from("Exif\0\0")));
    const out = images.stripImageMetadata(JPEG, "image/jpeg")!;
    assert.ok(out && !out.includes(MARK) && !out.includes(Buffer.from("Exif\0\0")));
    assert.deepEqual([out[0], out[1], out.at(-2), out.at(-1)], [0xff, 0xd8, 0xff, 0xd9]);
    assert.equal(await decodes(out, "image/jpeg"), 8);
  });

  test("PNG loses eXIf; WebP loses EXIF, its RIFF size and VP8X flags fixed; both still decode", async () => {
    const png = images.stripImageMetadata(PNG, "image/png")!;
    assert.ok(PNG.includes(Buffer.from("eXIf")) && !png.includes(Buffer.from("eXIf")) && !png.includes(MARK));
    assert.equal(await decodes(png, "image/png"), 8);
    const webp = images.stripImageMetadata(WEBP, "image/webp")!;
    assert.ok(!webp.includes(Buffer.from("EXIF")) && !webp.includes(MARK));
    assert.equal(webp.readUInt32LE(4), webp.length - 8, "RIFF size");
    assert.equal(webp[20]! & 0x0c, 0, "VP8X EXIF/XMP flags cleared");
    assert.equal(await decodes(webp, "image/webp"), 8);
  });

  test("a file that doesn't parse as its type is null", () => {
    assert.equal(images.stripImageMetadata(Buffer.from("not an image"), "image/jpeg"), null);
    assert.equal(images.stripImageMetadata(JPEG.subarray(0, 40), "image/jpeg"), null);
    assert.equal(images.stripImageMetadata(PNG.subarray(0, 20), "image/png"), null);
  });
});

describe("the staging area", () => {
  async function* chunks(...parts: Buffer[]) {
    for (const p of parts) yield new Uint8Array(p);
  }
  test("a body past the cap is refused while it streams and leaves no file", async () => {
    const sid = "01a0ffff-0000-7000-8000-000000000001";
    await assert.rejects(
      images.stagePhoto({ sessionId: sid, personId: "p", mime: "image/jpeg", body: chunks(JPEG, JPEG), maxBytes: JPEG.length + 10 }),
      (e: InstanceType<typeof images.PhotoRefusal>) => e.status === 413,
    );
    assert.deepEqual(staged(sid), []);
  });
  test("bytes that aren't the declared type are a 400 and leave no file", async () => {
    const sid = "01a0ffff-0000-7000-8000-000000000002";
    await assert.rejects(images.stagePhoto({ sessionId: sid, personId: "p", mime: "image/png", body: chunks(JPEG), maxBytes: MB }), (e: InstanceType<typeof images.PhotoRefusal>) => e.status === 400);
    assert.deepEqual(staged(sid), []);
  });
  test("the host budget and the free-disk floor refuse with 507", () => {
    assert.throws(() => images.assertBudget(10, { maxBytes: 100, freeFloor: 0 }, 1e12, 95), (e: InstanceType<typeof images.PhotoRefusal>) => e.status === 507);
    assert.throws(() => images.assertBudget(10, { maxBytes: 1e9, freeFloor: 2000 }, 2005, 0), (e: InstanceType<typeof images.PhotoRefusal>) => e.status === 507);
    images.assertBudget(10, { maxBytes: 1e9, freeFloor: 2000 }, 1e9, 0);
  });
  test("the sweep removes old photos and every photo of a session that isn't open", () => {
    const sweepRoot = join(root, "sweep");
    mkdirSync(join(sweepRoot, "open-one"), { recursive: true });
    mkdirSync(join(sweepRoot, "closed-one"), { recursive: true });
    writeFileSync(join(sweepRoot, "open-one", "im_new.jpg"), "x");
    writeFileSync(join(sweepRoot, "closed-one", "im_a.jpg"), "x");
    const later = Date.now() + images.STAGED_TTL_MS + 1000;
    assert.equal(images.sweepUploads(Date.now(), sweepRoot, (s) => s === "open-one"), 1);
    assert.deepEqual(readdirSync(sweepRoot), ["open-one"]);
    images.sweepUploads(later, sweepRoot, () => true);
    assert.deepEqual(readdirSync(sweepRoot), [], "a day later the photo and its empty folder are gone");
  });
});

describe("the upload route", () => {
  test("a writing link with a vision model stages the photo, metadata stripped, 0600", async () => {
    images.resetUploadWindows();
    const { c } = await session();
    const res = await upload(c.token!, JPEG);
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string; size: number; mime: string };
    assert.match(body.id, /^im_[A-Za-z0-9_-]{16}$/);
    assert.equal(body.mime, "image/jpeg");
    const files = staged(c.sessionId);
    assert.deepEqual(files, [`${body.id}.jpg`, `${body.id}.json`]);
    const bytes = readFileSync(join(images.uploadsRoot(), c.sessionId, `${body.id}.jpg`));
    assert.ok(!bytes.includes(MARK), "no EXIF on disk");
    assert.equal((await import("node:fs")).statSync(join(images.uploadsRoot(), c.sessionId, `${body.id}.jpg`)).mode & 0o777, 0o600);
  });

  test("refusals: a model without vision, photos off, not the holder, a wrong type, too large, too many, no room", async () => {
    images.resetUploadWindows();
    const text = await session(["text"]);
    assert.deepEqual([(await upload(text.c.token!, JPEG)).status, ((await (await upload(text.c.token!, JPEG)).json()) as { code: string }).code], [409, "no-photos"]);

    const { c } = await session();
    settings.writeBatonSettings({ messagesMax: 60, photos: { ...PHOTO_DEFAULTS, enabled: false } });
    assert.equal(((await (await upload(c.token!, JPEG)).json()) as { code: string }).code, "no-photos");
    settings.writeBatonSettings({ messagesMax: 60, photos: { ...PHOTO_DEFAULTS, maxBytes: MB } });

    assert.equal((await upload(c.token!, JPEG, "image/svg+xml")).status, 400);
    assert.equal((await upload(c.token!, JPEG, "image/png")).status, 400, "magic bytes must match the declared type");
    assert.equal((await upload(c.token!, Buffer.alloc(MB + 1, 1))).status, 413, "past this host's own largest photo");

    process.env.SOVA_BATON_UPLOADS_MAX_MB = "0";
    const full = await upload(c.token!, JPEG);
    delete process.env.SOVA_BATON_UPLOADS_MAX_MB;
    assert.deepEqual([full.status, ((await full.json()) as { error: string }).error], [507, "Photos can't be taken right now."]);

    images.resetUploadWindows();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await upload(c.token!, JPEG)).status);
    assert.deepEqual([statuses.slice(0, 20).every((s) => s === 201), statuses[20]], [true, 429]);

    await baton.handTo(c.sessionId, maria.id, "over to Maria", "");
    images.resetUploadWindows();
    const moved = await upload(c.token!, JPEG);
    assert.deepEqual([moved.status, ((await moved.json()) as { code: string }).code], [409, "moved-on"], "a link that no longer writes");
    settings.writeBatonSettings({ messagesMax: 60, photos: PHOTO_DEFAULTS });
  });

  test("the view offers the paperclip only while the link writes and the model sees images", async () => {
    const vision = await session();
    assert.deepEqual(((await viewForToken(vision.c.token!)) as BatonView).viewer?.photos, { perMessage: 4, maxBytes: 5 * MB });
    const text = await session(["text"]);
    assert.equal(((await viewForToken(text.c.token!)) as BatonView).viewer?.photos, undefined);
    await baton.handTo(vision.c.sessionId, maria.id, "q", "");
    assert.equal(((await viewForToken(vision.c.token!)) as BatonView).viewer?.photos, undefined);
  });
});

describe("sending photos", () => {
  test("ids become image content for the runtime, single use; the staged copies go", async () => {
    images.resetUploadWindows();
    const { c, got } = await session();
    const a = ((await (await upload(c.token!, JPEG)).json()) as { id: string }).id;
    const b = ((await (await upload(c.token!, PNG, "image/png")).json()) as { id: string }).id;
    const res = await message(c.token!, { text: "here", images: [a, b] });
    assert.equal(res.status, 202);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(got.length, 1);
    assert.equal(got[0]!.text, "here");
    assert.deepEqual(
      got[0]!.images!.map((i) => [i.type, i.mimeType]),
      [
        ["image", "image/jpeg"],
        ["image", "image/png"],
      ],
    );
    assert.ok(!Buffer.from(got[0]!.images![0]!.data, "base64").includes(MARK));
    assert.deepEqual(staged(c.sessionId), []);
    const again = await message(c.token!, { text: "", images: [a] });
    assert.deepEqual([again.status, ((await again.json()) as { code: string }).code], [409, "photo-expired"]);
  });

  test("a message of photos alone is taken; too many, unknown ids and bad shapes are refused", async () => {
    images.resetUploadWindows();
    const { c, got } = await session();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(((await (await upload(c.token!, JPEG)).json()) as { id: string }).id);
    assert.equal((await message(c.token!, { text: "", images: ids })).status, 400, "5 > 4 per message");
    assert.equal((await message(c.token!, { text: "x", images: "im_x" })).status, 400);
    assert.equal((await message(c.token!, { text: "x", images: [ids[0], ids[0]] })).status, 400, "an id twice");
    assert.equal(((await (await message(c.token!, { images: ["im_AAAAAAAAAAAAAAAA"] })).json()) as { code: string }).code, "photo-expired");
    assert.equal((await message(c.token!, { images: [ids[0]] })).status, 202);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([got.at(-1)!.text, got.at(-1)!.images!.length], ["", 1]);
  });

  test("a runtime refusal keeps the staged photos for the retry", async () => {
    images.resetUploadWindows();
    const { c, chat } = await session();
    const id = ((await (await upload(c.token!, JPEG)).json()) as { id: string }).id;
    const guard = chat.assertNoForeignWrites.bind(chat);
    chat.assertNoForeignWrites = () => {
      throw new BusyError("Someone else wrote this session.", "recent");
    };
    assert.equal((await message(c.token!, { text: "x", images: [id] })).status, 503);
    chat.assertNoForeignWrites = guard;
    assert.deepEqual(staged(c.sessionId), [`${id}.jpg`, `${id}.json`]);
  });

  test("the conversation's photo limit, and a model without vision refuses photos in a message", async () => {
    images.resetUploadWindows();
    const { c, chat } = await session();
    const id = ((await (await upload(c.token!, JPEG)).json()) as { id: string }).id;
    settings.writeBatonSettings({ messagesMax: 60, photos: { ...PHOTO_DEFAULTS, perConversation: 1 } });
    chat.session.sessionManager.appendMessage({ role: "user", content: [{ type: "image", data: JPEG.toString("base64"), mimeType: "image/jpeg" }], timestamp: Date.now() } as never);
    const res = await message(c.token!, { text: "", images: [id] });
    assert.deepEqual([res.status, ((await res.json()) as { error: string }).error], [409, "This conversation has reached its photo limit."]);
    settings.writeBatonSettings({ messagesMax: 60, photos: PHOTO_DEFAULTS });
    withModel(chat, ["text"]);
    assert.equal(((await (await message(c.token!, { text: "", images: [id] })).json()) as { code: string }).code, "no-photos");
  });
});

describe("the view and the photo route", () => {
  const img = (tag: string) => ({ type: "image", data: Buffer.from(tag).toString("base64"), mimeType: "image/png" });
  const user = (id: string, content: unknown[]) => ({ type: "message", id, timestamp: "2026-09-30T00:00:00.000Z", message: { role: "user", content, timestamp: 1 } });
  const branch = [
    user("u1", [{ type: "text", text: "two of them\n\n[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]" }, img("a"), img("b")]),
    { type: "custom", id: "s1", customType: BATON_SENT_ENTRY, data: { targetId: "u1", by: tony.id } },
    { type: "custom", id: "o1", customType: BATON_OFFER_ENTRY, data: { n: 2, from: tony.id, to: [tony.id, maria.id], question: "q" } },
    user("u2", [{ type: "text", text: "" }, img("c")]),
    { type: "custom", id: "s2", customType: BATON_SENT_ENTRY, data: { targetId: "u2", by: maria.id } },
    { type: "custom", id: "w1", customType: BATON_WRAPUP_ENTRY, data: {} },
    user("u3", [img("d")]),
  ];
  const view = (untilOffer?: number) => {
    const collect: { data: string; mimeType: string }[] = [];
    const v = batonView({ row: { publicTitle: "T", state: "open", holder: maria.id }, branch, names: { [tony.id]: "Tony", [maria.id]: "Maria" }, viewer: tony.id, redact: (t) => t, collect, ...(untilOffer ? { untilOffer } : {}) });
    return { v, collect: collect.map((c) => Buffer.from(c.data, "base64").toString()) };
  };

  test("photos are numbered in view order; an offer cut and the wrap-up apply to them as to text; notes are not shown", () => {
    const whole = view();
    const msgs = whole.v.items.filter((i) => i.kind === "message") as { text: string; images?: { n: number }[] }[];
    assert.deepEqual(
      msgs.map((m) => [m.text, m.images?.map((i) => i.n)]),
      [
        ["two of them", [0, 1]],
        ["", [2]],
      ],
      "a photo-only message is a row; nothing after the wrap-up",
    );
    assert.deepEqual(whole.collect, ["a", "b", "c"]);
    const cut = view(2);
    assert.deepEqual(cut.collect, ["a", "b"], "an invitee who never held the offer sees photos only up to it");
  });

  test("the author note opens an image-only message and its image stays", () => {
    const notes = authorNotes(branch as never, { [tony.id]: "Tony", [maria.id]: "Maria" }, maria.id);
    const ctx = [{ role: "user", content: [{ type: "text", text: "" }, img("c")], timestamp: 1 }];
    const out = labelAuthors(ctx, notes.slice(1));
    assert.deepEqual(
      (out[0] as { content: { type: string; text?: string }[] }).content.map((b) => b.type),
      ["text", "text", "image"],
    );
    assert.match((out[0] as { content: { text?: string }[] }).content[0]!.text!, /\[From Maria\]/);
  });

  test("GET /img/<n> serves the link's own view's photo with its own CSP; out of range 404; a dead link 410", async () => {
    const c = await start(tony.id);
    const file = c.path;
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const last = JSON.parse(lines.at(-1)!) as { id?: string };
    appendFileSync(file, `${JSON.stringify({ type: "message", id: "img00001", parentId: last.id ?? null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: PNG.toString("base64"), mimeType: "image/png" }], timestamp: Date.now() } })}\n`);
    const res = await share.request(`/api/h/${c.token}/img/0`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("content-disposition"), "inline");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
    assert.equal((await share.request(`/api/h/${c.token}/img/1`)).status, 404);
    await baton.closeBaton(c.sessionId);
    assert.equal((await share.request(`/api/h/${c.token}/img/0`)).status, 410);
  });
});

describe("the gathering model and the operator", () => {
  test("the prompt says photos can be sent only when they can", async () => {
    const c = await start(tony.id);
    const on = renderBatonPrompt(c.sessionId, undefined, true);
    const off = renderBatonPrompt(c.sessionId);
    assert.ok(on.includes(PHOTOS_ON) && !on.includes(PHOTOS_OFF));
    assert.ok(off.includes(PHOTOS_OFF) && !off.includes(PHOTOS_ON));
  });

  test("the operator's attached image goes inline and its path line leaves the text; other paths stay", async () => {
    const sid = "01a0eeee-0000-7000-8000-000000000001";
    const dir = sessionAttachmentsDir(sid)!;
    mkdirSync(dir, { recursive: true });
    const own = join(dir, "sova-11111111-1111-4111-8111-111111111111.png");
    writeFileSync(own, PNG);
    const other = join(sessionAttachmentsDir("01a0eeee-0000-7000-8000-000000000002")!, "sova-22222222-2222-4222-8222-222222222222.png");
    mkdirSync(join(other, ".."), { recursive: true });
    writeFileSync(other, PNG);
    const out = images.inlineOperatorImages(sid, `Look at this\n${own}\n${other}`);
    assert.equal(out.images.length, 1);
    assert.equal(out.images[0]!.mimeType, "image/png");
    assert.equal(out.text, `Look at this\n${other}`);
    assert.deepEqual(images.inlineOperatorImages(sid, "no paths here"), { text: "no paths here", images: [] });
  });

  test("a baton session's composer sends the operator's image inline (no path reaches the model)", async () => {
    const c = await start(OPERATOR);
    const chat = await acquireChat(c.path);
    const got = capture(chat);
    const dir = sessionAttachmentsDir(chat.session.sessionId)!;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "sova-33333333-3333-4333-8333-333333333333.jpg");
    writeFileSync(file, JPEG);
    chat.handle({ send: () => {} } as never, { type: "prompt", text: `what is this?\n${file}`, clientId: "k1" } as never);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(got.length, 1);
    assert.equal(got[0]!.text, "what is this?");
    assert.equal(got[0]!.images?.[0]?.mimeType, "image/jpeg");
  });

  test("settings: each photo field reads on its own; a write is validated", () => {
    const file = join(root, "agent", "sova", "baton-settings.json");
    writeFileSync(file, JSON.stringify({ messagesMax: 60, photos: { enabled: false, perMessage: 99, maxBytes: 3 * MB, perConversation: "x" } }));
    assert.deepEqual(settings.readBatonSettings().photos, { enabled: false, perMessage: 4, maxBytes: 3 * MB, perConversation: 40 });
    for (const bad of [{ enabled: "yes" }, { perMessage: 0 }, { maxBytes: 11 * MB }, { maxBytes: 1.5 * MB }, { perConversation: 201 }])
      assert.ok("error" in settings.writeBatonSettings({ messagesMax: 60, photos: { ...PHOTO_DEFAULTS, ...bad } }), JSON.stringify(bad));
    settings.writeBatonSettings({ messagesMax: 60, photos: PHOTO_DEFAULTS });
    assert.deepEqual(settings.readBatonSettings().photos, PHOTO_DEFAULTS);
  });
});
