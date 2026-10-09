// Tests: the WhatsApp sender in-process. Its real state machine (services/whatsapp/src/core.mjs) and
// IPC handler (ipcSessions) run over a fake WhatsApp. Sova's client reaches them through an in-memory
// stream instead of the Unix socket (setSenderClientOptionsForTest). Sends have no gap between them.
// Receipts wait until the test lets them through (flushReceipts), so their place after the send's own
// log line never rests on a delay. The same over a real child and its socket, with its own timings:
// scripts/fake-whatsapp-sender.mjs, in outreach.integration.test.ts.
import type { Socket } from "node:net";
import { duplexPair } from "../mesh/duplex-pair-test-fixtures";

interface Handlers {
  onOpen(me: string): void;
  onQr(qr: string): void;
  onClose(code: number, why: string): void;
  onReceipt(ref: string, status: string, code: string | undefined): void;
}
interface SenderCore {
  start(): void;
  stop(): void;
}
interface Sessions {
  attach(sock: unknown): void;
  close(): void;
}

// The sender is plain JavaScript with no types of its own.
const load = async (file: string) => (await import(new URL(`../../services/whatsapp/src/${file}`, import.meta.url).href)) as Record<string, any>;
const { resolveConfig } = await load("config.mjs");
const { fileStore } = await load("store.mjs");
const { Sender } = await load("core.mjs");
const { ipcSessions } = await load("ipc.mjs");

/**
 * A paired sender for the home the environment names (as the fake child reads it), already
 * started. Every number exists except `absent` (digits); each send's receipts are delivered, then read.
 */
export function inProcessSender(o: { env: NodeJS.ProcessEnv; absent?: string[] }) {
  // No gap between sends (3 s by default); the hour and day limits stay.
  const config = resolveConfig({ ...o.env, SOVA_WA_LIMITS: "0/20/60" });
  const absent = new Set(o.absent ?? []);
  const receipts: Array<() => void> = [];
  let current: Handlers | null = null;
  let n = 0;
  const driver = {
    isPaired: () => true,
    refreshVersion: async () => {},
    wipe: async () => {},
    async open({ handlers }: { link?: boolean; handlers: Handlers }) {
      current = handlers;
      const alive = () => current === handlers;
      setImmediate(() => alive() && handlers.onOpen("0000000000"));
      return {
        end: () => {
          if (alive()) current = null;
        },
        logout: async () => {},
        onWhatsApp: async (digits: string) => ({ exists: !absent.has(digits), jid: `${digits}@s.whatsapp.net` }),
        async sendMessage() {
          const ref = `FAKE${(++n).toString(16).padStart(8, "0").toUpperCase()}`;
          for (const status of ["delivered", "read"]) receipts.push(() => alive() && handlers.onReceipt(ref, status, undefined));
          return ref;
        },
        requestPairingCode: async () => "FAKE1234",
      };
    },
  };
  let up: { core: SenderCore; sessions: Sessions } | null = null;
  const start = () => {
    if (up) return;
    const core = new Sender({ config, store: fileStore(config), driver, version: "fake" }) as SenderCore;
    up = { core, sessions: ipcSessions({ core }) as Sessions };
    core.start();
  };
  /** The sender goes away: its connections close, and a new one is refused as with no socket. */
  const stop = () => {
    if (!up) return;
    const { core, sessions } = up;
    up = null;
    current = null;
    core.stop();
    sessions.close();
  };
  /** For the client: one end of an in-memory stream, the other attached to the sender's IPC. */
  const connect = (path: string): Socket => {
    const [client, server] = duplexPair();
    setImmediate(() => {
      if (!up || path !== config.socket) {
        client.emit("error", Object.assign(new Error(`connect ENOENT ${path}`), { code: "ENOENT" }));
        client.destroy();
        return;
      }
      up.sessions.attach(server);
      client.emit("connect");
    });
    return client as unknown as Socket;
  };
  start();
  return {
    connect,
    start,
    stop,
    /** WhatsApp closes the connection with `code` (440: replaced, 403: blocked …). */
    close: (code: number) => current?.onClose(code, "test"),
    /** Let every receipt of the sends so far arrive, in order. */
    flushReceipts: () => {
      for (const r of receipts.splice(0)) r();
    },
  };
}
