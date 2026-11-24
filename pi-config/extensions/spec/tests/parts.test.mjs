// Split topics: a claim cut into parts, its summary listing them, reads as the one topic it was. The same spec, written
// whole and written split, gives the same answers in where, toc and the census; a list that is no summary splits nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, write, CORE } from "./map-fixture.mjs";

const RULES = "The gate reads the `x-sova-token` header and refuses a request without it.\n\nCross-site requests are refused by `Origin`, and sockets carry the token in `?token=`.\n";
const EXCEPTIONS = "The `/api/health` route is never asked for the token, and `X-Forwarded-For` is trusted only from a peer.\n";
const SUMMARY = "- §app.gate/check-rules — The token and the cross-site rules\n- §app.gate/check-exceptions — What is never asked for the token\n";
const HEAD = "# §app/gate — The gate\n\nThe gate stands in front of every route.\n\n";
const UNLOCK = "## §app.gate/unlock — The first visit\n\nA first visit opens the unlock page, which asks for the token once.\n";
const WHOLE = `${HEAD}## §app.gate/check — What the gate checks\n\n${RULES}\n${EXCEPTIONS}\n${UNLOCK}`;
const split = (summary = SUMMARY, rest = "") =>
  `${HEAD}## §app.gate/check — What the gate checks\n\n${summary}${rest}\n## §app.gate/check-rules — The token and the cross-site rules\n\n${RULES}\n` +
  `## §app.gate/check-exceptions — What is never asked for the token\n\n${EXCEPTIONS}\n${UNLOCK}`;
const PARTS = ["§app.gate/check-rules", "§app.gate/check-exceptions"];
// Each part keeps the code its passage was mapped by; the topic keeps the union.
const RECORDS = {
  "§app/gate": { kind: "surface", requires: [] },
  "§app.gate/unlock": { kind: "behavior", requires: [], code: ["src/unlock.ts"] },
  "§ot/other": { kind: "behavior", requires: [], code: ["src/gate.ts"] },
  "§ot/far": { kind: "note", requires: [] },
};
const WHOLE_RECORDS = { ...RECORDS, "§app.gate/check": { kind: "behavior", requires: [], code: ["src/gate.ts", "src/socket.ts"] } };
const SPLIT_RECORDS = { ...RECORDS, "§app.gate/check": { kind: "behavior", requires: PARTS, code: ["src/gate.ts", "src/socket.ts"] },
  "§app.gate/check-rules": { kind: "behavior", requires: [], code: ["src/gate.ts", "src/socket.ts"] },
  "§app.gate/check-exceptions": { kind: "behavior", requires: [], code: ["src/gate.ts"] } };

function spec({ text = WHOLE, records = WHOLE_RECORDS, root = mkdtempSync(join(tmpdir(), "spec-parts-")) } = {}) {
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["src"], exclude: [] }, claims: records }, null, 2) + "\n");
  write(root, ".sova/spec/claims/app/gate.md", text);
  write(root, ".sova/spec/claims/ot/other.md", "# §ot/other — Other\n\nLogging copies the `x-sova-token` header name, never its value.\n");
  write(root, ".sova/spec/claims/ot/far.md", "# §ot/far — Far\n\nNothing about gates.\n");
  write(root, "src/gate.ts", 'const H = "x-sova-token"; if (path === "/api/health") ok(); check(req.headers.Origin, "X-Forwarded-For");\n');
  write(root, "src/socket.ts", 'const url = `/ws?token=${t}`; // ?token=\n');
  write(root, "src/unlock.ts", "export const unlock = 1;\n");
  write(root, "src/unmapped.ts", 'send("x-sova-token", "?token=");\n');
  return root;
}
const whole = () => spec(), splitSpec = (o = {}) => spec({ text: split(o.summary, o.rest), records: { ...SPLIT_RECORDS, ...o.records } });
const checkOf = (root) => cli(root, ["check"]).j;
const broken = (root) => checkOf(root).findings.filter((f) => f.code === "split-summary-broken").map((f) => f.message);
// A part's id read as its topic's, so a whole and a split answer compare row by row.
const asTopic = (id) => (PARTS.includes(id) ? "§app.gate/check" : id);

test("a summary of the claims declared right after it, each required, its line their heading word for word, makes a split topic", () => {
  const root = splitSpec();
  assert.deepEqual(checkOf(root).counts.split, { topics: 1, parts: 2 });
  assert.deepEqual(broken(root), []);
  const down = cli(root, ["toc", "§app.gate/check", "--dir", "down"]).j;
  assert.deepEqual(down.lines.map((l) => [l.group, l.id]), PARTS.map((p) => ["parts", p]), "toc down lists the parts, in the summary's order");
  assert.deepEqual(cli(root, ["toc", PARTS[1], "--dir", "up"]).j.lines.map((l) => [l.group, l.id]), [["topic", "§app.gate/check"], ["parent", "§app/gate"]]);
  assert.deepEqual(cli(root, ["read", "§app.gate/check"]).j.items[0].parts, [
    { id: PARTS[0], title: "The token and the cross-site rules" }, { id: PARTS[1], title: "What is never asked for the token" }]);
  assert.equal(checkOf(whole()).counts.split, undefined, "nothing split: no split count at all");
  assert.equal(cli(whole(), ["read", "§app.gate/check"]).j.items[0].parts, undefined);
});

test("a list that is no summary splits nothing and warns nothing: fenced, in a comment, an ordinary requires list, claims declared elsewhere, the next claims out of order or mixed with others in its own words", () => {
  const cases = {
    fenced: "```md\n" + SUMMARY + "```\n",
    comment: "<!--\n" + SUMMARY + "-->\n",
    "requires list": "Depends on:\n\n- §app.gate/unlock — the first visit asks for the token\n- §ot/other — logs the header\n",
    "claims elsewhere": "- §ot/other — Other\n- §ot/far — Far\n",
    "the next claim and one elsewhere, in its own words": "It relies on two others:\n\n- §app.gate/check-rules — the token rules it applies\n- §ot/other — what logs the header\n",
    "the next claims out of order, in its own words": "It relies on two others:\n\n- §app.gate/check-exceptions — what it lets through\n- §app.gate/check-rules — the token rules it applies\n",
  };
  for (const [name, summary] of Object.entries(cases)) {
    const root = splitSpec({ summary });
    assert.equal(checkOf(root).counts.split, undefined, `${name}: not a split topic`);
    assert.deepEqual(broken(root), [], `${name}: no warning`);
    assert.deepEqual(cli(root, ["toc", "§app.gate/check", "--dir", "down"]).j.lines, [], `${name}: toc down lists no parts`);
  }
});

test("a summary that names the claim declared next but breaks the pattern warns, and nothing is grouped", () => {
  const swap = SUMMARY.split("\n").filter(Boolean).reverse().join("\n") + "\n";
  const cases = [
    [{ summary: SUMMARY.split("\n")[0] + "\n" }, /lists one part \(a split topic has at least 2\)/],
    [{ summary: SUMMARY.replace("The token and the cross-site rules", "Token rules") }, /its line for §app\.gate\/check-rules says "Token rules", not the part's heading "The token and the cross-site rules"/],
    [{ records: { "§app.gate/check": { kind: "behavior", requires: [PARTS[0]], code: ["src/gate.ts"] } } }, /it does not require §app\.gate\/check-exceptions/],
    [{ summary: SUMMARY + "- §app.gate/unlock — The first visit\n", records: { "§app.gate/check": { kind: "behavior", requires: [...PARTS, "§app.gate/unlock"] } } }, null],
    [{ rest: "\nThe parts above cover it.\n" }, /its list of the claims after it is not the end of its prose/],
    [{ summary: "- §app.gate/check-rules — Rules\n- §app.gate/check-exceptions — Exceptions\n" }, /its line for §app\.gate\/check-rules says "Rules", not the part's heading "The token and the cross-site rules"/],
  ];
  for (const [o, why] of cases) {
    const root = splitSpec(o);
    if (!why) { assert.deepEqual(checkOf(root).counts.split, { topics: 1, parts: 3 }, "three parts in a row, each in order: still a summary"); continue; }
    const [msg, ...more] = broken(root);
    assert.match(msg ?? "", why);
    assert.match(msg, /^§app\.gate\/check ends in a summary .*: it is not read as a split topic, so search and lookups list it and those claims separately$/);
    assert.deepEqual(more, []);
    assert.equal(checkOf(root).counts.split, undefined);
  }
  assert.match(broken(splitSpec({ summary: swap }))[0], /its summary does not list §app\.gate\/check-rules, the claim declared after it, first/, "out of order");
  // The known limit: a list of what it relies on that names exactly the claims declared next, in order, is a summary
  // whose parts were all renamed as far as the rule can tell.
  assert.match(broken(splitSpec({ summary: "It relies on two others:\n\n- §app.gate/check-rules — the token rules it applies\n- §app.gate/check-exceptions — what it lets through\n" }))[0] ?? "", /says "the token rules it applies", not the part's heading/);
});

test("a part that is a split topic itself: the outer summary is broken, the inner topic stands", () => {
  const inner = "## §app.gate/check-exceptions — What is never asked for the token\n\n- §app.gate/health — The health route\n- §app.gate/peers — Peers\n\n" +
    "## §app.gate/health — The health route\n\nThe `/api/health` route is never asked for the token.\n\n## §app.gate/peers — Peers\n\n`X-Forwarded-For` is trusted only from a peer.\n\n";
  const text = split().replace(`## §app.gate/check-exceptions — What is never asked for the token\n\n${EXCEPTIONS}\n`, inner);
  const root = spec({ text, records: { ...SPLIT_RECORDS, "§app.gate/check-exceptions": { kind: "behavior", requires: ["§app.gate/health", "§app.gate/peers"] },
    "§app.gate/health": { kind: "behavior", requires: [] }, "§app.gate/peers": { kind: "behavior", requires: [] } } });
  assert.deepEqual(checkOf(root).counts.split, { topics: 1, parts: 2 });
  assert.match(broken(root)[0], /its part §app\.gate\/check-exceptions is a split topic itself/);
});

test("where FILE: a split topic is one row, scored and ordered exactly as the whole claim, saying how many of its parts list the file", () => {
  const a = whole(), b = splitSpec();
  for (const file of ["src/gate.ts", "src/socket.ts", "src/unmapped.ts"]) {
    const before = cli(a, ["where", file]).j, after = cli(b, ["where", file]).j;
    const rows = (j) => j.lines.map((l) => ({ type: l.type, id: asTopic(l.id), score: l.score, shared: l.shared, tokens: l.tokens }));
    assert.deepEqual(rows(after), rows(before), `${file}: same rows, same order, same scores`);
    assert.deepEqual(after.counts, before.counts, `${file}: counts topics, not parts`);
    assert.ok(before.lines.some((l) => l.score > 0), `${file}: the check ranks something`);
  }
  const gate = cli(b, ["where", "src/gate.ts"]).j.lines.find((l) => l.id === "§app.gate/check");
  assert.deepEqual(gate.parts, { listing: 2, of: 2 });
  assert.deepEqual(cli(b, ["where", "src/socket.ts"]).j.lines.find((l) => l.id === "§app.gate/check").parts, { listing: 1, of: 2 });
  assert.match(cli(b, ["where", "src/socket.ts"], { json: false }).r.stdout, /^  §app\.gate\/check — What the gate checks  behavior · unlabelled · score [\d.]+ · 1 of its 2 parts list it too$/m);
  const only = spec({ text: split(), records: { ...SPLIT_RECORDS, "§app.gate/check": { kind: "behavior", requires: PARTS, code: ["src/gate.ts"] } } });
  const row = cli(only, ["where", "src/socket.ts"]).j.lines.find((l) => l.id === "§app.gate/check");
  assert.deepEqual(row.parts, { listing: 1, of: 2, topic: false }, "listed only through a part: still the topic's row");
  assert.match(cli(only, ["where", "src/socket.ts"], { json: false }).r.stdout, / · listed by 1 of its 2 parts$/m);
  assert.ok(cli(b, ["where", "src/gate.ts"]).j.lines.every((l) => !PARTS.includes(l.id)), "no part is a row of its own");
});

test("where NAME: a name a part holds lists its topic once, naming that part; never the part and its topic as two rows", () => {
  const a = whole(), b = splitSpec();
  for (const name of ["x-sova-token", "/api/health", "Origin"]) {
    const before = cli(a, ["where", name]).j, after = cli(b, ["where", name]).j;
    const ids = (j) => j.lines.map((l) => l.id);
    const named = (j) => j.lines.filter((l) => l.type !== "topic").map((l) => [l.id, l.spans]);
    assert.deepEqual(named(after), named(before), `${name}: the same claims hold the name, with the same spans`);
    assert.equal(new Set(ids(after).map(asTopic)).size, ids(after).length, `${name}: no topic listed twice`);
    assert.ok(ids(after).every((id) => !PARTS.includes(id)), `${name}: no part as a row`);
  }
  const health = cli(b, ["where", "/api/health"]).j.lines.find((l) => l.id === "§app.gate/check");
  assert.deepEqual(health.part, { id: PARTS[1], title: "What is never asked for the token" });
  assert.equal(health.type, "defines", "a part's first sentence is the topic's: it defines the name there (the whole claim only mentioned it)");
  assert.match(cli(b, ["where", "/api/health"], { json: false }).r.stdout, /^    in part: §app\.gate\/check-exceptions — What is never asked for the token$/m);
});

test("where WORDS: a split topic is scored on exactly the whole claim's words, so every row and score is the whole spec's; its best-matching part named under it", () => {
  // A table cut between two parts: the second part opens with the head again, so that it stands alone; the whole had it once.
  const head = "| Field | Meaning |\n|---|---|\n", row1 = "| `token` | the caller's key |\n", row2 = "| `health` | never asked |\n";
  const pairs = [[whole(), splitSpec()],
    [spec({ text: WHOLE.replace(`${RULES}\n${EXCEPTIONS}`, `${RULES}\n${head}${row1}${row2}\n${EXCEPTIONS}`) }),
      spec({ text: split().replace(`${RULES}\n## §app.gate/check-exceptions — What is never asked for the token\n\n${EXCEPTIONS}`,
        `${RULES}\n${head}${row1}\n## §app.gate/check-exceptions — What is never asked for the token\n\n${head}${row2}\n${EXCEPTIONS}`), records: SPLIT_RECORDS })]];
  const rows = (j) => j.lines.map((l) => [l.type, l.id, l.score, l.matched]);
  const queries = [["health", "route", "token"], ["cross", "site", "sockets"], ["gate", "token"]];
  for (const [k, [a, b]] of pairs.entries()) for (const q of [...queries, ...(k ? [["field", "meaning", "caller"]] : [])]) {
    const before = cli(a, ["where", ...q]).j, after = cli(b, ["where", ...q]).j;
    assert.ok(before.lines.length, `${q.join(" ")}: something ranks`);
    assert.deepEqual(rows(after), rows(before), `${q.join(" ")}: the same rows, in the same order, with the same scores`);
  }
  const b = pairs[0][1];
  assert.ok(WHOLE.includes(`${RULES}\n${EXCEPTIONS}`) && split().includes(`${RULES}\n## §app.gate/check-exceptions — What is never asked for the token\n\n${EXCEPTIONS}`), "the table fixture's anchors exist");
  const top = (q) => cli(b, ["where", ...q]).j.lines.find((l) => l.id === "§app.gate/check");
  assert.equal(top(["health", "route", "peer"]).part.id, PARTS[1]);
  assert.equal(top(["cross", "site", "sockets"]).part.id, PARTS[0]);
  assert.equal(top(["checks"]).part, undefined, "words only the topic's own heading holds: no part named");
  assert.match(cli(b, ["where", "health", "route", "peer"], { json: false }).r.stdout, /^    matched: .*\n    best part: §app\.gate\/check-exceptions — What is never asked for the token$/m);
});

// ---------------------------------------------------------------- census
const fixtureEnv = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });
const git = (root, ...a) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=master", "-C", root, ...a], { encoding: "utf8", env: fixtureEnv(root) });
  assert.equal(r.status, 0, r.stderr);
};
function changed(root) {
  write(root, ".gitignore", ".sova/spec/drafts/\n");
  git(root, "init", "-q"); git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  write(root, "src/gate.ts", readFileSync(join(root, "src/gate.ts"), "utf8").replace('"/api/health"', '"/api/ready"'));
  write(root, "src/socket.ts", 'const url = `/ws?token=${t}&v=2`;\n');
  const r = spawnSync(process.execPath, [CORE, "census", "--changed", "--related", "--root", root, "--json"], { encoding: "utf8", cwd: root, env: fixtureEnv(root) });
  return JSON.parse(r.stdout).census;
}

test("census: a split topic ranks once, as the whole claim did, naming the touched part the change fits; its parts keep their own touched entries", () => {
  const before = changed(whole()), after = changed(splitSpec());
  const row = (r) => ({ id: r.id, rank: r.rank, score: r.score, fanIn: r.fanIn, relevance: r.relevance, reason: r.reason, stale: r.stale });
  assert.deepEqual(after.rank.map(row), before.rank.map(row), "same rows, scores, fan-in and relevance as the whole claim");
  assert.deepEqual([after.readFirst, after.named], [before.readFirst, before.named]);
  const topic = after.rank.find((r) => r.id === "§app.gate/check");
  assert.equal(topic.part, PARTS[1], "the removed /api/health is the exceptions part's");
  assert.deepEqual(topic.parts, PARTS);
  assert.deepEqual(topic.files, ["src/gate.ts", "src/socket.ts"]);
  assert.deepEqual(after.foreign.filter((id) => id.startsWith("§app.gate/check")).sort(), ["§app.gate/check", ...PARTS].sort(), "each touched record is still foreign");
  for (const p of PARTS) assert.equal(after.touched.find((t) => t.id === p).rank, topic.rank, `${p} carries its topic's rank`);
  assert.equal(before.rank.find((r) => r.id === "§app.gate/check").part, undefined, "a whole claim's row has no part fields");
});
