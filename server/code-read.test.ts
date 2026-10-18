import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { codeRead, CodeReadRefusal, deniedPath, DENIED, fsBackend, gitBackend, HIDDEN, maskSecrets, NOT_FOUND, OUTSIDE, relPath, type CodeBackend } from "./code-read";
import { CODE_CLOSE, CODE_OPEN } from "./spec-lookup-projection";
import { scratchRoot } from "./test-scratch";

// §app.spec-lookup/code-read

describe("the deny list", () => {
  const denied = [
    ".env",
    ".env.local",
    "app/.env.production",
    "prod.env",
    "certs/server.pem",
    "keys/site.key",
    "a/b.p12",
    "x.pfx",
    "android/release.keystore",
    "id_rsa",
    "home/id_ed25519.pub",
    ".ssh/config",
    ".npmrc",
    ".netrc",
    "auth.json",
    "credentials.json",
    "config/secrets/db.yml",
    "my_secret_config.js",
    "api-token.txt",
    "passwords.csv",
    "private_key.txt",
    ".git/config",
    ".sova/spec/manifest.json",
    "node_modules/x/index.js",
  ];
  for (const p of denied) test(`denies ${p}`, () => assert.equal(deniedPath(p), true));
  for (const p of ["src/index.ts", "README.md", "site/classes.html", "envelope.ts", "keyboard.ts"]) test(`allows ${p}`, () => assert.equal(deniedPath(p), false));
});

// Secret-shaped fixtures are assembled at run time so the repository's leak scan never reads a literal secret.
const PW = "pass" + "word";
const PEM_BEGIN = "-----BEGIN " + "PRIVATE KEY-----";
const PEM_END = "-----END " + "PRIVATE KEY-----";
const GH_TOKEN = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz123";
const LIVE_KEY = "sk" + "_live_" + "abcdefghijklmnopqrstuvwxyz";
const APP_SECRET = "archery-" + "secret-123";

test("key-shaped lines are hidden; a PEM block whole", () => {
  const text = ["ok line", `const ${PW} = 'hunter2hunter2'`, "API_KEY=abc", PEM_BEGIN, "MIIEv", PEM_END, `token: ${GH_TOKEN}`, "after"].join("\n");
  assert.deepEqual(maskSecrets(text).split("\n"), ["ok line", HIDDEN, HIDDEN, HIDDEN, HIDDEN, "after"]);
});

test("paths stay inside the root", () => {
  assert.equal(relPath("../etc/passwd"), null);
  assert.equal(relPath("/etc/passwd"), null);
  assert.equal(relPath("~/x"), null);
  assert.equal(relPath("a/../../b"), null);
  assert.equal(relPath("./site//index.html"), "site/index.html");
  assert.equal(relPath(""), "");
});

function fixture(dir: string): void {
  mkdirSync(join(dir, "site"), { recursive: true });
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "site", "index.html"), "<h1>Mamluk Arabia</h1>\n<p>Archery classes every Friday</p>\n");
  writeFileSync(join(dir, "site", "notes.md"), "# Notes\n\n> Alperen said: keep it cheap\n\nClasses run on Fridays.\n");
  writeFileSync(join(dir, ".env"), `STRIPE_KEY=${LIVE_KEY}\n`);
  writeFileSync(join(dir, "config", "app.js"), `export const archery = true;\nconst ${PW} = '${APP_SECRET}';\n`);
  writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
}

async function refused(b: CodeBackend, params: Record<string, unknown>, msg: string): Promise<void> {
  await assert.rejects(codeRead(b, params), (e: unknown) => e instanceof CodeReadRefusal && e.message === msg);
}

async function common(b: CodeBackend): Promise<void> {
  const list = await codeRead(b, { op: "list", path: "" });
  assert.ok(list.startsWith(CODE_OPEN) && list.endsWith(CODE_CLOSE));
  assert.ok(list.includes("site/") && list.includes("config/"));
  assert.ok(!list.includes(".env"), "a denied file is never listed");

  const read = await codeRead(b, { op: "read", path: "site/index.html" });
  assert.ok(read.includes("Archery classes every Friday"));

  const prose = await codeRead(b, { op: "read", path: "site/notes.md" }, ["Alperen Kaya"]);
  assert.ok(prose.includes("Classes run on Fridays."));
  assert.ok(!prose.includes("Alperen") && !prose.includes("keep it cheap"), prose);

  const masked = await codeRead(b, { op: "read", path: "config/app.js" });
  assert.ok(masked.includes(HIDDEN) && !masked.includes(APP_SECRET));

  const search = await codeRead(b, { op: "search", words: "archery" });
  assert.ok(search.includes("site/index.html:2:"), search);
  assert.ok(!search.includes(APP_SECRET));
  const searchSecret = await codeRead(b, { op: "search", words: "sk_live" });
  assert.ok(!searchSecret.includes(LIVE_KEY), "a denied file is never searched");

  await refused(b, { op: "read", path: ".env" }, DENIED);
  await refused(b, { op: "read", path: "../outside.txt" }, OUTSIDE);
  await refused(b, { op: "read", path: "logo.png" }, DENIED);
  await refused(b, { op: "read", path: "nope.txt" }, NOT_FOUND);
  await refused(b, { op: "list", path: ".git" }, DENIED);
}

test("a root without Git: files, no link out, no hard-linked file", async () => {
  const base = scratchRoot("code-read-fs");
  const root = join(base, "root");
  mkdirSync(root);
  fixture(root);
  writeFileSync(join(base, "outside.txt"), "outside secret words\n");
  symlinkSync(join(base, "outside.txt"), join(root, "innocent.txt"));
  linkSync(join(base, "outside.txt"), join(root, "hard.txt"));
  const b = fsBackend(root);
  await common(b);
  await refused(b, { op: "read", path: "innocent.txt" }, NOT_FOUND);
  await refused(b, { op: "read", path: "hard.txt" }, NOT_FOUND);
  const s = await codeRead(b, { op: "search", words: "outside secret" });
  assert.ok(!s.includes("outside secret words"));
});

test("a root without Git: a link to a denied folder is never listed, whatever it is called", async () => {
  const root = scratchRoot("code-read-fs-link");
  fixture(root);
  mkdirSync(join(root, ".sova", "spec", "drafts", "x"), { recursive: true });
  writeFileSync(join(root, ".sova", "spec", "drafts", "x", "notes.md"), "Their words: secret plans\n");
  symlinkSync(join(root, ".sova", "spec", "drafts", "x"), join(root, "docs"));
  const b = fsBackend(root);
  await refused(b, { op: "list", path: "docs" }, DENIED);
  await refused(b, { op: "read", path: "docs/notes.md" }, NOT_FOUND);
  assert.ok(!(await codeRead(b, { op: "list", path: "" })).includes("docs"), "the link isn't listed either");
});

test("a Git root: the committed tree only, never the working tree", async () => {
  const top = scratchRoot("code-read-git");
  const g = (...args: string[]) => execFileSync("git", ["-C", top, ...args], { encoding: "utf8" }).trim();
  g("init", "-q", "-b", "master");
  fixture(top);
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const rev = g("rev-parse", "HEAD");
  // Uncommitted: never read.
  writeFileSync(join(top, "site", "index.html"), "DIRTY working tree\n");
  writeFileSync(join(top, "draft.txt"), "uncommitted\n");
  const b = gitBackend({ kind: "git", top, rev, prefix: "" });
  await common(b);
  await refused(b, { op: "read", path: "draft.txt" }, NOT_FOUND);
  assert.ok(!(await codeRead(b, { op: "search", words: "DIRTY" })).includes("DIRTY working"));
});

test("a Git root below its repository's top reads only inside it", async () => {
  const top = scratchRoot("code-read-git-sub");
  const g = (...args: string[]) => execFileSync("git", ["-C", top, ...args], { encoding: "utf8" }).trim();
  g("init", "-q", "-b", "master");
  mkdirSync(join(top, "app"));
  fixture(join(top, "app"));
  writeFileSync(join(top, "beside.txt"), "archery beside the root\n");
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const b = gitBackend({ kind: "git", top, rev: g("rev-parse", "HEAD"), prefix: "app" });
  await common(b);
  assert.ok(!(await codeRead(b, { op: "search", words: "archery" })).includes("beside"));
});
