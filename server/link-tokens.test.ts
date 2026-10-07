// Run: pnpm test -- server/link-tokens.test.ts. §app.session-share/link (Kept tokens): the one file
// that keeps every /s/, /h/ and /i/ token, through the three stores' own mint and turn-off paths
// (keep, drop on every turn-off, never on expiry), its tolerance (a broken file, a tampered or
// malformed entry), 0600, and the share views' "[share link]" filter as a pure function
// (§app.session-share/never). A throwaway PI_CODING_AGENT_DIR in the OS temp dir, deleted after.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-link-tokens-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
after(() => rmSync(root, { recursive: true, force: true }));

const kept = await import("./link-tokens");
const batonLinks = await import("./baton-links");
const personLinks = await import("./person-links");
const shares = await import("./session-shares");

const fileText = () => readFileSync(kept.linkTokensFile(), "utf8");

describe("keep and drop, per kind", () => {
  test("a hand-off link (/h/): kept at its mint, dropped when it is turned off", () => {
    const token = batonLinks.mintLink({ orgId: "o1", sessionId: "s1", n: 1, personId: "p1" });
    const hash = batonLinks.hashToken(token);
    assert.equal(kept.tokenFor(hash), token);
    assert.equal(kept.tokenFor(hash, "h"), token);
    assert.equal(kept.tokenFor(hash, "s"), null, "the kind must match when asked");
    assert.equal(statSync(kept.linkTokensFile()).mode & 0o777, 0o600);
    batonLinks.revokeLinks((l) => l.hash === hash);
    assert.equal(kept.tokenFor(hash), null);
    assert.ok(!fileText().includes(token), "gone from the file");
  });

  test("a hand-off link that merely expires stays kept", () => {
    const token = batonLinks.mintLink({ orgId: "o1", sessionId: "s2", n: 1, personId: "p1" }, Date.now() - 30 * 86_400_000);
    const hash = batonLinks.hashToken(token);
    assert.ok(batonLinks.linkDead(batonLinks.findLink(token)!), "control: expired");
    assert.equal(kept.tokenFor(hash), token);
  });

  test("an owner link (/i/): kept at its mint, dropped when a new one replaces it and when it is turned off", () => {
    const a = personLinks.mintOwnerLink("o2", "p2");
    assert.equal(kept.tokenFor(a.record.hash, "i"), a.token);
    const b = personLinks.mintOwnerLink("o2", "p2");
    assert.equal(kept.tokenFor(a.record.hash), null, "the replaced one is dropped");
    assert.equal(kept.tokenFor(b.record.hash, "i"), b.token);
    personLinks.revokePersonLinks((l) => l.orgId === "o2", "off");
    assert.equal(kept.tokenFor(b.record.hash), null);
  });

  test("a session share link (/s/): kept at create and add, the old one dropped at relink, dropped at revoke and stop", () => {
    const { share, tokens } = shares.createShare({ sessionId: "x", sessionPath: "/tmp/x.jsonl", title: "T", mode: "live", cut: null, days: 30, labels: ["Ana", "Ben"], anyone: false });
    const [ana, ben] = tokens;
    for (const t of tokens) assert.equal(kept.tokenFor(batonLinks.hashToken(t.token), "s"), t.token);
    const added = shares.addRecipient(share.id, { anyone: true });
    assert.equal(kept.tokenFor(batonLinks.hashToken(added.token), "s"), added.token);
    const relinked = shares.relinkRecipient(share.id, ana!.recipientId);
    assert.equal(kept.tokenFor(batonLinks.hashToken(ana!.token)), null, "the relinked one is dropped");
    assert.equal(kept.tokenFor(batonLinks.hashToken(relinked.token), "s"), relinked.token);
    shares.revokeRecipient(share.id, ben!.recipientId);
    assert.equal(kept.tokenFor(batonLinks.hashToken(ben!.token)), null);
    shares.stopShare(share.id);
    for (const t of [added, relinked]) assert.equal(kept.tokenFor(batonLinks.hashToken(t.token)), null, "stop drops every link's");
    // The store's own file never carries a token, and still passes its strict parse with its old keys.
    const raw = readFileSync(shares.sharesFile(), "utf8");
    for (const t of [ana, ben, added, relinked]) assert.ok(!raw.includes(t!.token));
    assert.ok(!("why" in shares.validateSharesFile(JSON.parse(raw))));
  });

  test("archiving a session drops its shares' tokens", () => {
    const { tokens } = shares.createShare({ sessionId: "arch", sessionPath: "/tmp/arch.jsonl", title: "T", mode: "live", cut: null, days: 30, labels: ["Ana"], anyone: false });
    shares.stopSharesOfSession("arch");
    assert.equal(kept.tokenFor(batonLinks.hashToken(tokens[0]!.token)), null);
  });
});

describe("read tolerantly", () => {
  test("a tampered, malformed or misnamed entry is left out alone; the rest stay", () => {
    const good = batonLinks.mintLink({ orgId: "o3", sessionId: "s3", n: 1, personId: "p3" });
    const goodHash = batonLinks.hashToken(good);
    const other = batonLinks.mintLink({ orgId: "o3", sessionId: "s4", n: 1, personId: "p3" });
    const otherHash = batonLinks.hashToken(other);
    const doc = JSON.parse(fileText());
    doc.tokens[otherHash].token = good; // a token that doesn't hash to its key
    doc.tokens["f".repeat(64)] = { kind: "h", token: "short" };
    doc.tokens["nothex"] = { kind: "h", token: good };
    doc.tokens[batonLinks.hashToken("A".repeat(43))] = { kind: "x", token: "A".repeat(43) };
    writeFileSync(kept.linkTokensFile(), JSON.stringify(doc));
    assert.equal(kept.tokenFor(goodHash), good);
    assert.equal(kept.tokenFor(otherHash), null, "tampered");
    assert.equal(kept.tokenFor("f".repeat(64)), null);
    assert.equal(kept.tokenFor(batonLinks.hashToken("A".repeat(43))), null, "an unknown kind");
    assert.ok(kept.keptTokens().every((k) => batonLinks.hashToken(k.token) === k.hash));
  });

  test("a file that isn't JSON keeps nothing, and links still mint; the next write replaces it", () => {
    writeFileSync(kept.linkTokensFile(), "{not json");
    assert.deepEqual(kept.keptTokens(), []);
    const token = batonLinks.mintLink({ orgId: "o4", sessionId: "s5", n: 1, personId: "p4" });
    assert.ok(batonLinks.findLink(token), "the link itself works");
    assert.equal(kept.tokenFor(batonLinks.hashToken(token)), token, "and is kept again from here");
  });
});

describe("the share views' filter (pure)", () => {
  const T = "Q".repeat(20) + "abcdefghijklmnopqrstuvw"; // 43 characters
  const OTHER = "Z".repeat(43);
  const set = new Set([T]);

  test("a kept link becomes [share link] in every form it stands in: full URL, a path, the bare token", () => {
    assert.equal(T.length, 43);
    for (const kind of ["s", "h", "i"])
      assert.equal(kept.redactShareLinks(`see https://share.example.invalid/${kind}/${T} now`, set), "see [share link] now");
    assert.equal(kept.redactShareLinks(`open /h/${T}.`, set), "open [share link].");
    assert.equal(kept.redactShareLinks(`token ${T}`, set), "token [share link]");
  });

  test("a link not kept, and a longer run of token characters, stay as written", () => {
    const text = `https://share.example.invalid/s/${OTHER} and x${T}y`;
    assert.equal(kept.redactShareLinks(text, set), text);
    assert.equal(kept.redactShareLinks(text, new Set()), text);
  });

  test("deep: every string of a value, and only a copy when one is there", () => {
    const v = { title: `about /s/${T}`, items: [{ text: `go https://h.example.invalid/i/${T}` }, { text: "plain" }] };
    assert.deepEqual(kept.redactShareLinksDeep(v, set), { title: "about [share link]", items: [{ text: "go [share link]" }, { text: "plain" }] });
    const clean = { a: "nothing here" };
    assert.equal(kept.redactShareLinksDeep(clean, set), clean);
  });
});
