// Run: pnpm test:int server/share/tunnel/download.integration.test.ts. The real programs the unit file fakes:
// the system tar taking the one `cloudflared` member out of a .tgz (an extra file and a same-named one in a
// folder are left behind), and `cloudflared --version` asked of what PATH finds. No network: fetch is injected.
import { dropScratchAgentDir, scratchAgentDir } from "../../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { defaultResolveDeps, findCloudflared, forgetCloudflared } from "./binary";
import { downloadCloudflared, systemUntar } from "./download";
import type { CloudflaredAsset } from "./release";

const work = mkdtempSync(join(scratchAgentDir, "p4-"));
after(() => {
  forgetCloudflared();
  dropScratchAgentDir();
});

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const SCRIPT = "#!/bin/sh\necho 'cloudflared version 2026.10.7 (built 2026-10-30-1705 UTC)'\n";

const serve = (body: Uint8Array) =>
  (async () => new Response(new Blob([new Uint8Array(body)]).stream(), { headers: { "content-length": String(body.byteLength) } })) as unknown as typeof fetch;

describe("a .tgz through the system tar", () => {
  test("only the cloudflared member, checked, at 0755; the rest never lands", async () => {
    const src = join(work, "src");
    mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "cloudflared"), SCRIPT);
    writeFileSync(join(src, "README"), "not taken");
    writeFileSync(join(src, "sub", "cloudflared"), "not this one");
    const tgz = join(work, "cf.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", src, "cloudflared", "README", "sub"]);
    const bytes = readFileSync(tgz);
    const asset: CloudflaredAsset = { name: "cloudflared-darwin-arm64.tgz", size: bytes.byteLength, sha256: sha(bytes), member: { name: "cloudflared", sha256: sha(SCRIPT) } };
    const dir = join(work, "bin");
    const r = await downloadCloudflared({ fetch: serve(bytes), asset, version: "2026.10.7", platform: "darwin", dir, untar: systemUntar, now: () => 1, timeoutMs: 5000 });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(readdirSync(dir).sort(), ["cloudflared", "cloudflared.json"]);
    assert.equal(readFileSync(join(dir, "cloudflared"), "utf8"), SCRIPT);
    assert.equal(execFileSync(join(dir, "cloudflared"), ["--version"], { encoding: "utf8" }).trim().startsWith("cloudflared version 2026.10.7"), true);
  });
});

describe("PATH, asked its version", () => {
  test("the first cloudflared on PATH that answers; one that fails is passed over", async () => {
    const a = join(work, "a");
    const b = join(work, "b");
    for (const d of [a, b]) mkdirSync(d, { recursive: true });
    writeFileSync(join(a, "cloudflared"), "#!/bin/sh\nexit 3\n");
    writeFileSync(join(b, "cloudflared"), SCRIPT);
    for (const d of [a, b]) chmodSync(join(d, "cloudflared"), 0o755);
    const f = await findCloudflared({ ...defaultResolveDeps(), env: { PATH: `${a}:${b}` } });
    assert.deepEqual(f, { ok: true, path: join(b, "cloudflared"), version: "2026.10.7", source: "path" });
    assert.equal(existsSync(join(scratchAgentDir, "sova", "bin")), false, "a look downloads nothing");
  });
});
