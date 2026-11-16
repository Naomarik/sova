// Run: pnpm test server/share/tunnel/binary.test.ts. Which cloudflared Sova runs, with every program and file
// faked (no process runs here; the real `--version` probe is binary.integration.test.ts).
import { dropScratchAgentDir } from "../../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { CLOUDFLARED_ASSETS, CLOUDFLARED_VERSION, installCommand } from "./release";
import { compareVersions, findCloudflared, parseDownloadedRecord, parseVersion, type ResolveDeps, searchDirs } from "./binary";

after(dropScratchAgentDir);

/** The sum release.ts pins for linux x64, the platform these fakes say they are. */
const SUM = CLOUDFLARED_ASSETS["linux-x64"]!.sha256;

function deps(over: Partial<ResolveDeps> & { programs?: Record<string, string | null>; files?: Record<string, string> } = {}): ResolveDeps & { asked: string[] } {
  const programs = over.programs ?? {};
  const files = over.files ?? {};
  const asked: string[] = [];
  return {
    env: { PATH: "/a:/b" },
    platform: "linux",
    arch: "x64",
    executable: (p) => p in programs || p in files,
    version: async (p) => (asked.push(p), programs[p] ?? null),
    sha256File: async (p) => files[p] ?? null,
    readRecord: () => null,
    downloaded: "/state/bin/cloudflared",
    ...over,
    asked,
  };
}

describe("finding cloudflared", () => {
  test("SOVA_CLOUDFLARED wins and is never asked its version", async () => {
    const d = deps({ env: { PATH: "/a", SOVA_CLOUDFLARED: "/fake/cf.mjs" }, programs: { "/fake/cf.mjs": null, "/a/cloudflared": "cloudflared version 2026.10.7" } });
    assert.deepEqual(await findCloudflared(d), { ok: true, path: "/fake/cf.mjs", version: null, source: "env" });
    assert.deepEqual(d.asked, []);
  });

  test("SOVA_CLOUDFLARED=off (the runner's): an installed one is never asked or run, but the downloaded copy still counts", async () => {
    const d = deps({ env: { PATH: "/a", SOVA_CLOUDFLARED: "off" }, programs: { "/a/cloudflared": "cloudflared version 2026.10.7", "/usr/local/bin/cloudflared": "cloudflared version 2026.10.7" } });
    assert.deepEqual(await findCloudflared(d), { ok: false, reason: "cloudflared isn't installed on this computer.", canDownload: true, install: installCommand("linux") });
    assert.deepEqual(d.asked, []);
    const record = { version: CLOUDFLARED_VERSION, sha256: SUM, at: 1 };
    const kept = await findCloudflared(deps({ env: { SOVA_CLOUDFLARED: "off" }, files: { "/state/bin/cloudflared": SUM }, readRecord: () => record }));
    assert.equal(kept.ok && kept.source, "download");
  });

  test("a SOVA_CLOUDFLARED that isn't a program is no cloudflared, said so", async () => {
    const f = await findCloudflared(deps({ env: { PATH: "/a", SOVA_CLOUDFLARED: "/nope" }, programs: { "/a/cloudflared": "cloudflared version 2026.10.7" } }));
    assert.equal(f.ok, false);
    assert.match(!f.ok ? f.reason : "", /SOVA_CLOUDFLARED names \/nope/);
  });

  test("the first one on PATH that answers its version, before a downloaded copy", async () => {
    const d = deps({
      programs: { "/a/cloudflared": null, "/b/cloudflared": "cloudflared version 2026.10.7 (built 2026-10-30-1705 UTC)" },
      files: { "/state/bin/cloudflared": SUM },
      readRecord: () => ({ version: CLOUDFLARED_VERSION, sha256: SUM, at: 1 }),
    });
    assert.deepEqual(await findCloudflared(d), { ok: true, path: "/b/cloudflared", version: "2026.10.7", source: "path" });
    assert.deepEqual(d.asked, ["/a/cloudflared", "/b/cloudflared"]);
  });

  test("a dev build without a release version still runs", async () => {
    const f = await findCloudflared(deps({ programs: { "/a/cloudflared": "cloudflared version DEV" } }));
    assert.deepEqual(f, { ok: true, path: "/a/cloudflared", version: null, source: "path" });
  });

  test("one too old is passed over, and named when nothing else is found", async () => {
    const f = await findCloudflared(deps({ programs: { "/a/cloudflared": "cloudflared version 2021.3.1" } }));
    assert.equal(f.ok, false);
    assert.match(!f.ok ? f.reason : "", /\/a\/cloudflared is version 2021\.3\.1; Sova needs 2024\.1\.0 or later/);
  });

  test("the downloaded copy only while it hashes to the pinned sum, never just to its own record", async () => {
    const record = { version: CLOUDFLARED_VERSION, sha256: SUM, at: 1 };
    assert.deepEqual(await findCloudflared(deps({ files: { "/state/bin/cloudflared": SUM }, readRecord: () => record })), { ok: true, path: "/state/bin/cloudflared", version: CLOUDFLARED_VERSION, source: "download" });
    const changed = await findCloudflared(deps({ files: { "/state/bin/cloudflared": "b".repeat(64) }, readRecord: () => record }));
    assert.equal(changed.ok, false, "a file changed since it was verified is not run");
    const swapped = await findCloudflared(deps({ files: { "/state/bin/cloudflared": "b".repeat(64) }, readRecord: () => ({ ...record, sha256: "b".repeat(64) }) }));
    assert.equal(swapped.ok, false, "another program with a record rewritten to match is not run");
    const older = await findCloudflared(deps({ files: { "/state/bin/cloudflared": SUM }, readRecord: () => ({ ...record, version: "2025.1.0" }) }));
    assert.equal(older.ok, false, "a copy of an older pin isn't run; Download is offered again");
    const mac = CLOUDFLARED_ASSETS["darwin-arm64"]!;
    const onMac = await findCloudflared(deps({ platform: "darwin", arch: "arm64", files: { "/state/bin/cloudflared": mac.member!.sha256 }, readRecord: () => record }));
    assert.equal(onMac.ok && onMac.source, "download", "macOS: the binary's own pinned sum, not the archive's");
    assert.equal((await findCloudflared(deps({ files: { "/state/bin/cloudflared": SUM } }))).ok, false, "no record, no run");
  });

  test("none: the reason, and whether Download is offered here", async () => {
    assert.deepEqual(await findCloudflared(deps()), { ok: false, reason: "cloudflared isn't installed on this computer.", canDownload: true, install: installCommand("linux") });
    const mac = await findCloudflared(deps({ platform: "darwin", arch: "arm64" }));
    assert.ok(!mac.ok && mac.canDownload && mac.install === "brew install cloudflared");
    const win = await findCloudflared(deps({ platform: "win32", arch: "x64" }));
    assert.ok(!win.ok && !win.canDownload);
  });
});

describe("its parts", () => {
  test("the version line", () => {
    assert.equal(parseVersion("cloudflared version 2026.10.7 (built 2026-10-30-1705 UTC)"), "2026.10.7");
    assert.equal(parseVersion("cloudflared version DEV"), null);
    assert.equal(parseVersion(""), null);
  });

  test("versions compare by number", () => {
    assert.equal(compareVersions("2024.1.0", "2024.1.0"), 0);
    assert.equal(compareVersions("2024.10.0", "2024.9.5"), 1);
    assert.equal(compareVersions("2023.12.1", "2024.1.0"), -1);
  });

  test("PATH, then the usual places a service's PATH leaves out; relative entries dropped", () => {
    assert.deepEqual(searchDirs({ PATH: "/x:relative::/usr/bin" }, "linux"), ["/x", "/usr/bin", "/usr/local/bin"]);
    assert.deepEqual(searchDirs({}, "darwin"), ["/opt/homebrew/bin", "/usr/local/bin"]);
  });

  test("the download's record parses strictly", () => {
    assert.deepEqual(parseDownloadedRecord({ version: "2026.10.7", sha256: SUM, at: 5 }), { version: "2026.10.7", sha256: SUM, at: 5 });
    for (const bad of [null, "x", {}, { version: "1", sha256: "short", at: 1 }, { version: "1", sha256: SUM }]) assert.equal(parseDownloadedRecord(bad), null);
  });
});
