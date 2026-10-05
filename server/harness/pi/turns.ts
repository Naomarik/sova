// Which user message is whose (§app.harness/session): pi hands every user-role message to its Agent through
// `agent.prompt`/`steer`/`followUp`, looked up by property at each call, and the object it passes is the one
// its message events later carry (quirk P7 user-turns-wrap, QUIRKS.md). Wrapping those three once per agent
// lets Sova code (server/user-turns.ts) tell a message by identity. Pi-free at load.

type Claim = (input: unknown) => void;

const claimers = new WeakMap<object, Claim[]>();

/**
 * Show `claim` the input each of the agent's three user-message entry points is handed, before the agent
 * takes it. One wrap per agent, installed at the first claimer; later claimers see the input first, as
 * nested wraps would (the newest wrap is the outermost). Returns the unregister.
 */
export function watchUserMessages(agent: object, claim: Claim): () => void {
  let list = claimers.get(agent);
  if (!list) {
    const own: Claim[] = (list = []);
    claimers.set(agent, own);
    const sink = agent as unknown as Record<"prompt" | "steer" | "followUp", (...args: unknown[]) => unknown>;
    for (const name of ["prompt", "steer", "followUp"] as const) {
      const inner = sink[name]!;
      sink[name] = (...args: unknown[]) => {
        for (let i = own.length - 1; i >= 0; i--) own[i]!(args[0]);
        return inner.apply(agent, args);
      };
    }
  }
  const own = list;
  own.push(claim);
  return () => {
    const i = own.indexOf(claim);
    if (i >= 0) own.splice(i, 1);
  };
}
