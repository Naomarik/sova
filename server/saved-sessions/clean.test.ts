import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { BundleStringSite } from "../../shared/harness";
import { ROOT_TOKEN, worktreeToken } from "../../shared/session-bundle";
import { REDACTED, Redactor } from "../overseer-redact";
import { scratchRoot } from "../test-scratch";
import { Cleaner, envFileValues, pathRoots, possibleSecretWhy, POSSIBLE_REMOVED, PRIVATE_NAME, restorer } from "./clean";

const root = scratchRoot("saved-clean-");
after(() => rmSync(root, { recursive: true, force: true }));
const site: BundleStringSite = { entryId: "e1", where: "tool-result", tool: "bash", at: "2026-01-01T00:00:00.000Z" };

const KNOWN = "known-secret-value-1234567890";
const ENV_VALUE = "envSecretFromDotEnv_998877";
const top = join(root, "proj");
const wt = join(root, "proj-wt");
mkdirSync(top, { recursive: true });
mkdirSync(wt, { recursive: true });
writeFileSync(join(top, ".env.local"), `# comment\nAPI=${ENV_VALUE}\nPORT=4800\nEMPTY=\nQUOTED="quoted value long enough"\n`);
writeFileSync(join(top, ".env.example"), "API=placeholder-value-not-secret\n");

const cleaner = (decisions?: Record<string, "keep" | "remove">) =>
  new Cleaner({
    roots: pathRoots(top, [{ path: wt, branch: "feat/x" }, { path: join(top, "inner"), branch: "feat/inner" }], "/home/someone"),
    envDirs: [top],
    redactor: new Redactor([{ path: join(root, "none.json"), pick: () => [] }], { MY_TOKEN: KNOWN }).refresh(),
    privateNames: ["Acme Corp"],
    links: (t) => t.replaceAll("https://share.example/s/abc", "[share link]"),
    ...(decisions ? { decisions } : {}),
  });

/** Fake key shapes, built at run time so no literal key sits in the source (the leak scan). */
const FAKE_ANT = ["sk", "ant", "abcdefghijklmnop1234"].join("-");
const FAKE_TOKEN = ["Xk3vQ9pLm2", "Rt8Zw4Yb7N", "c1Hd6Fj0Ga5S"].join("");

describe("cleaning", () => {
  test("known secrets, .env values, private names and links go with no review", () => {
    const c = cleaner();
    const out = c.clean(`key ${KNOWN} env ${ENV_VALUE} for acme corp at https://share.example/s/abc ${FAKE_ANT}`, site);
    assert.ok(!out.includes(KNOWN) && !out.includes(ENV_VALUE) && !/acme corp/i.test(out) && !out.includes("share.example"));
    assert.ok(out.includes(REDACTED) && out.includes(PRIVATE_NAME) && out.includes("[share link]"));
    assert.equal(c.counts.secretsRemoved, 5);
    assert.equal(c.review.size, 0);
  });

  test("a .env file's values, not its names, its example files or its non-secrets", () => {
    assert.deepEqual(envFileValues(`export A=one-two-three-four\nB='single quoted value'\nC=12345678901234\nD=/a/path/that/is/long\n# E=commented-out-value\n`), ["one-two-three-four", "single quoted value"]);
  });

  test("a possible secret is listed once per value and removed only on a remove decision", () => {
    const token = FAKE_TOKEN;
    const c = cleaner();
    const out = c.clean(`token: ${token} and again ${token}`, site);
    assert.equal(out, `token: ${token} and again ${token}`);
    assert.equal(c.review.size, 1);
    const item = [...c.review.values()][0]!;
    assert.equal(item.kind, "possible-secret");
    assert.equal(item.where, "bash result");
    assert.ok(item.excerpt.includes("[[") && !item.excerpt.includes(token), "the excerpt never holds the whole long value");
    const removed = cleaner({ [item.id]: "remove" });
    assert.equal(removed.clean(`token: ${token}`, site), `token: ${POSSIBLE_REMOVED}`);
    assert.equal(removed.cleaning({ imagesKept: 0, imagesRemoved: 0, thinkingDropped: 0, toolOutputsTrimmed: 0 }).possibleRemoved, 1);
  });

  test("a secret said in prose is listed for review; ordinary prose isn't", () => {
    const c = cleaner();
    const out = c.clean("My test password is hunter2-Qz9!xK. The token: abcd1234 works; the password is required.", site);
    assert.equal(out, "My test password is hunter2-Qz9!xK. The token: abcd1234 works; the password is required.");
    assert.deepEqual([...c.review.values()].map((r) => [r.why, r.excerpt.includes("[[hunter2-Qz9!xK]]") || r.excerpt.includes("[[abcd1234]]")]), [["said to be a secret", true], ["said to be a secret", true]]);
    const ids = Object.fromEntries([...c.review.keys()].map((id) => [id, "remove" as const]));
    assert.equal(cleaner(ids).clean("My test password is hunter2-Qz9!xK.", site), `My test password is ${POSSIBLE_REMOVED}.`);
    // Before any decision, nothing under review counts as kept or removed.
    const counts = c.cleaning({ imagesKept: 0, imagesRemoved: 0, thinkingDropped: 0, toolOutputsTrimmed: 0 });
    assert.deepEqual([counts.possibleKept, counts.possibleRemoved], [0, 0]);
  });

  test("one item per value, whichever pass found it; worker session files and dash-spelled home go", () => {
    const c = cleaner();
    c.clean("For later: the staging token is q7Xv2LmR9tKp4WzB8nYc3HsJ6dFa1Ge5.", site);
    assert.equal(c.review.size, 1);
    assert.equal([...c.review.values()][0]!.why, "said to be a secret");
    const out = c.clean("Session: /home/someone/.pi/agent/sessions/--home-someone-webapps-x--/2026-01-01T00-00-00-000Z_0190.jsonl and folder -home-someone-webapps", site);
    assert.equal(out, "Session: [a session file on the saver's computer] and folder -~-webapps");
    assert.ok(!out.includes("someone"));
  });

    test("hashes, uuids, paths and words are not possible secrets", () => {
    for (const s of [
      "0123456789abcdef0123456789abcdef01234567",
      "01a0bee7-5365-7104-ae3f-06607d2e9bd9",
      "node_modules/.pnpm/some-package@1.0.3/dist/index.js",
      "createWebSessionFileWithoutDigits",
      "server/harness/pi/bundle.test.ts",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
    ])
      assert.equal(possibleSecretWhy(s), null, s);
    assert.ok(possibleSecretWhy(FAKE_TOKEN));
  });

  test("paths: worktree roots to their token, the top level to the root token, home to ~; restored on continue", () => {
    const c = cleaner();
    const text = `cd ${wt}/src && cat ${top}/a.ts ${top}/inner/b.ts /home/someone/.bashrc ${top}-other/x /etc/hosts`;
    const out = c.clean(text, site);
    assert.equal(out, `cd ${worktreeToken("feat/x")}/src && cat ${ROOT_TOKEN}/a.ts ${worktreeToken("feat/inner")}/b.ts ~/.bashrc ${top}-other/x /etc/hosts`);
    assert.equal(c.counts.pathsRewritten, 4);
    assert.ok(c.counts.absolutePathsLeft >= 2);
    const restore = restorer("/home/v/clone", (b) => (b === "feat/x" ? "/home/v/wt-x" : null));
    assert.equal(restore(out), `cd /home/v/wt-x/src && cat /home/v/clone/a.ts /home/v/clone/b.ts ~/.bashrc ${top}-other/x /etc/hosts`);
  });
});
