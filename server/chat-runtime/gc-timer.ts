// Bun's periodic garbage collection timer, off in chat processes: an idle chat spends most of its CPU on it, and a chat's memory still comes back down after a big reply
// through the collections its own allocations start. Bun reads the variable once, at start: the
// supervisor puts it in a chat's environment, and the chat deletes it from its own as it boots, so
// the programs its tools run keep their timer. Node ignores it. The canary that the pinned Bun still
// knows the name is server/chat-runtime/gc-timer.test.ts. No imports: main.ts loads this before it
// listens.

/** The variable, and the value that turns the timer off. */
export const GC_TIMER_OFF = { name: "BUN_GC_TIMER_DISABLE", value: "1" } as const;

/** Delete it from a chat process's environment (at boot, after Bun has read it). */
export function dropGcTimerEnv(env: NodeJS.ProcessEnv = process.env): void {
  delete env[GC_TIMER_OFF.name];
}
