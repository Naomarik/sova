// The Claude login card's choices and toast (§app.claude-logins/project-login).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardChoices, savedText } from "./claude-login-card";

const options = [{ id: "default", name: "This computer's own login" }, { id: "l-0000000a", name: "a@example.com" }];

test("a placed project offers Same as organization first, naming the org's login; a standalone one and an org don't", () => {
  assert.deepEqual(cardChoices({ kind: "project", placed: true, orgLogin: "l-0000000a", setting: "org", options }).map((c) => c.label), [
    "Same as organization (a@example.com)",
    "No preference (this computer's order)",
    "This computer's own login",
    "a@example.com",
  ]);
  assert.equal(cardChoices({ kind: "project", placed: true, orgLogin: null, setting: "org", options })[0]!.label, "Same as organization (no preference)");
  assert.deepEqual(cardChoices({ kind: "project", setting: "none", options }).map((c) => c.value), ["none", "default", "l-0000000a"]);
  assert.deepEqual(cardChoices({ kind: "org", placed: true, setting: "none", options }).map((c) => c.value), ["none", "default", "l-0000000a"]);
});

test("a saved login this host no longer lists stays visible, so the select never shows another", () => {
  const c = cardChoices({ kind: "project", setting: "l-0000dead", options });
  assert.equal(c.at(-1)!.value, "l-0000dead");
});

test("the toast says what new chats start on", () => {
  assert.equal(savedText("project", "l-0000000a", options), "New chats in this project start on a@example.com.");
  assert.equal(savedText("org", "none", options), "New chats in this organization's projects follow this computer's order.");
  assert.equal(savedText("project", "org", options), "New chats in this project follow its organization.");
});
