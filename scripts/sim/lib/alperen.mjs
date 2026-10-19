// The simulated client: Claude Code (`claude -p`) on claude-haiku-5-5, no tools, no session kept,
// the persona as its whole system prompt. Each turn it reads the conversation as the share page shows
// it (what Alperen himself would see) and answers with his next message.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";

export const ALPEREN_MODEL = "claude-haiku-5-5";

/** The share view's items as a plain chat log, from Alperen's side. */
export function chatLog(view) {
  const lines = [];
  for (const it of view.items ?? []) {
    if (it.kind === "message") lines.push(`${it.by === "you" ? "Alperen (you)" : it.name}: ${it.text}`);
    else if (it.kind === "reply") lines.push(`Assistant: ${it.text}`);
    else if (it.kind === "done") lines.push(`[The conversation was closed. Summary: ${it.summary}]`);
    else if (it.kind === "handoff") lines.push(`[Passed to ${it.to}: ${it.question}]`);
  }
  return lines.join("\n\n");
}

export function alperen({ personaFile, model = ALPEREN_MODEL, timeoutMs = 180_000 }) {
  const persona = readFileSync(personaFile, "utf8");
  return {
    model,
    /** Alperen's next message, given the conversation so far. */
    reply(view) {
      const prompt = `The conversation so far, as your phone shows it:\n\n${chatLog(view)}\n\nWrite Alperen's next message.`;
      return new Promise((resolve, reject) => {
        execFile(
          "claude",
          ["-p", "--model", model, "--tools", "", "--no-session-persistence", "--system-prompt", persona, prompt],
          { cwd: tmpdir(), timeout: timeoutMs, maxBuffer: 4 << 20 },
          (err, stdout, stderr) => (err ? reject(new Error(`claude -p failed: ${err.message}\n${stderr}`)) : resolve(stdout.trim())),
        );
      });
    },
  };
}
