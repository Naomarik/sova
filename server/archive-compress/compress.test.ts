// Archive compression (§app.session-list/archive-compression): a homed chat's home becomes one
// compressed file, an older chat's files are gzipped where they are, nothing is lost, and Delete
// removes the compressed files. Throwaway agent dir and homes root; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { after, describe, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "sova-compress-test-"));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.SOVA_CHAT_HOMES = join(scratch, "homes");
after(() => rmSync(scratch, { recursive: true, force: true }));

const { compressChat, deleteCompressed, keptRow } = await import("./compress");
const { compressedAt, compressedRows, isCompressedId } = await import("./store");
const { readTarGz, writeTarGz, sameEntries } = await import("./tar");
const { ensureChatHome } = await import("../chat-homes/root");

const row = (id: string, path: string) =>
  ({ id, path, title: "T", cwd: "/w", createdAt: "2026-01-01T00:00:00Z", lastActiveAt: "2026-01-02T00:00:00Z", model: null, live: { pid: 1, status: "x" }, busy: true, origin: "web", archived: true, hasDraft: true }) as any;

describe("tar", () => {
  test("a folder reads back as it was, long names included", async () => {
    const dir = join(scratch, "t");
    const long = "a".repeat(120);
    mkdirSync(join(dir, "sub", long), { recursive: true });
    writeFileSync(join(dir, "sub", long, "f.jsonl"), "x".repeat(1500));
    writeFileSync(join(dir, "empty"), "");
    const out = join(scratch, "t.tar.gz");
    const want = await writeTarGz(dir, out);
    const got = await readTarGz(out);
    assert.ok(sameEntries(want, got));
    assert.ok(got.some((e) => e.name === `sub/${long}/f.jsonl` && e.size === 1500));
  });
});

describe("compressChat", () => {
  test("a homed chat's whole home becomes one file; its row is kept, marked, with nothing live", async () => {
    const id = "019a0000-0000-7000-8000-000000000001";
    const home = ensureChatHome(id);
    mkdirSync(join(home, "sessions"), { recursive: true });
    const path = join(home, "sessions", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    writeFileSync(path, '{"type":"session"}\n');
    mkdirSync(join(home, "shared"), { recursive: true });
    writeFileSync(join(home, "shared", "notes.md"), "kept");
    symlinkSync("/etc", join(home, "shared", "link")); // an agent's link: kept as a link, never followed
    const e = await compressChat(row(id, path), [], "user");
    assert.equal(existsSync(home), false, "the home folder is gone");
    assert.ok(e.archive && existsSync(e.archive));
    const names = (await readTarGz(e.archive!)).map((x) => x.name);
    const entries = await readTarGz(e.archive!);
    assert.ok(names.includes("shared/notes.md") && names.includes(`sessions/2026-01-01T00-00-00-000Z_${id}.jsonl`) && names.includes("manifest.json"));
    assert.equal(entries.find((x) => x.name === "shared/link")?.link, "/etc");
    assert.equal(names.some((n) => n.startsWith("shared/link/")), false, "the link's target is not in it");
    const kept = compressedRows().get(path)!;
    assert.equal(kept.compressed, true);
    assert.equal(kept.live, null);
    assert.equal(kept.busy, false);
    assert.equal(kept.hasDraft, undefined);
    assert.equal(compressedAt(join(home, "sessions", "worker.jsonl"))?.id, id, "a helper's file is the chat's");
    assert.ok(deleteCompressed(id));
    assert.equal(existsSync(e.archive!), false);
    assert.equal(isCompressedId(id), false);
  });

  test("an older chat's own and helpers' files are gzipped in place, byte for byte", async () => {
    const dir = join(scratch, "agent", "sessions", "--w--");
    mkdirSync(dir, { recursive: true });
    const own = join(dir, "2026-01-01T00-00-00-000Z_019a0000-0000-7000-8000-000000000002.jsonl");
    const helper = join(dir, "2026-01-01T00-00-01-000Z_019a0000-0000-7000-8000-000000000003.jsonl");
    writeFileSync(own, "own\n".repeat(100));
    writeFileSync(helper, "helper\n");
    const e = await compressChat(row("019a0000-0000-7000-8000-000000000002", own), [helper], "auto");
    assert.equal(existsSync(own) || existsSync(helper), false);
    assert.equal(gunzipSync(readFileSync(`${own}.gz`)).toString(), "own\n".repeat(100));
    assert.equal(gunzipSync(readFileSync(`${helper}.gz`)).toString(), "helper\n");
    assert.equal(e.files?.length, 2);
    assert.equal(compressedAt(helper)?.id, e.id);
    deleteCompressed(e.id);
    assert.equal(existsSync(`${own}.gz`) || existsSync(`${helper}.gz`), false);
  });

  test("keptRow drops what is live or held", () => {
    const k = keptRow({ ...row("x", "/p"), chat: {}, workers: { working: 1, total: 1 }, jobsRunning: 2, draftPreview: "d" });
    assert.deepEqual([k.chat, k.workers, k.jobsRunning, k.draftPreview, k.compressed, k.archived], [undefined, undefined, undefined, undefined, true, true]);
  });
});
