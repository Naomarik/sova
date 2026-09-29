import { inProcessShare, type ShareDispatch, type ShareUpgrade } from "./edge";

/**
 * A gateway's router (§mesh.public/routing): the share listener's `dispatch` and `upgrade` when
 * this host is the gateway. By token hash: a token this host minted is served in-process; one a
 * routed host registered is forwarded to its ingress; an unknown one is 404 here and never asked
 * of any host. The listener binds with these hooks; this file never binds.
 *
 * Until the router lands, every token is this host's own: the in-process share, exactly as today.
 * Call once per server: inProcessShare() builds an app and a WebSocket server each time.
 */
export function gatewayHooks(): { dispatch: ShareDispatch; upgrade: ShareUpgrade } {
  return inProcessShare();
}
