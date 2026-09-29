// Run: npx tsx --test src/lib/claude-login-groups.test.ts
// Claude logins by account (§app.claude-logins/registry): the blocks, their moves, and the names.
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountGroups, addedText, type LoginFacts, loginName, moveAccount, moveLogin, sharedQuotaText } from "./claude-login-groups";

const f = (l: LoginFacts) => l;
// Account A has two logins, B one, and one login has no known account.
const A1: LoginFacts = { id: "l-0000000a", account: "acct-a", addedAt: 100 };
const B1: LoginFacts = { id: "l-0000000b", account: "acct-b", addedAt: 150 };
const A2: LoginFacts = { id: "l-000000a2", account: "acct-a", addedAt: 200 };
const X: LoginFacts = { id: "l-0000000c", addedAt: 300 };

test("an account's logins fold into one block, where its first login falls", () => {
  const groups = accountGroups([A1, B1, A2, X], f);
  assert.deepEqual(groups.map((g) => g.logins.map((l) => l.id)), [[A1.id, A2.id], [B1.id], [X.id]]);
  assert.deepEqual(groups.map((g) => g.key), ["acct-a", "acct-b", X.id], "a login with no account is its own block, keyed by itself");
});

test("moving an account moves all its logins; the ends refuse", () => {
  const groups = accountGroups([A1, A2, B1, X], f);
  assert.deepEqual(moveAccount(groups, 0, 1, f), [B1.id, A1.id, A2.id, X.id]);
  assert.deepEqual(moveAccount(groups, 2, -1, f), [A1.id, A2.id, X.id, B1.id]);
  assert.equal(moveAccount(groups, 0, -1, f), null);
  assert.equal(moveAccount(groups, 2, 1, f), null);
});

test("moving a login stays inside its account", () => {
  const groups = accountGroups([A1, A2, B1], f);
  assert.deepEqual(moveLogin(groups, 0, 1, -1, f), [A2.id, A1.id, B1.id]);
  assert.equal(moveLogin(groups, 0, 1, 1, f), null, "the account's last login can't leave it downwards");
  assert.equal(moveLogin(groups, 1, 0, -1, f), null, "nor its first upwards, into the account above");
});

test("a login is named by its label, else Login N by when it was added", () => {
  const account = [A2, A1];
  assert.equal(loginName(A1, account), "Login 1");
  assert.equal(loginName(A2, account), "Login 2", "the order shown doesn't renumber");
  assert.equal(loginName({ ...A2, label: "Laptop" }, account), "Laptop");
  assert.equal(loginName({ id: "default", account: "acct-a" }, [...account, { id: "default" }]), "Claude Code's own login");
  assert.equal(loginName(A2, [A2, A1, { id: "default" }]), "Login 2", "default takes no number");
  // Two names never collide for unlabelled logins of one account.
  const names = new Set([A1, A2].map((l) => loginName(l, account)));
  assert.equal(names.size, 2);
});

test("added date and the shared quota line", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  assert.equal(addedText(Date.parse("2026-09-28T12:00:00Z"), now), "added Sep 28");
  assert.equal(addedText(undefined, now), null);
  assert.equal(sharedQuotaText(2), "2 logins share one quota");
  assert.equal(sharedQuotaText(1), null);
});
