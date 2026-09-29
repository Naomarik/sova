/**
 * A routed host's view of its `via` gateway (§mesh.public/setting, §mesh.public/gateway): its
 * public URL (from its hello, else lastKnownUrl), whether it answers, and whether it accepts this
 * host's links (GatewayInfo.accepting). shareState() reads it for the effective address and the
 * `unreachable` / `not-accepted` warnings.
 *
 * Not built yet: no gateway is known.
 */

export interface ViaGatewayStatus {
  publicUrl: string | null;
  /** The peer's label, for {gateway} in the warnings. */
  label: string;
  reachable: boolean;
  /** null: not asked yet. */
  accepting: boolean | null;
}

export function viaGatewayStatus(): ViaGatewayStatus | null {
  return null;
}
