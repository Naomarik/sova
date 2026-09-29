/**
 * A routed host's share ingress (§mesh.public/ingress): with `route: { via }`, a share server on
 * this host's tailnet addresses at `ingressPort`, built by createShareServer with the gateway gate
 * as `admit`, serving exactly the public share paths. It follows the setting (setting-events),
 * and closes what it admitted when the gateway is removed or `via` changes.
 *
 * Not built yet: nothing binds.
 */

export async function startIngress(): Promise<void> {}

export function stopIngress(): void {}
