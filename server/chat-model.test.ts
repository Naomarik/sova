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
import { modelForSessionOpen, recordedModelForEmptyBranch, restatesRecordedModel } from "./chat-manager";

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
const SAVED = { provider: "ollama-cloud", id: "deepseek-v4.1-flash", contextWindow: 128_000 };

test("open-time model precedence: recorded fanout choice outranks a different global default", () => {
  const rt = runtime({ "zai/glm-5.3": GLM, "ollama-cloud/deepseek-v4.1-flash": SAVED }, ["zai", "ollama-cloud"]);
  const saved = rt.getModel(SAVED.provider, SAVED.id)!;
  const sm = manager([], { provider: "zai", modelId: "glm-5.3" });
  assert.equal(modelForSessionOpen(sm, rt, saved), GLM);
  assert.equal(modelForSessionOpen(sm, rt, undefined), GLM);
});

test("open-time model precedence: absent, unknown or unauthenticated recording falls to eligible saved default", () => {
  const rt = runtime({ "zai/glm-5.3": GLM, "ollama-cloud/deepseek-v4.1-flash": SAVED }, ["ollama-cloud"]);
  const saved = rt.getModel(SAVED.provider, SAVED.id)!;
  for (const recorded of [null, { provider: "zai", modelId: "missing" }, { provider: "zai", modelId: "glm-5.3" }]) {
    assert.equal(modelForSessionOpen(manager([], recorded), rt, saved), saved);
    assert.equal(modelForSessionOpen(manager([], recorded), rt, undefined), undefined, "no eligible override leaves the SDK to choose");
  }
});

test("open-time model precedence: ordinary history without eligible default stays SDK-owned", () => {
  assert.equal(modelForSessionOpen(
    manager([{ role: "user" }], { provider: "zai", modelId: "glm-5.3" }),
    runtime({ "zai/glm-5.3": GLM }, ["zai"]), undefined,
  ), undefined);
});

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

/** The branch context the two helpers read, as buildSessionContext() would report it. */
const context = (messages: Message[], model: Recorded) => manager(messages, model).buildSessionContext();

test("only a message-less branch that already records that exact model calls the append a restatement", () => {
  const recorded = context([], { provider: "zai", modelId: "glm-5.3" });
  // The shape a fanout member opens as: dropping this is the point — the alternative is the same
  // `Model:` row twice in every pane, because transcript.ts renders one row per entry.
  assert.equal(restatesRecordedModel(recorded, "zai", "glm-5.3"), true, "the recorded pair, once");
  // A different pair is a real change and must be written: the fallback default that follows an
  // unauthenticated recorded model, and a different model of the same provider.
  assert.equal(restatesRecordedModel(recorded, "ollama-cloud", "deepseek-v4.1-flash"), false, "the default is not a restatement");
  assert.equal(restatesRecordedModel(recorded, "zai", "glm-4.7"), false, "nor is a sibling model of the same provider");
  // With messages on the branch that append is the SDK's own resume record: queued as before,
  // which is what keeps this filter from reaching every ordinary session open.
  assert.equal(restatesRecordedModel(context([{ role: "user" }], { provider: "zai", modelId: "glm-5.3" }), "zai", "glm-5.3"), false, "a message-ful branch keeps its append");
  // Header-only and nothing recorded: the default append must land, which is how such a session
  // comes to record a model at all.
  assert.equal(restatesRecordedModel(context([], null), "ollama-cloud", "deepseek-v4.1-flash"), false, "nothing recorded, nothing restated");
});
