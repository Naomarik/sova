// Run: npx tsx --test server/chat-model.test.ts
// Gate: the open-time half of the fanout model fix. The SDK restores a session's recorded model
// only when the branch already has MESSAGES (sdk.js gates the restore on messages.length > 0),
// so openSession must bind it itself for the one shape that has none — a fresh fanout member,
// whose file records its model and nothing else (server/fanout.ts fresh()). Hermetic on purpose:
// the stub manager answers buildSessionContext() (the SDK's own branch-aware accessor — an
// off-branch file scan would bind a model from a rewound session's abandoned branch), and the
// stub runtime answers the SDK's own two restore guards: getModel, then hasConfiguredAuth.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { recordedModelForEmptyBranch } from "./chat-manager";

type Recorded = { provider: string; modelId: string } | null;
type Message = { role: string };

/** A manager whose branch answers exactly what the stub says: messages and a recorded model. */
const manager = (messages: Message[], model: Recorded) =>
  ({ buildSessionContext: () => ({ messages, model, thinkingLevel: "off" }) }) as Pick<SessionManager, "buildSessionContext">;

/** A runtime that knows the models in `known` and has auth for `authed` providers — nothing else. */
const runtime = (known: Record<string, object>, authed: string[]) =>
  ({
    getModel: (provider: string, modelId: string) => known[`${provider}/${modelId}`],
    hasConfiguredAuth: (provider: string) => authed.includes(provider),
  }) as Pick<ModelRuntime, "getModel" | "hasConfiguredAuth">;

const GLM = { provider: "zai", id: "glm-5.3", contextWindow: 128_000 };

test("a message-less session with a recorded model binds THAT model", () => {
  // The fanout member at open: header + model_change, no messages yet.
  const resolved = recordedModelForEmptyBranch(manager([], { provider: "zai", modelId: "glm-5.3" }), runtime({ "zai/glm-5.3": GLM }, ["zai"]));
  assert.equal(resolved, GLM, "the exact model object the runtime's getModel resolved");
});

test("a branch with messages answers undefined — the SDK restores it itself", () => {
  // This is every ordinary session with history: passing a model here would fight the SDK's own
  // restore path (it also wins for thinking level), so the helper must stay out of the way.
  const resolved = recordedModelForEmptyBranch(manager([{ role: "user" }], { provider: "zai", modelId: "glm-5.3" }), runtime({ "zai/glm-5.3": GLM }, ["zai"]));
  assert.equal(resolved, undefined);
});

test("an unknown model answers undefined, and so does one without auth — never fail the open", () => {
  // Both are the SDK's own restore guards: on either failure the open falls back to the
  // server default, exactly as the SDK does for sessions it restores itself.
  assert.equal(recordedModelForEmptyBranch(manager([], { provider: "zai", modelId: "nope" }), runtime({}, ["zai"])), undefined);
  assert.equal(recordedModelForEmptyBranch(manager([], { provider: "zai", modelId: "glm-5.3" }), runtime({ "zai/glm-5.3": GLM }, [])), undefined);
});

test("a message-less session that records nothing (every other new session) answers undefined", () => {
  // POST /api/sessions writes a header only: its model is chosen at the first prompt, and this
  // helper must not invent one earlier.
  assert.equal(recordedModelForEmptyBranch(manager([], null), runtime({ "zai/glm-5.3": GLM }, ["zai"])), undefined);
});
