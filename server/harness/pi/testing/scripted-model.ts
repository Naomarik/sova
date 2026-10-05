// The scripted model for runtime tests (§app/harness, M4's state goldens; M5's behaviour goldens reuse it):
// real pi runs up to the model call, and the model is a script. It merges the `fakeRuns` stubs the runtime
// suites each copied (overseer-runtime, topics-runtime, baton-handoff, chat-mode-sync, …): auth passes
// (`_modelRuntime.hasConfiguredAuth`, `agent.getApiKey`), and `agent.streamFunction` answers each call with
// the next scripted step. Those suites keep their own copies until they migrate.
//
// It patches the session object in place, the way the copies do, so it late-binds like them: attach it
// after `acquireChat` (and again to a runtime a dispose rebuilt). Deterministic: tool call ids are
// `call-<n>` in call order, and nothing random reaches the file.

/** A model pi can hold in `agent.state.model` (pi-ai's Model shape, untyped here). */
export interface ScriptedModelInfo {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/** The model a test agent dir's models.json registers (`scriptedModelsJson`): provider and id "scripted". */
export const SCRIPTED_MODEL: ScriptedModelInfo = {
  id: "scripted", name: "scripted", api: "openai-completions", provider: "scripted", baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};

/** A models.json that makes SCRIPTED_MODEL a real, authenticated model of the agent dir, so a session opens
    on it (and pi records it) as it would on a user's model. Its endpoint is never called: the script answers. */
export const scriptedModelsJson = () => ({
  providers: {
    scripted: {
      baseUrl: SCRIPTED_MODEL.baseUrl,
      api: SCRIPTED_MODEL.api,
      apiKey: "scripted",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: SCRIPTED_MODEL.id, contextWindow: SCRIPTED_MODEL.contextWindow, maxTokens: SCRIPTED_MODEL.maxTokens }],
    },
  },
});

/** One reply: text (the default "ok"), one or more tool calls, or a provider error. A text reply may
    report usage (the default is all zeros), e.g. a context near the window to drive pi's threshold
    compaction. */
export type ScriptedReply =
  | { text: string; usage?: { input?: number; output?: number; totalTokens?: number } }
  | { toolCall: { name: string; arguments: Record<string, unknown> } }
  | { toolCalls: { name: string; arguments: Record<string, unknown> }[] }
  | { error: string };

/** One model call: a reply, or a hook that runs inside the call (in the run's async context) and may hold
    it back or decide the reply (undefined: "ok"). */
export type ScriptedStep = ScriptedReply | (() => Promise<ScriptedReply | void> | ScriptedReply | void);

/** What the stub saw at one model call. */
export interface ScriptedCall {
  n: number;
  /** The request's context (systemPrompt, messages, tools), as pi passed it. */
  context: unknown;
  /** Whether the run's signal was aborted before the reply. */
  aborted: boolean;
}

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

type StubbedSession = {
  _modelRuntime: { hasConfiguredAuth(p: string): boolean };
  agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
};

export class ScriptedModel {
  /** Every model call so far, in order. */
  readonly calls: ScriptedCall[] = [];
  private readonly steps: ScriptedStep[] = [];
  private gate: Promise<void> | null = null;
  private toolCalls = 0;
  private readonly attached = new WeakSet<object>();

  constructor(private readonly model: ScriptedModelInfo = SCRIPTED_MODEL) {}

  /** Queue the next calls' steps, in order. A call with nothing queued replies "ok". */
  reply(...steps: ScriptedStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  /** Hold every reply from now until the returned release is called (an abort still ends a held call). */
  hold(): () => void {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.gate = gate;
    return () => {
      if (this.gate === gate) this.gate = null;
      release();
    };
  }

  /** Steps not yet used. */
  get pending(): number {
    return this.steps.length;
  }

  /** Make `session` (pi's AgentSession, e.g. `chat.session`) run on this script. Idempotent per object.
      The session keeps the model it opened on when it has one (pi recorded it); otherwise it gets this one. */
  attach(session: unknown): this {
    const s = session as StubbedSession;
    if (this.attached.has(s)) return this;
    this.attached.add(s);
    s._modelRuntime.hasConfiguredAuth = () => true;
    if (!s.agent.state.model) s.agent.state.model = this.model;
    s.agent.getApiKey = async () => "scripted";
    s.agent.streamFunction = (model: unknown, context: unknown, opts?: { signal?: AbortSignal }) => this.answer(model, context, opts?.signal);
    return this;
  }

  private async answer(model: unknown, context: unknown, signal: AbortSignal | undefined) {
    const call: ScriptedCall = { n: this.calls.length + 1, context, aborted: false };
    this.calls.push(call);
    const aborted = new Promise<"aborted">((r) => (signal?.aborted ? r("aborted") : signal?.addEventListener("abort", () => r("aborted"), { once: true })));
    const step = this.steps.shift();
    const run = (async () => {
      if (this.gate) await this.gate;
      return (typeof step === "function" ? await step() : step) ?? undefined;
    })();
    const how = await Promise.race([run, aborted]);
    const m = model as { api?: string; provider?: string; id?: string } | undefined;
    const base = { role: "assistant", api: m?.api ?? this.model.api, provider: m?.provider ?? this.model.provider, model: m?.id ?? this.model.id, usage: USAGE, timestamp: Date.now() };
    if (how === "aborted") {
      call.aborted = true;
      const message = { ...base, content: [{ type: "text", text: "" }], stopReason: "aborted", errorMessage: "Request was aborted" };
      return stream({ type: "error", reason: "aborted", error: message }, message);
    }
    const reply = how as ScriptedReply | undefined;
    if (reply && "error" in reply) {
      const message = { ...base, content: [], stopReason: "error", errorMessage: reply.error };
      return stream({ type: "error", reason: "error", error: message }, message);
    }
    const tools = reply && "toolCalls" in reply ? reply.toolCalls : reply && "toolCall" in reply ? [reply.toolCall] : [];
    const content = tools.length
      ? tools.map((t) => ({ type: "toolCall", id: `call-${++this.toolCalls}`, name: t.name, arguments: t.arguments }))
      : [{ type: "text", text: reply && "text" in reply ? reply.text : "ok" }];
    const reason = tools.length ? "toolUse" : "stop";
    const usage = reply && "usage" in reply && reply.usage ? { ...USAGE, ...reply.usage } : USAGE;
    const message = { ...base, usage, content, stopReason: reason };
    return stream({ type: "done", reason, message }, message);
  }
}

function stream(end: unknown, message: unknown) {
  return { async *[Symbol.asyncIterator]() { yield end; }, result: async () => message };
}
