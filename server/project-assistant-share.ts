import { refuse } from "./extensions";
import { ownerAccess } from "./owner";
import { addAssistantSocket, sweepAssistantSockets } from "./project-assistant";
import { cappedWebSocketServer } from "./runtime-quirks";
import type { ShareUpgrade } from "./share/edge";

/**
 * The owner page's `/ws/i?token=` socket (§app.project-assistant/chat): a live owner link's page
 * joins its org's Project Assistant, and is pushed its view after every change and the reply's text
 * while it is written (shared/project-assistant.ts AssistantServerMessage). Read-only: messages go
 * through POST /api/i/<token>/assistant; anything sent here is ignored. Call once per server.
 */
export function assistantShareUpgrade(maxPayload = 1024): ShareUpgrade {
  const wss = cappedWebSocketServer({ noServer: true, maxPayload });
  return (req, socket, head, { token }) => {
    const access = ownerAccess(token);
    if (!access.ok) {
      refuse(socket, access.status, access.status === 404 ? { error: "This link doesn't open anything." } : { error: access.why === "idle" ? "This link turned off after a week without use." : "This link is no longer active." });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", () => {});
      ws.on("error", (err) => console.warn(`[share] owner socket error: ${err.message}`));
      // Judged again after the handshake: the link may have died meanwhile.
      const now = ownerAccess(token);
      if (!now.ok || now.link.hash !== access.link.hash) return ws.close(4410, "gone");
      addAssistantSocket(access.orgId, ws, token);
    });
  };
}

/** Sockets whose link died (turned off, replaced, idle) close within this long. */
export const OWNER_SOCKET_SWEEP_MS = 30_000;
setInterval(() => sweepAssistantSockets((t) => ownerAccess(t).ok), OWNER_SOCKET_SWEEP_MS).unref();
