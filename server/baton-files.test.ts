// Run: pnpm test -- server/baton-files.test.ts. A person's files in a gathering chat
// (§app.baton/files, §app/file-intake): the edge's route, cap and timer, the gateway's hop rule,
// the upload and message routes, the transcript line and the view's rows, the gathering model's
// tools and prompt. A throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi untouched. No model
// is called: `session.prompt` is a stand-in. A real share listener and a command run by
// inspect_files are baton-files.integration.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { MB, type BatonView } from "../shared/baton";
import { piSession } from "./harness/pi/testing/handle";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-files-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_SHARE_PUBLIC_URL;
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const settings = await import("./baton-settings");
const files = await import("./project-files");
const { FILES_ON, inspectFilesTool, confirmFileTool } = await import("./baton-files");
const { renderBatonPrompt, activeBatonTools, LOADOUT_TOOLS } = await import("./baton-loadout");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { createShareApp } = await import("./share/routes");
const { bodyMaxFor, FILE_BODY_MAX, FILE_UPLOAD_TIMEOUT_MS, shareMayReach } = await import("./share/edge");
const { viewForToken } = await import("./share/hub");
const { routeOf } = await import("./share/router");
const { batonView } = await import("./baton-view");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const alex = await orgs.addPerson(org.id, { name: "Alex Rivera", role: "Data" });
const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll" });
const start = (to: string, extra: Record<string, unknown> = {}) => baton.createBaton({ orgId: org.id, projectId: project.id, to, publicTitle: "The latest dump", goal: "Get Alex's latest JSON dump", ...extra });
const share = createShareApp();
const T = "A".repeat(43);

function withModel(chat: Awaited<ReturnType<typeof acquireChat>>, input: string[]): void {
  Object.defineProperty(piSession(chat), "model", { configurable: true, get: () => ({ provider: "fake", id: "m", input }) });
}
function capture(chat: Awaited<ReturnType<typeof acquireChat>>): { text: string; images?: unknown[] }[] {
  const got: { text: string; images?: unknown[] }[] = [];
  (piSession(chat) as unknown as { prompt: unknown }).prompt = async (text: string, opts?: { images?: unknown[] }) => {
    got.push({ text, ...(opts?.images ? { images: opts.images } : {}) });
  };
  return got;
}
/** A session holding Alex, its runtime open on a model with `input`; file intake on unless `intake` is false. */
async function session(input = ["text"], intake = true) {
  const c = await start(alex.id, intake ? { abilities: { files: true } } : {});
  const chat = await acquireChat(c.path);
  withModel(chat, input);
  return { c, chat, got: capture(chat) };
}
const upload = (token: string, body: Buffer, name = "dump.json", type = "application/json") =>
  share.request(`/api/h/${token}/file`, { method: "POST", headers: { "Content-Type": type, "Content-Length": String(body.length), "X-File-Name": encodeURIComponent(name) }, body: new Uint8Array(body) });
const message = (token: string, body: unknown) => share.request(`/api/h/${token}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const code = async (r: Response) => ((await r.json()) as { code?: string }).code;
const DUMP = Buffer.from(JSON.stringify({ exportedAt: "2026-10-01", records: [{ id: 1, at: "2026-09-30" }, { id: 2, at: "2026-09-12" }] }));
const projectDir = () => join(files.filesRoot(), project.id);
const fileDirs = () => (existsSync(projectDir()) ? readdirSync(projectDir()).filter((n) => n.startsWith("f_")) : []);

describe("the edge and the gateway", () => {
  test("the file route is allowed only as its exact shape, POST", () => {
    assert.ok(shareMayReach("POST", `/api/h/${T}/file`));
    for (const [m, p] of [
      ["GET", `/api/h/${T}/file`],
      ["PUT", `/api/h/${T}/file`],
      ["POST", `/api/h/${T}/file/`],
      ["POST", `/api/h/${T}/files`],
      ["POST", `/api/h/${T}/%66ile`],
      ["POST", `/api/h/${T}/../${T}/file`],
      ["GET", `/api/h/${T}/file/f_AAAAAAAAAAAAAAAA`],
    ] as const)
      assert.equal(shareMayReach(m, p), false, `${m} ${p}`);
  });

  test("the body cap is per route: the file upload's own (25 MB + slack), 16 KB still on /message", () => {
    assert.equal(bodyMaxFor(`/api/h/${T}/message`), 16 * 1024);
    assert.equal(bodyMaxFor(`/api/h/${T}/file`), FILE_BODY_MAX);
    assert.equal(FILE_BODY_MAX, 25 * MB + 64 * 1024);
    assert.equal(FILE_UPLOAD_TIMEOUT_MS, 300_000);
  });

  test("the gateway routes the file path as the link's own (an `h` row)", () => {
    assert.deepEqual(routeOf(`/api/h/${T}/file`), { kind: "h", token: T });
    assert.equal(routeOf(`/api/h/${T}/files`), null);
  });
});

describe("the upload route", () => {
  test("a writing link with intake on keeps the file, 0600 in a 0700 folder, its name from the header; a text-only model is fine", async () => {
    files.resetFileUploadWindow();
    const { c } = await session(["text"]);
    const res = await upload(c.token!, DUMP, "exports/../Alex's dump.json");
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string; name: string; size: number; kind: string };
    assert.match(body.id, /^f_[A-Za-z0-9_-]{16}$/);
    assert.deepEqual([body.name, body.size, body.kind], ["Alex's dump.json", DUMP.length, "JSON"]);
    const dir = join(projectDir(), body.id);
    assert.deepEqual(readdirSync(dir).sort(), [".meta.json", "Alex's dump.json"]);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "Alex's dump.json")).mode & 0o777, 0o600);
    assert.ok(readFileSync(join(dir, "Alex's dump.json")).equals(DUMP));
    assert.equal(files.readLedger(project.id).find((r) => r.id === body.id), undefined, "staged: no ledger line yet");
  });

  test("refusals: intake off, not the holder, too large (nothing kept), the person's limits, the rate, no room", async () => {
    files.resetFileUploadWindow();
    const off = await session(["text", "image"], false);
    const r0 = await upload(off.c.token!, DUMP);
    assert.deepEqual([r0.status, await code(r0)], [409, "no-files"]);

    const { c } = await session();
    settings.writeBatonSettings({ messagesMax: 60, files: { maxBytes: MB } });
    const before = fileDirs().length;
    const big = await upload(c.token!, Buffer.alloc(MB + 1, 1), "big.bin");
    assert.deepEqual([big.status, ((await big.json()) as { error: string }).error], [413, "Over 1 MB."]);
    assert.equal(fileDirs().length, before, "nothing kept");
    settings.writeBatonSettings({ messagesMax: 60, files: { maxBytes: 25 * MB } });

    process.env.SOVA_PROJECT_FILES_MAX_MB = "0";
    const full = await upload(c.token!, DUMP);
    delete process.env.SOVA_PROJECT_FILES_MAX_MB;
    assert.deepEqual([full.status, ((await full.json()) as { error: string }).error], [507, "Files can't be taken right now."]);
    process.env.SOVA_PROJECT_FILES_FREE_MB = String(1024 * 1024 * 1024);
    const floor = await upload(c.token!, DUMP);
    delete process.env.SOVA_PROJECT_FILES_FREE_MB;
    assert.equal(floor.status, 507, "the free-disk floor");

    files.resetFileUploadWindow();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await upload(c.token!, DUMP, `d${i}.json`)).status);
    assert.deepEqual([statuses.slice(0, 10).every((s) => s === 201), statuses[10]], [true, 429], "10 a minute per link");
    files.resetFileUploadWindow();
    for (let i = 0; i < 10; i++) assert.equal((await upload(c.token!, DUMP, `e${i}.json`)).status, 201);
    files.resetFileUploadWindow();
    const most = await upload(c.token!, DUMP, "21st.json");
    assert.deepEqual([most.status, await code(most)], [409, "file-limit"], "20 files per person in a session");

    await baton.handTo(c.sessionId, maria.id, "over to Maria", "");
    files.resetFileUploadWindow();
    const moved = await upload(c.token!, DUMP);
    assert.deepEqual([moved.status, await code(moved)], [409, "moved-on"], "a link that no longer writes");
  });

  test("uploads in flight count against the person's room: nine 25 MB uploads at once on one link can't pass 200 MB", async () => {
    files.resetFileUploadWindow();
    const { c } = await session();
    const big = Buffer.alloc(25 * MB, 7);
    const answers = await Promise.all(Array.from({ length: 9 }, (_, i) => upload(c.token!, big, `part${i}.bin`, "application/octet-stream")));
    const statuses = await Promise.all(answers.map(async (r) => [r.status, r.status === 201 ? "" : await code(r)] as const));
    assert.ok(statuses.some(([s, k]) => s === 409 && k === "file-limit"), JSON.stringify(statuses));
    assert.ok(statuses.filter(([s]) => s === 201).length <= 8, JSON.stringify(statuses));
    assert.deepEqual(files.inflightFor(project.id, c.sessionId, alex.id), { files: 0, bytes: 0 }, "every reservation released");
  });

  test("two files of one session never share a name", async () => {
    files.resetFileUploadWindow();
    const { c } = await session();
    const names: string[] = [];
    for (let i = 0; i < 3; i++) names.push(((await (await upload(c.token!, DUMP, "dump.json")).json()) as { name: string }).name);
    assert.deepEqual(names, ["dump.json", "dump (2).json", "dump (3).json"]);
  });

  test("the view offers files only while the link writes and the session takes them, whatever the model sees", async () => {
    const on = await session(["text"]);
    assert.deepEqual(((await viewForToken(on.c.token!)) as BatonView).viewer?.files, { perMessage: 10, maxBytes: 25 * MB });
    assert.equal(((await viewForToken(on.c.token!)) as BatonView).viewer?.photos, undefined, "no photos for a text-only model");
    const off = await session(["text", "image"], false);
    assert.equal(((await viewForToken(off.c.token!)) as BatonView).viewer?.files, undefined);
    await baton.handTo(on.c.sessionId, maria.id, "q", "");
    assert.equal(((await viewForToken(on.c.token!)) as BatonView).viewer?.files, undefined);
  });
});

describe("sending files", () => {
  test("the message carries one line per file, never bytes; the files are received, in the session's view, single use", async () => {
    files.resetFileUploadWindow();
    const { c, got } = await session();
    const a = (await (await upload(c.token!, DUMP, "dump.json")).json()) as { id: string };
    const zip = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(2000, 7)]);
    const b = (await (await upload(c.token!, zip, "site.zip", "application/zip")).json()) as { id: string };
    const res = await message(c.token!, { text: "here it is", files: [a.id, b.id] });
    assert.equal(res.status, 202);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(got.length, 1);
    assert.equal(got[0]!.text, `here it is\n[Alex Rivera sent dump.json (${Math.round(DUMP.length)} bytes, JSON) · file ${a.id}]\n[Alex Rivera sent site.zip (2 KB, zip archive) · file ${b.id}]`);
    assert.equal(got[0]!.images, undefined);
    const ledger = files.readLedger(project.id).filter((r) => r.sessionId === c.sessionId);
    assert.deepEqual(
      ledger.map((r) => [r.name, r.status, r.personId, r.kind]),
      [
        ["dump.json", "received", alex.id, "JSON"],
        ["site.zip", "received", alex.id, "zip archive"],
      ],
    );
    assert.match(ledger[0]!.sha256, /^[0-9a-f]{64}$/);
    const raw = readFileSync(files.ledgerPath(project.id), "utf8");
    assert.ok(!raw.includes(c.token!) && !raw.includes(DUMP.toString("utf8").slice(0, 20)), "no token and no contents in the ledger");
    assert.deepEqual(readdirSync(files.sessionView(project.id, c.sessionId)).sort(), ["dump.json", "site.zip"]);
    assert.equal(existsSync(join(projectDir(), a.id, ".meta.json")), false);
    const again = await message(c.token!, { text: "", files: [a.id] });
    assert.deepEqual([again.status, await code(again)], [409, "file-expired"]);
  });

  test("files alone are a message; more than 10, a repeat, an unknown id, another person's and intake off are refused", async () => {
    files.resetFileUploadWindow();
    const { c, got } = await session();
    const id = ((await (await upload(c.token!, DUMP)).json()) as { id: string }).id;
    assert.equal((await message(c.token!, { files: Array.from({ length: 11 }, (_, i) => `f_${String(i).padStart(16, "A")}`) })).status, 400);
    assert.equal((await message(c.token!, { files: [id, id] })).status, 400);
    assert.equal((await message(c.token!, { files: "f_x" })).status, 400);
    assert.equal(await code(await message(c.token!, { files: ["f_AAAAAAAAAAAAAAAA"] })), "file-expired");
    assert.equal((await message(c.token!, { text: "x", other: 1 })).status, 400);
    await baton.setAbilities(c.sessionId, { files: false });
    assert.equal(await code(await message(c.token!, { files: [id] })), "no-files");
    await baton.setAbilities(c.sessionId, { files: true });
    assert.equal((await message(c.token!, { files: [id] })).status, 202);
    await new Promise((r) => setTimeout(r, 20));
    assert.match(got.at(-1)!.text, /^\[Alex Rivera sent dump\.json \(\d+ bytes, JSON\) · file f_/);
  });

  test("the share view shows a file's row instead of its line, only for a file that sender sent there", async () => {
    files.resetFileUploadWindow();
    const { c, got } = await session();
    const id = ((await (await upload(c.token!, DUMP)).json()) as { id: string }).id;
    assert.equal((await message(c.token!, { text: "the dump", files: [id] })).status, 202);
    await new Promise((r) => setTimeout(r, 30));
    // What the runtime was handed, as the transcript keeps it; the files as the hub reads them.
    const ledger = new Map(files.readLedger(project.id).filter((f) => f.sessionId === c.sessionId).map((f) => [f.id, { name: f.name, size: f.size, personId: f.personId }]));
    const view = batonView({
      row: { publicTitle: "t", state: "open", holder: alex.id },
      branch: [{ kind: "user", id: "u0", blocks: [{ type: "text", text: got.at(-1)!.text }] } as never],
      names: { [alex.id]: "Alex Rivera" },
      redact: (t) => t,
      files: ledger,
    });
    const msg = view.items[0];
    assert.ok(msg && msg.kind === "message");
    assert.equal(msg.text, "the dump");
    assert.deepEqual(msg.files, [{ name: "dump.json", size: DUMP.length }]);
    // A forged line (someone typing one) stays text: an unknown id, or a file of another sender.
    const fake = batonView({
      row: { publicTitle: "t", state: "open", holder: maria.id },
      branch: [{ kind: "user", id: "u1", blocks: [{ type: "text", text: `hi\n[Maria sent x.json (1 KB, JSON) · file ${id}]\n[Maria sent y (1 KB, text) · file f_BBBBBBBBBBBBBBBB]` }] } as never],
      names: {},
      redact: (t) => t,
      files: new Map([[id, { name: "dump.json", size: 1, personId: alex.id }]]),
    });
    const m = fake.items[0];
    assert.ok(m && m.kind === "message");
    assert.equal(m.files, undefined);
    assert.match(m.text, /file f_BBBB/);
  });
});

describe("the gathering model", () => {
  test("inspect_files and confirm_file are in the loadout, active only while intake is on; the prompt says how to check a file", async () => {
    assert.ok(LOADOUT_TOOLS.includes("inspect_files" as never) && LOADOUT_TOOLS.includes("confirm_file" as never));
    const on = await session();
    const off = await session(["text"], false);
    assert.ok(activeBatonTools(on.c.sessionId).includes("inspect_files") && activeBatonTools(on.c.sessionId).includes("confirm_file"));
    assert.ok(!activeBatonTools(off.c.sessionId).includes("inspect_files") && !activeBatonTools(off.c.sessionId).includes("confirm_file"));
    assert.ok(renderBatonPrompt(on.c.sessionId).includes(FILES_ON));
    assert.ok(!renderBatonPrompt(off.c.sessionId).includes("# Files"));
    assert.match(FILES_ON, /checking it/);
    assert.match(FILES_ON, /confirm_file/);
  });

  test("inspect_files reads this session's files only; confirm_file marks one of its own", async () => {
    files.resetFileUploadWindow();
    const { c } = await session();
    const other = await session();
    const tool = inspectFilesTool(c.sessionId);
    const none = await tool.execute("t", { command: "ls" }, undefined, undefined, undefined);
    assert.match((none.content[0] as { text: string }).text, /No files have been sent/);
    const id = ((await (await upload(c.token!, DUMP)).json()) as { id: string }).id;
    await message(c.token!, { text: "", files: [id] });
    const otherId = ((await (await upload(other.c.token!, DUMP, "theirs.json")).json()) as { id: string }).id;
    await message(other.c.token!, { text: "", files: [otherId] });
    await assert.rejects(tool.execute("t", { command: "cat ../" + other.c.sessionId + "/theirs.json" }, undefined, undefined, undefined), /Only this conversation's files/);
    await assert.rejects(tool.execute("t", { command: "cat theirs.json" }, undefined, undefined, undefined), /No file theirs\.json/);

    const confirm = confirmFileTool(c.sessionId);
    await assert.rejects(confirm.execute("t", { id: otherId }, undefined, undefined, undefined), /No file .* in this conversation/);
    const ok = await confirm.execute("t", { id, note: "2 records, newest 2026-09-30" }, undefined, undefined, undefined);
    assert.equal((ok.content[0] as { text: string }).text, "Confirmed dump.json.");
    assert.deepEqual([files.fileOf(project.id, id)?.status, files.fileOf(project.id, id)?.note], ["confirmed", "2 records, newest 2026-09-30"]);
    await baton.setAbilities(c.sessionId, { files: false });
    await assert.rejects(tool.execute("t", { command: "ls" }, undefined, undefined, undefined), /doesn't take files/);
  });

  test("the operator's strip turns intake on and off; an overseer's start may turn it on", async () => {
    const { c } = await session(["text"], false);
    assert.equal((await baton.setAbilities(c.sessionId, { files: true })).abilities?.files, true);
    const row = await baton.setAbilities(c.sessionId, { draw: false });
    assert.equal(row.abilities?.files, true, "another box leaves it as it is");
    assert.equal((await baton.setAbilities(c.sessionId, { files: false })).abilities?.files, undefined);
    const { withFiles } = await import("./gathering-abilities");
    assert.deepEqual(withFiles({ draw: true, readLinks: false, drawHtml: false }, true), { draw: true, readLinks: false, drawHtml: false, files: true });
    assert.deepEqual(withFiles({ draw: true, readLinks: false, drawHtml: false }, "yes"), { draw: true, readLinks: false, drawHtml: false });
  });
});

describe("settings", () => {
  test("the largest file reads on its own (default 25 MB) and a write is validated (1–25 MB)", () => {
    const path = join(root, "bs.json");
    assert.deepEqual(settings.readBatonSettings(path).files, { maxBytes: 25 * MB });
    assert.deepEqual((settings.writeBatonSettings({ messagesMax: 60, files: { maxBytes: 3 * MB } }, path) as { files: unknown }).files, { maxBytes: 3 * MB });
    assert.deepEqual(settings.readBatonSettings(path).files, { maxBytes: 3 * MB });
    for (const bad of [0, 26 * MB, 1.5 * MB, "1"]) assert.ok("error" in settings.writeBatonSettings({ messagesMax: 60, files: { maxBytes: bad } }, path), String(bad));
    assert.deepEqual((settings.writeBatonSettings({ messagesMax: 50 }, path) as { files: unknown }).files, { maxBytes: 3 * MB }, "absent keeps what is stored");
  });
});

describe("the project page's routes", () => {
  test("list, download (an attachment with its headers), delete; an unknown file or project is a 404", async () => {
    const { Hono } = await import("hono");
    const { registerProjectFileRoutes } = await import("./project-files-routes");
    const app = new Hono();
    registerProjectFileRoutes(app);
    files.resetFileUploadWindow();
    const { c } = await session();
    const id = ((await (await upload(c.token!, DUMP, "alex dump.json")).json()) as { id: string }).id;
    await message(c.token!, { text: "", files: [id] });
    const list = (await (await app.request(`/api/projects/${project.id}/files`)).json()) as { files: { id: string; sender: string; gathering: { title: string; path?: string } }[] };
    const row = list.files.find((f) => f.id === id)!;
    assert.deepEqual([row.sender, row.gathering.title, !!row.gathering.path], ["Alex Rivera", "The latest dump", true]);
    const dl = await app.request(`/api/projects/${project.id}/files/${id}`);
    assert.equal(dl.status, 200);
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(DUMP));
    assert.equal(dl.headers.get("content-type"), "application/octet-stream");
    assert.match(dl.headers.get("content-disposition") ?? "", /^attachment; filename="alex dump\.json"/);
    assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
    assert.equal(dl.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.equal((await app.request(`/api/projects/${project.id}/files/f_AAAAAAAAAAAAAAAA`)).status, 404);
    assert.equal((await app.request(`/api/projects/prj_nope/files`)).status, 404);
    assert.equal((await app.request(`/api/projects/${project.id}/files/${id}`, { method: "DELETE" })).status, 200);
    assert.equal((await app.request(`/api/projects/${project.id}/files/${id}`)).status, 404);
    // The share listener never reads a file back.
    assert.equal(shareMayReach("GET", `/api/h/${c.token}/file`), false);
  });
});
