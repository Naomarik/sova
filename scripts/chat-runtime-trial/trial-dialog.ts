// chat-runtime-trial: a tool that opens a confirm dialog and waits for its answer, so a trial can hold
// a dialog open across a server restart. Copied into the trial's scratch agent dir (never ~/.pi); no
// imports, so it loads from there. The mock LLM calls it on an "[ask]" prompt.
export default function (pi: any) {
  pi.registerTool({
    name: "trial_ask",
    label: "Trial ask",
    description: "Ask the user a yes/no question and wait for the answer.",
    parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
    async execute(_id: string, params: { question: string }, _signal: AbortSignal, _update: unknown, ctx: any) {
      const yes = await ctx.ui.confirm("Trial question", params.question);
      return { content: [{ type: "text", text: `DIALOG-ANSWER ${yes ? "yes" : "no"}` }], details: { yes } };
    },
  });
}
