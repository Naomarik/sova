// Run: npx tsx --test server/overseer-file-tools.integration.test.ts. The Overseer's find and grep
// run the real fd and rg (as pi's do): what they return from a search, over the fake home of
// server/overseer-file-tools-fixture.ts (OS temp dir, removed after; the real home is never read).
// The refusals before any search are in overseer-file-tools.test.ts.
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { setSearchSpawnForTest } from "./overseer-file-tools";
import { confinedBox, secretBox } from "./overseer-file-tools-fixture";
import { fakeSearchSpawn } from "./search-tools-fake";

const fx = secretBox();
after(fx.dispose);
const { root, home, agentDir, project, SECRETS, call } = fx;

describe("the Overseer's find and grep never return a secret", () => {
  test("find: a search from a parent never names a secret", async () => {
    const all = await call("find", { pattern: "*", path: root });
    const found = new Set(all.split("\n").map((l) => l.replace(/\/$/, "")));
    for (const [what, p] of Object.entries(SECRETS)) assert.ok(!found.has(p.slice(root.length + 1)), `${what} in find output`);
    assert.doesNotMatch(all, /id_ed25519|credentials|hosts\.yml|\.netrc|k\.key|auth\.json(?!c)|\.claude\.json|hardlink|agent-hardlink|copy-link|\.pem|\.p12|\.pfx|\.pgpass|\/id_rsa$/m);
    assert.match(all, /id_rsa\.pub/);
    assert.match(all, /proj\/src\/main\.ts/);
    assert.match(all, /\.env\.example/);
    assert.match(await call("find", { pattern: "*.json", path: join(home, ".pi") }), /settings\.json/);
    assert.doesNotMatch(await call("find", { pattern: "auth.json", path: home }), /auth\.json/);
  });

  test("grep: a recursive search from a parent returns no secret's lines", async () => {
    for (const from of [root, home, project, join(home, ".pi"), agentDir, join(root, "worktrees")]) {
      const out = await call("grep", { pattern: "TOKEN", path: from, context: from === home ? 1 : 0 });
      // The file each output line names (pi's "path:N: text" and "path-N- text").
      const files = new Set(out.split("\n").map((l) => resolve(from, /^(.*?)(?::|-)\d+(?::|-) /.exec(l)?.[1] ?? "")));
      for (const [what, p] of Object.entries(SECRETS)) assert.ok(!files.has(p), `${what} from ${from}: ${out}`);
      assert.doesNotMatch(out, /auth\.json(?!c)|models\.json|credentials|id_ed25519|hosts\.yml|\.netrc|\.env(\.local)?:|hardlink|copy-link|\.pem|\.key:|\.p12|\.pfx|\.pgpass|\.claude\.json|id_rsa:/, from);
    }
    const fromHome = await call("grep", { pattern: "TOKEN", path: home });
    assert.match(fromHome, /^proj\/src\/main\.ts:1: TOKEN=1 in a file$/m, "pi's own line format");
    assert.match(fromHome, /^proj\/\.env\.example:1:/m);
    assert.equal(await call("grep", { pattern: "TOKEN", path: agentDir }), "No matches found");
  });
});

describe("the project overseer's find and grep stay inside the project root", () => {
  const { box, pcall } = confinedBox(fx);

  test("find: searches from the root are held to it, whatever the pattern", async () => {
    for (const pattern of ["*", "**/*", "roster.json", "../*", "/**", `${box}/**`, "**/outside.txt"]) {
      const out = await pcall("find", { pattern });
      assert.doesNotMatch(out, /roster\.json|outside\.txt|baton-links|AGENTS|\.env$/m, pattern);
    }
    assert.match(await pcall("find", { pattern: "*.ts" }), /src\/a\.ts/);
  });

  test("grep: searches from the root are held to it, whatever the glob", async () => {
    for (const glob of [undefined, "**", "../**", "**/roster.json", "*.json"]) {
      const out = await pcall("grep", { pattern: "MARK", ...(glob ? { glob } : {}) });
      assert.doesNotMatch(out, /roster|outside|baton-links|AGENTS/, `glob ${glob}`);
    }
    const all = await pcall("grep", { pattern: "MARK" });
    assert.match(all, /^README\.md:1: MARK here$/m);
    assert.match(all, /^src\/a\.ts:1:/m);
  });

  // The unit files run fd and rg in-process (server/search-tools-fake.ts): here, held to the real ones.
  test("the in-process fd and rg stand-in answers these searches as the real programs do", async () => {
    const searches: [typeof pcall, string, Record<string, unknown>][] = [
      [call, "find", { pattern: "*", path: root }],
      [call, "find", { pattern: "*.json", path: join(home, ".pi") }],
      [call, "find", { pattern: "auth.json", path: home }],
      [call, "grep", { pattern: "TOKEN", path: home, context: 1 }],
      [call, "grep", { pattern: "token", path: project, ignoreCase: true }],
      [call, "grep", { pattern: "TOKEN=1", path: project, literal: true, glob: "*.ts" }],
      [call, "grep", { pattern: "zzz-no-such-text", path: project }],
      [pcall, "find", { pattern: "**/*" }],
      [pcall, "find", { pattern: "src/*.ts" }],
      [pcall, "grep", { pattern: "MARK", glob: "**" }],
    ];
    const lines = (s: string) => s.split("\n").sort();
    const real: string[][] = [];
    for (const [f, name, params] of searches) real.push(lines(await f(name, params)));
    setSearchSpawnForTest(fakeSearchSpawn());
    try {
      for (const [i, [f, name, params]] of searches.entries()) assert.deepEqual(lines(await f(name, params)), real[i], `${name} ${JSON.stringify(params)}`);
    } finally {
      setSearchSpawnForTest(null);
    }
  });
});
