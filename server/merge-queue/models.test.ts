import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { effectiveModel, modelsFile, openingOf, parseChoice, readModels, startingModel, writeModels, type ModelCheck } from "./models";
import { createChat } from "./thread";
import { scratchRoot } from "../test-scratch";

// §app.merge-queue/settings

const check = (off: string[] = []): ModelCheck => ({
  defaults: () => ({ model: "claude-code-cli/claude-opus-5-5", thinking: "medium" }),
  denial: (ref) => (off.includes(ref) ? `${ref} is turned off in Settings → Models` : null),
});

describe("the per-project models file", () => {
  test("each role is set and cleared on its own; a broken pick reads as unset", () => {
    const dir = scratchRoot("mq-models-");
    assert.deepEqual(readModels(dir), {});
    writeModels(dir, { review: { model: "zai/glm-5.3", thinking: "low" } });
    writeModels(dir, { thread: { model: "claude-code-cli/claude-sonnet-5" } });
    assert.deepEqual(readModels(dir), { review: { model: "zai/glm-5.3", thinking: "low" }, thread: { model: "claude-code-cli/claude-sonnet-5" } });
    writeModels(dir, { review: null });
    assert.deepEqual(readModels(dir), { thread: { model: "claude-code-cli/claude-sonnet-5" } });
    writeFileSync(modelsFile(dir), JSON.stringify({ v: 1, review: { model: "no-slash" }, thread: { model: "a/b" } }));
    assert.deepEqual(readModels(dir), { thread: { model: "a/b" } });
    assert.equal(JSON.parse(readFileSync(modelsFile(dir), "utf8")).v, 1);
  });

  test("parseChoice refuses a ref without a provider and an unknown effort", () => {
    assert.equal(parseChoice(null, "review"), null);
    assert.throws(() => parseChoice({ model: "opus" }, "review"), /provider\/model/);
    assert.throws(() => parseChoice({ model: "a/b", thinking: "huge" }, "review"), /thinking/);
  });
});

describe("what a chat starts on", () => {
  test("unset: Same as new chats, read now", async () => {
    assert.deepEqual(await effectiveModel(undefined, check()), { picked: null, effective: { model: "claude-code-cli/claude-opus-5-5", thinking: "medium" } });
    assert.equal(await openingOf(undefined, check()), null);
  });
  test("a usable pick is the chat's; one turned off falls back to the new-chat default and says why", async () => {
    const pick = { model: "zai/glm-5.3", thinking: "low" };
    assert.deepEqual(await effectiveModel(pick, check()), { picked: pick, effective: pick });
    assert.deepEqual(await openingOf(pick, check()), pick);
    const off = await effectiveModel(pick, check(["zai/glm-5.3"]));
    assert.deepEqual(off.effective, { model: "claude-code-cli/claude-opus-5-5", thinking: "medium" });
    assert.match(off.fallbackWhy ?? "", /turned off/);
    assert.equal(await openingOf(pick, check(["zai/glm-5.3"])), null);
  });
  test("startingModel reads the project's file and never throws", async () => {
    const dir = scratchRoot("mq-models-start-");
    writeModels(dir, { thread: { model: "zai/glm-5.3" } });
    assert.deepEqual(await startingModel("/p", "thread", { queueDir: dir, check: check() }), { model: "zai/glm-5.3" });
    assert.equal(await startingModel("/p", "review", { queueDir: dir, check: check() }), null);
    assert.equal(await startingModel("/p", "thread", { queueDir: dir, check: { ...check(), denial: () => Promise.reject(new Error("x")) } }), null);
  });
});

describe("createChat", () => {
  test("sends the pick as the session's model and effort, and nothing when there is none", async () => {
    const bodies: Record<string, unknown>[] = [];
    const request = async (_path: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: "stop here" }), { status: 400 });
    };
    await createChat(request, "/copy", "merge-reviewer", "hi", "t", { model: "zai/glm-5.3", thinking: "low" });
    await createChat(request, "/copy", "merge-reviewer", "hi", "t", null);
    assert.deepEqual(bodies, [
      { cwd: "/copy", profile: { source: "sova", id: "merge-reviewer" }, prompt: "hi", model: "zai/glm-5.3", thinking: "low" },
      { cwd: "/copy", profile: { source: "sova", id: "merge-reviewer" }, prompt: "hi" },
    ]);
  });
});
