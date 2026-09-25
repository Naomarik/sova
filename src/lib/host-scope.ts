// Host scope: which host a session view's controls talk to. A peer's session is driven by that
// peer, so the model list, its favorites, the model policy and the mode defaults its composer
// offers are the peer's — its keys and its policy decide what it can run. Requests that name the
// session's path are routed by the path alone (lib/mesh.ts); these ones name no path, so the view
// provides its host here and the controls deep inside it read it.
//
// The default is the host serving this page (null): nothing changes outside a peer's session.

import { createContext, useContext, type Accessor } from "solid-js";

const HostScopeContext = createContext<Accessor<string | null>>(() => null);

export const HostScopeProvider = HostScopeContext.Provider;

/** The peer the enclosing session view lives on, or null for this host. */
export const useHostScope = (): Accessor<string | null> => useContext(HostScopeContext);
