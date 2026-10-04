// The internet relay's accept process (§mesh.lan/accept-process), as its own program. Bundled at
// deploy into one file that needs only Node's builtins (`bun build --target=node`, stamped with the
// deployed commit as __SOVA_ACCEPT_BUILD__), and run by the system unit sova-relay-accept.service as
// its own system user, on Node (scripts/mesh-vps/sova-relay-accept.service.in). Sova never starts it.
//
// Environment:
//   SOVA_ACCEPT_HANDOFF   Sova's handoff socket as this process sees it (default /run/sova-handoff/h.sock)
//   STATE_DIRECTORY       its own state directory (systemd's StateDirectory=), for its outer key;
//                         SOVA_ACCEPT_STATE when run by hand
//   SOVA_ACCEPT_BUILD     the build it reports when not bundled with a stamp

import { join } from "node:path";
import { Acceptor, loadOrMintIdentity } from "../lan-accept";
import { cleanBuild } from "../lan-handoff-protocol";

declare const __SOVA_ACCEPT_BUILD__: string | undefined;

const stamped = typeof __SOVA_ACCEPT_BUILD__ === "string" ? __SOVA_ACCEPT_BUILD__ : undefined;
const build = cleanBuild(stamped ?? process.env.SOVA_ACCEPT_BUILD);
const handoffPath = process.env.SOVA_ACCEPT_HANDOFF || "/run/sova-handoff/h.sock";
const state = (process.env.STATE_DIRECTORY ?? "").split(":")[0] || process.env.SOVA_ACCEPT_STATE;
if (!state) {
  console.error("[relay-accept] no state directory: set STATE_DIRECTORY (the unit does) or SOVA_ACCEPT_STATE");
  process.exit(2);
}

const identity = loadOrMintIdentity(join(state, "accept-identity.json"));
const acceptor = new Acceptor({ handoffPath, identity, build, onStale: () => process.exit(0) });
acceptor.start();
console.log(`[relay-accept] started (build ${build.slice(0, 12)}); dialing Sova's handoff socket`);

const quit = () => {
  void acceptor.stop().finally(() => process.exit(0));
};
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
