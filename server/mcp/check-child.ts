// The short-lived process of a Check and a Sign In (server/mcp/check.ts). One JSON job on stdin. A command server
// runs through Sova's own transport; an address server through a short-lived pi runtime (server/harness/pi/mcp-check.ts).
// The last stdout line is the answer. During a sign-in: `{t:"url",url}` out; `{t:"address",address}` in.
import { createInterface } from "node:readline";
import type { McpEntry } from "./config";
import type { McpCheckRecord } from "./store";
import { cleanMcpEnv, StdioServer, type JsonRpc } from "./transport";

export interface CheckJob {
  action: "check" | "sign-in";
  /** Its values filled: literal, and never expanded again. */
  entry: McpEntry;
  cwd: string;
  timeoutMs: number;
}

export type CheckAnswer = { ok: true; record: McpCheckRecord } | { ok: false; errors: string[]; needsSignIn?: boolean };

const PROTOCOL = "2025-06-18";

/** Start it, ask for its tools, stop it. */
export async function checkCommand(entry: McpEntry, cwd: string, timeoutMs: number): Promise<CheckAnswer> {
  const argv = [entry.command!, ...(entry.args ?? [])];
  const server = new StdioServer(async () => ({ argv, env: cleanMcpEnv(process.env, entry.env), sandboxed: false, dispose: async () => {} }), cwd);
  const waiting = new Map<string, { resolve(m: JsonRpc): void; reject(e: Error): void }>();
  server.onMessage((m) => {
    const w = waiting.get(String(m.id));
    if (!w) return;
    waiting.delete(String(m.id));
    if (m.error) w.reject(new Error(JSON.stringify(m.error)));
    else w.resolve(m);
  });
  const stopped = (reason: string) => {
    for (const w of waiting.values()) w.reject(new Error(reason));
    waiting.clear();
  };
  server.onClose(() => stopped("the server exited"));
  let id = 0;
  const ask = (method: string, params: unknown): Promise<JsonRpc> =>
    new Promise((resolve, reject) => {
      const key = `check-${++id}`;
      waiting.set(key, { resolve, reject });
      server.send({ jsonrpc: "2.0", id: key, method, params }).catch(reject);
    });
  const timer = setTimeout(() => stopped(`the server didn't answer within ${timeoutMs / 1000} s`), timeoutMs);
  try {
    await server.start();
    const hello = (await ask("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "sova", version: "1" } })).result as Partial<McpCheckRecord>;
    await server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools: McpCheckRecord["tools"] = [];
    for (let cursor: string | undefined; ; ) {
      const page = (await ask("tools/list", cursor ? { cursor } : {})).result as { tools?: McpCheckRecord["tools"]; nextCursor?: string };
      tools.push(...(page.tools ?? []));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return {
      ok: true,
      record: {
        protocolVersion: hello.protocolVersion ?? PROTOCOL,
        serverInfo: hello.serverInfo ?? { name: entry.name, version: "" },
        ...(hello.instructions ? { instructions: hello.instructions } : {}),
        tools: tools.map((t) => ({ ...t, inputSchema: t.inputSchema ?? { type: "object", properties: {} } })),
      },
    };
  } catch (err) {
    const tail = server.stderr.trim();
    return { ok: false, errors: [`${(err as Error).message}${tail ? `\n${tail}` : ""}`] };
  } finally {
    clearTimeout(timer);
    await server.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  const it = lines[Symbol.asyncIterator]();
  const first = await it.next();
  const job = JSON.parse(String(first.value)) as CheckJob;
  const say = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  let answer: unknown;
  if (job.action === "check" && job.entry.kind === "command") answer = await checkCommand(job.entry, job.cwd, job.timeoutMs);
  else {
    (await import("../harness/pi/headless")).installHeadless();
    const pi = await import("../harness/pi/mcp-check");
    if (job.action === "check") answer = await pi.checkAddress(job.entry, job.cwd);
    else {
      let answerAddress: ((address: string) => void) | undefined;
      void (async () => {
        for (;;) {
          const next = await it.next();
          if (next.done) return process.exit(0);
          const m = JSON.parse(String(next.value)) as { t?: string; address?: string };
          if (m.t === "address" && m.address) answerAddress?.(m.address);
        }
      })();
      answer = await pi.signInAddress(job.entry, job.cwd, {
        url: (url) => say({ t: "url", url }),
        pasted: (signal) =>
          new Promise<string | undefined>((resolve) => {
            answerAddress = resolve;
            signal?.addEventListener("abort", () => resolve(undefined));
          }),
      });
    }
  }
  say(answer);
  process.exit(0);
}

if (import.meta.main ?? process.argv[1]?.endsWith("check-child.ts")) void main();
