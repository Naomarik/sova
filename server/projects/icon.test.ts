// Run: pnpm test -- server/projects/icon.test.ts. A project's icon (§app.projects/icon): which file in a folder is its
// app icon, the checks every candidate passes, and the uploads and letters switch kept under <stateRoot>/project-icons/.
// A throwaway PI_CODING_AGENT_DIR and folders in the OS temp dir; the folders are only read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-project-icon-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");

const icon = await import("./icon");

/** The bytes the checks read: the PNG signature and an IHDR of w×h (the rest is never decoded). */
function png(w: number, h: number, pad = 0): Buffer {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);

let n = 0;
function folder(files: Record<string, Buffer | string>): string {
  const root = join(tmp, `root-${n++}`);
  mkdirSync(root, { recursive: true });
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), data);
  }
  return root;
}
const found = (root: string) => icon.findIcon(root, true)?.path ?? null;

test("pngSize reads IHDR; anything but a PNG is null", () => {
  assert.deepEqual(icon.pngSize(png(180, 120)), { w: 180, h: 120 });
  assert.equal(icon.pngSize(JPEG), null);
  assert.equal(icon.pngSize(Buffer.from("not an image at all, really not")), null);
});

test("each candidate class wins in order: .sova/icon.png, the manifest's, then the fixed places", () => {
  const all = {
    ".sova/icon.png": png(256, 256),
    "public/manifest.webmanifest": JSON.stringify({ icons: [{ src: "/icons/pwa-512.png", sizes: "512x512", type: "image/png" }] }),
    "public/icons/pwa-512.png": png(512, 512),
    "public/apple-touch-icon.png": png(180, 180),
    "logo.png": png(128, 128),
  };
  assert.equal(found(folder(all)), ".sova/icon.png");
  const { [".sova/icon.png"]: _a, ...noSova } = all;
  assert.equal(found(folder(noSova)), "public/icons/pwa-512.png", "a leading '/' is the manifest's own folder");
  const { ["public/manifest.webmanifest"]: _b, ...noManifest } = noSova;
  assert.equal(found(folder(noManifest)), "public/apple-touch-icon.png");
  const { ["public/apple-touch-icon.png"]: _c, ...onlyLogo } = noManifest;
  assert.equal(found(folder(onlyLogo)), "logo.png");
  assert.equal(found(folder({ "src-tauri/icons/icon.png": png(512, 512) })), "src-tauri/icons/icon.png");
  assert.equal(found(folder({ "README.md": "hi" })), null);
});

test("manifest: relative src against its folder, largest declared size first, purpose any only, first manifest that parses", () => {
  const root = folder({
    "public/site.webmanifest": JSON.stringify({
      icons: [
        { src: "a-192.png", sizes: "192x192" },
        { src: "mask-512.png", sizes: "512x512", purpose: "maskable" },
        { src: "b-384.png", sizes: "384x384", purpose: "any maskable" },
        { src: "c.svg", sizes: "512x512", type: "image/svg+xml" },
      ],
    }),
    "public/a-192.png": png(192, 192),
    "public/mask-512.png": png(512, 512),
    "public/b-384.png": png(384, 384),
  });
  assert.equal(found(root), "public/b-384.png");
  // A manifest that doesn't parse is skipped; the next one is read.
  const next = folder({ "public/manifest.webmanifest": "{ nope", "public/manifest.json": JSON.stringify({ icons: [{ src: "i.png" }] }), "public/i.png": png(96, 96) });
  assert.equal(found(next), "public/i.png");
});

test("checks: a 3:1 wordmark, a 32px favicon, a file over 1 MB and a JPEG named .png are skipped", () => {
  assert.equal(found(folder({ "logo.png": png(600, 200) })), null, "wordmark");
  assert.equal(found(folder({ "logo.png": png(600, 200), "icon.png": png(128, 128) })), "icon.png", "the wordmark is passed over");
  assert.equal(found(folder({ "icon.png": png(32, 32) })), null, "favicon");
  assert.equal(found(folder({ "icon.png": png(512, 512, icon.FOUND_MAX_BYTES) })), null, "over 1 MB");
  assert.equal(found(folder({ "icon.png": JPEG })), null, "a JPEG named .png");
  assert.equal(found(folder({ "icon.png": png(120, 100) })), "icon.png", "1.2:1 is square enough");
});

test("a symlink out of the root and a manifest src with '..' out of it are refused", () => {
  const outside = folder({ "secret.png": png(256, 256) });
  const root = folder({});
  symlinkSync(join(outside, "secret.png"), join(root, "icon.png"));
  assert.equal(found(root), null, "symlink escape");
  const viaDots = folder({ "public/manifest.json": JSON.stringify({ icons: [{ src: `../../${outside.split("/").pop()}/secret.png`, sizes: "256x256" }] }) });
  assert.equal(found(viaDots), null, "'..' escape");
  // A symlink that stays inside is still a regular file only after lstat: refused too.
  const inner = folder({ "real.png": png(256, 256) });
  symlinkSync(join(inner, "real.png"), join(inner, "icon.png"));
  assert.equal(found(inner), null);
});

test("the found icon is remembered for 30 s; its v changes when the file changes", () => {
  let now = 1_000_000;
  icon.resetIconMemoForTest(() => now);
  const root = folder({ "icon.png": png(128, 128) });
  const first = icon.findIcon(root)!;
  assert.ok(first);
  rmSync(join(root, "icon.png"));
  assert.equal(icon.findIcon(root)?.v, first.v, "remembered");
  now += icon.FOUND_MEMO_MS;
  assert.equal(icon.findIcon(root), null, "noticed after the memo");
  writeFileSync(join(root, "icon.png"), png(256, 256));
  const t = new Date(Date.now() + 5000);
  utimesSync(join(root, "icon.png"), t, t);
  const again = icon.findIcon(root, true)!;
  assert.notEqual(again.v, first.v);
  icon.resetIconMemoForTest();
});

test("upload: 413 over 1 MB, 415 not a PNG, 400 not square or out of 64..1024; a good one wins over the found icon", () => {
  const pid = "prj_upload01";
  const root = folder({ "icon.png": png(128, 128) });
  const status = (f: () => unknown) => {
    try {
      f();
      return 200;
    } catch (e) {
      assert.ok(e instanceof icon.IconError, String(e));
      return e.status;
    }
  };
  assert.equal(status(() => icon.saveUpload(pid, root, png(512, 512, icon.UPLOAD_MAX_BYTES).toString("base64"))), 413);
  assert.equal(status(() => icon.saveUpload(pid, root, JPEG.toString("base64"))), 415);
  assert.equal(status(() => icon.saveUpload(pid, root, png(300, 200).toString("base64"))), 400);
  assert.equal(status(() => icon.saveUpload(pid, root, png(32, 32).toString("base64"))), 400);
  assert.equal(status(() => icon.saveUpload(pid, root, png(2048, 2048).toString("base64"))), 400);
  assert.equal(status(() => icon.saveUpload(pid, root, 5)), 400);
  assert.equal(icon.iconRefOf(pid, root)?.source, "found");
  const info = icon.saveUpload(pid, root, png(256, 256).toString("base64"));
  assert.equal(info.use, "upload");
  assert.equal(info.found?.path, "icon.png");
  const ref = icon.iconRefOf(pid, root)!;
  assert.equal(ref.source, "upload");
  assert.equal(ref.v, info.uploaded!.v);
  // Kept on this host, private: the folder 0700, the file 0600.
  assert.equal(statSync(icon.iconsDir()).mode & 0o777, 0o700);
  assert.equal(statSync(join(icon.iconsDir(), `${pid}.png`)).mode & 0o777, 0o600);
  assert.equal(icon.iconBytes(pid, root)?.bytes.length, png(256, 256).length);
});

test("letters hide the picture; Use Picture brings it back; Remove falls back to the found icon, then letters", () => {
  const pid = "prj_letters1";
  const root = folder({ "icon.png": png(128, 128) });
  icon.saveUpload(pid, root, png(128, 128).toString("base64"));
  const on = icon.setLetters(pid, root, true);
  assert.equal(on.use, "letters");
  assert.equal(on.letters, true);
  assert.equal(icon.iconRefOf(pid, root), undefined);
  assert.equal(icon.iconBytes(pid, root), null);
  assert.equal(icon.setLetters(pid, root, false).use, "upload");
  assert.equal(icon.removeUpload(pid, root).use, "found");
  rmSync(join(root, "icon.png"));
  // The memo was dropped by the write above; this read rescans.
  assert.equal(icon.iconInfo(pid, root).use, "letters");
  assert.equal(icon.iconRefOf(pid, root), undefined);
});

test("a write drops that root's memo", () => {
  let now = 5_000_000;
  icon.resetIconMemoForTest(() => now);
  const pid = "prj_memo0001";
  const root = folder({ "icon.png": png(128, 128) });
  assert.equal(icon.iconRefOf(pid, root)?.source, "found");
  rmSync(join(root, "icon.png"));
  assert.equal(icon.iconRefOf(pid, root)?.source, "found", "memoised");
  icon.setLetters(pid, root, false);
  assert.equal(icon.iconRefOf(pid, root), undefined, "the write dropped it");
  icon.resetIconMemoForTest();
});
