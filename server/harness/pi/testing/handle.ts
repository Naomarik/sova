// The tests' handle on a hosted chat's pi runtime (§app.harness/session): what a test drives or patches on pi
// directly (a scripted model, a replaced prompt, a waitForIdle), where server code goes through the driving
// session (`chat.harness`). Both look the runtime's session up at each call, so a method a test replaces here
// after open is the one the driving session calls (session.test.ts proves it). Tests only; it loads nothing
// but the registry, so a test may import it before setting PI_CODING_AGENT_DIR.
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { HarnessSession } from "../../../../shared/harness";
import { hostedRuntimes } from "../host-registry";

/** A hosted chat: anything holding a driving session that host.ts made. */
type Hosted = { readonly harness: HarnessSession };

/** The pi runtime behind a hosted chat. */
export function piRuntime(chat: Hosted): AgentSessionRuntime {
  const runtime = hostedRuntimes.get(chat.harness);
  if (!runtime) throw new Error("Not a hosted chat's driving session.");
  return runtime;
}

/** pi's AgentSession behind a hosted chat: the runtime's current one. */
export function piSession(chat: Hosted): AgentSession {
  return piRuntime(chat).session;
}
