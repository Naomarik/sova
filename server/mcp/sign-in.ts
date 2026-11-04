// Sign In (§app.mcp/sign-in): pi's `/mcp login` in the short-lived process, which opens the page's dialog on the
// service's address and finishes on its own callback or on an address the person pastes. A Check follows.
import type { McpServerRow, McpSignIn } from "../../shared/mcp";
import { agentRoot } from "../state-root";
import { checkServer, spawnCheckChild } from "./check";
import { rowId, type RowRef } from "./ids";
import { readyToRun } from "./resolve";
import { withoutSecrets } from "./secrets";

const SIGN_IN_MS = 10 * 60_000;

interface Run {
  state: Exclude<McpSignIn, { state: "done" }> | { state: "checked" };
  send(line: unknown): void;
  stop(): void;
  url: Promise<void>;
}
const runs = new Map<string, Run>();

export function startSignIn(ref: RowRef): Run {
  const id = rowId(ref);
  runs.get(id)?.stop();
  const ready = readyToRun(ref.owner, ref.name);
  if (!ready.ok) throw new Error(ready.reason);
  const child = spawnCheckChild({ action: "sign-in", entry: ready.entry, cwd: ready.cwd ?? agentRoot(), timeoutMs: SIGN_IN_MS });
  let gotUrl!: () => void;
  const run: Run = {
    state: { state: "starting" },
    send: (line) => void child.stdin.write(`${JSON.stringify(line)}\n`),
    stop: () => {
      child.kill("SIGKILL");
      if (runs.get(id) === run) runs.delete(id);
    },
    url: new Promise((r) => (gotUrl = r)),
  };
  runs.set(id, run);
  const timer = setTimeout(() => run.stop(), SIGN_IN_MS);
  let out = "";
  let finished = false;
  const clean = (s: string) => withoutSecrets(s, ready.values);
  child.stdout.on("data", (c: Buffer) => {
    out += c.toString("utf8");
    for (let at = out.indexOf("\n"); at >= 0; at = out.indexOf("\n")) {
      const line = out.slice(0, at);
      out = out.slice(at + 1);
      let m: { t?: string; url?: string; ok?: boolean; error?: string };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.t === "url" && m.url) {
        run.state = { state: "waiting", url: m.url };
        gotUrl();
      } else if (m.ok === true) {
        finished = true;
        void checkServer(ref.owner, ref.name).then(() => void (run.state = { state: "checked" }));
      }
      else if (m.ok === false) {
        run.state = { state: "failed", error: clean(m.error ?? "The sign-in didn't finish.") };
        gotUrl();
      }
    }
  });
  child.on("close", () => {
    clearTimeout(timer);
    if (!finished && (run.state.state === "starting" || run.state.state === "waiting")) run.state = { state: "failed", error: "The sign-in stopped." };
    gotUrl();
  });
  return run;
}

/** Where a sign-in stands now. `row`: the row as it reads, for a finished one. */
export function signInState(ref: RowRef, row: () => McpServerRow): McpSignIn {
  const run = runs.get(rowId(ref));
  if (!run) return { state: "failed", error: "No sign-in is running." };
  if (run.state.state !== "checked") return run.state;
  runs.delete(rowId(ref));
  return { state: "done", row: row() };
}

export function pasteAddress(ref: RowRef, address: string): boolean {
  const run = runs.get(rowId(ref));
  if (!run) return false;
  run.send({ t: "address", address });
  return true;
}

export const stopSignIn = (ref: RowRef): void => runs.get(rowId(ref))?.stop();
