import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { PREVIEW_PAGES, PREVIEW_RETRY_S } from "../../shared/public-links";

/**
 * A preview host's own answers (§mesh.public/preview-offline, /preview-limits): static, naming no
 * host, port or token. A navigation gets a small page; anything else a short text (or, for an
 * unknown label, the JSON Verify recognizes). The app's own responses never pass through here.
 */

const CSP = "default-src 'none'; style-src 'unsafe-inline'";
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Whether the request is a page load (a navigation), so it gets a page rather than a text. */
export function isNavigation(req: IncomingMessage): boolean {
  const mode = req.headers["sec-fetch-mode"];
  if (typeof mode === "string") return mode === "navigate";
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

function page(title: string, text: string, refresh?: number): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    (refresh ? `<meta http-equiv="refresh" content="${refresh}">` : "") +
    `<title>${esc(title)}</title></head>` +
    `<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5"><p>${esc(text)}</p></body></html>`
  );
}

type Kind = keyof typeof PREVIEW_PAGES | "tooMany" | "busy" | "tooLarge";

const STATUS: Record<Kind, number> = { notRunning: 502, gone: 410, unknown: 404, slow: 504, tooMany: 429, busy: 503, tooLarge: 413 };
const TEXT: Record<Kind, { title: string; text: string }> = {
  ...PREVIEW_PAGES,
  tooMany: { title: "Too many requests", text: "Too many requests from this network. Wait a minute, then reload." },
  busy: { title: "Busy", text: "This preview is busy. Try again in a moment." },
  tooLarge: { title: "Too large", text: "That upload is too large for a preview link." },
};

/** Write one of the preview answers. A response whose headers already went out is cut instead. */
export function previewAnswer(req: IncomingMessage, res: ServerResponse, kind: Kind): void {
  req.resume();
  if (res.destroyed) return;
  if (res.headersSent) return void res.destroy();
  const status = STATUS[kind];
  const { title, text } = TEXT[kind];
  const headers: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" };
  if (kind === "notRunning") headers["Retry-After"] = String(PREVIEW_RETRY_S);
  if (kind === "tooMany") headers["Retry-After"] = "60";
  // A turned-off preview takes the app's service worker, caches and storage with it.
  if (kind === "gone") headers["Clear-Site-Data"] = '"cache", "storage"';
  let body: string;
  if (isNavigation(req)) {
    headers["Content-Type"] = "text/html; charset=utf-8";
    headers["Content-Security-Policy"] = CSP;
    body = page(title, text, kind === "notRunning" ? PREVIEW_RETRY_S : undefined);
  } else if (kind === "unknown") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ error: text, code: "preview-not-found" });
  } else {
    headers["Content-Type"] = "text/plain; charset=utf-8";
    body = text;
  }
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

const REASON: Record<number, string> = { 404: "Not Found", 410: "Gone", 413: "Payload Too Large", 429: "Too Many Requests", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };

/** The same answer on a raw socket, for a websocket upgrade (before any handshake). */
export function previewUpgradeAnswer(socket: Duplex, kind: Kind): void {
  if (socket.destroyed) return;
  const status = STATUS[kind];
  const body = TEXT[kind].text;
  socket.end(
    `HTTP/1.1 ${status} ${REASON[status] ?? "Error"}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}
