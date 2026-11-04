// An address server's copy in a chat: pi-mcp's HTTP client in the shape SnapshotTransport (./mcp.ts) runs a command
// server's process in. Quirk P36. Nothing here is expanded: a value reaches the server as the string in the launch,
// since pi's own expansion sits in its default transport, which a chat never uses.
import { McpAuthRequiredError, McpSessionExpiredError, StreamableHttpTransport, type AuthProvider, type JsonRpcMessage } from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import type { McpEntry } from "../../mcp/config";
import { Events, type JsonRpc } from "../../mcp/transport";

export interface AddressLaunch {
  url: string;
  headers: Record<string, string>;
  /** pi's, carrying the server's sign-in or provider token. */
  authProvider?: AuthProvider;
  /** What stays out of everything Sova says of this run. */
  values: string[];
}

/** A request failed on a server that was up: there's no process to exit, so the copy ends here. */
export class McpCallFailed extends Error {}

/** Under this a header's value is a version or a flag, and masking it would eat the error line around it. */
const SHORTEST_SECRET = 4;

/**
 * Every value that could hold a secret: those filled from a secret, then each header as written, with the credential
 * after its scheme on its own, and the client secret. A header can hold one with no name to fill it.
 */
export function addressValues(entry: McpEntry, filled: readonly string[]): string[] {
  const headers = Object.values(entry.headers ?? {});
  const secret = entry.oauth?.clientSecret;
  const written = [...headers, ...headers.map((h) => h.trim().split(/\s+/).pop() ?? ""), ...(typeof secret === "string" ? [secret] : [])];
  return [...filled, ...written.filter((v) => v.length >= SHORTEST_SECRET)];
}

export class AddressServer extends Events {
  readonly pid = undefined;
  readonly sandboxed = false;
  readonly stderr = "";
  values: string[] = [];
  private launched: AddressLaunch | undefined;
  private http: StreamableHttpTransport | undefined;
  private hello: JsonRpc | undefined;
  private reopening: Promise<void> | undefined;

  constructor(private readonly launch: () => AddressLaunch) {
    super();
  }

  async start(): Promise<void> {
    this.launched = this.launch();
    this.values = this.launched.values;
    await this.connect();
  }

  private async connect(): Promise<StreamableHttpTransport> {
    const { url, headers, authProvider } = this.launched!;
    const http = new StreamableHttpTransport({ url, headers, ...(authProvider ? { authProvider } : {}) });
    http.onMessage((message) => {
      const reply = message as JsonRpc;
      const version = reply.id === this.hello?.id ? (reply.result as { protocolVersion?: string } | undefined)?.protocolVersion : undefined;
      if (version) http.setProtocolVersion(version);
      this.emitMessage(reply);
    });
    http.onError((error) => this.emitError(error));
    await http.start();
    this.http = http;
    return http;
  }

  async send(message: JsonRpc): Promise<void> {
    if (message.method === "initialize") this.hello = message;
    const http = this.http;
    if (!http) throw new Error("the server isn't reachable");
    try {
      try {
        await http.send(message as JsonRpcMessage);
      } catch (error) {
        if (!(error instanceof McpSessionExpiredError) || message === this.hello) throw error;
        // The server restarted and didn't run this request, so it goes again on a new session.
        await (this.reopening ??= this.reopen(http).finally(() => {
          this.reopening = undefined;
        }));
        await this.http!.send(message as JsonRpcMessage);
      }
    } catch (error) {
      throw new McpCallFailed(this.wording(error));
    }
  }

  /** The old session is left to its other calls, which get the same answer and come here. */
  private async reopen(old: StreamableHttpTransport): Promise<void> {
    if (this.http !== old) return;
    const http = await this.connect();
    await http.send(this.hello as JsonRpcMessage);
    await http.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private wording(error: unknown): string {
    const signsIn = !!this.launched?.authProvider;
    if (signsIn && (error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError)) return "it needs a sign-in";
    return error instanceof Error ? error.message : String(error);
  }

  /** Ends the session. No `close` event: only the owner ends one, and a failed request says so itself. */
  async close(): Promise<void> {
    await this.http?.close();
  }
}
