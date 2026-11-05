// A stub streamable-HTTP MCP server for tests: one session per initialize, optional bearer with a refresh, and a 500
// that repeats what it was sent, the credential alone included, as a careless server's error page does.
import { createServer } from "node:http";

export interface AddressStub {
  url: string;
  /** Every MCP request, with its headers, refused or not. */
  seen: { rpc: { id?: unknown; method?: string; params?: { name?: string } }; headers: Record<string, string | string[] | undefined>; session?: string }[];
  /** What each token request carried. */
  refreshes: { clientSecret?: string; refreshToken?: string }[];
  /** Answers 500 with the request's headers in the body: every method, or only tool calls. */
  fail: "all" | "calls" | false;
  /** The bearer it takes; none: any. */
  bearer?: string;
  /** The next tools/call answers this session is gone with a 404. */
  forgetSessions(): void;
  stop(): void;
  listen(): Promise<void>;
}

const tools = (names: string[]) => names.map((name) => ({ name, description: `Stub ${name}`, inputSchema: { type: "object", properties: { text: { type: "string" } } } }));

export async function startAddressStub(list: string[] = ["echo"]): Promise<AddressStub> {
  const sessions = new Set<string>();
  let next = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post"] });
      if (url.pathname === "/token") {
        const form = new URLSearchParams(raw);
        const basic = req.headers.authorization?.startsWith("Basic ") ? decodeURIComponent(Buffer.from(req.headers.authorization.slice(6), "base64").toString("utf8").split(":")[1] ?? "") : undefined;
        stub.refreshes.push({ clientSecret: form.get("client_secret") ?? basic, refreshToken: form.get("refresh_token") ?? undefined });
        stub.bearer = "stub-fresh-token";
        return json(200, { access_token: "stub-fresh-token", token_type: "Bearer", expires_in: 3600, refresh_token: "stub-fresh-refresh" });
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404);
        return res.end();
      }
      const rpc = (req.method === "POST" ? JSON.parse(raw) : {}) as AddressStub["seen"][number]["rpc"];
      const session = req.headers["mcp-session-id"] as string | undefined;
      if (req.method === "POST") stub.seen.push({ rpc, headers: req.headers, ...(session ? { session } : {}) });
      if (stub.bearer && req.headers.authorization !== `Bearer ${stub.bearer}`)
        return json(401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      if (req.method !== "POST") {
        res.writeHead(405);
        return res.end();
      }
      const refused = stub.fail === "all" || (stub.fail === "calls" && rpc.method === "tools/call");
      if (refused) return json(500, { error: "stub refused", token: req.headers.authorization?.split(" ").pop(), sent: Object.values(req.headers).filter((v) => !String(v).includes(" ")) });
      if (session && !sessions.has(session)) return json(404, { error: "no such session" });
      if (rpc.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      const reply = (result: unknown, headers: Record<string, string> = {}) => json(200, { jsonrpc: "2.0", id: rpc.id, result }, headers);
      if (rpc.method === "initialize") {
        const id = `stub-session-${++next}`;
        sessions.add(id);
        return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "addressstub", version: "1" } }, { "mcp-session-id": id });
      }
      if (rpc.method === "tools/list") return reply({ tools: tools([...list, "unrecorded"]) });
      if (rpc.method === "tools/call") return reply({ content: [{ type: "text", text: `called ${rpc.params?.name}` }] });
      return json(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "nf" } });
    });
  });
  const listen = () => new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  let port = 0;
  await listen();
  port = (server.address() as { port: number }).port;
  const stub: AddressStub = {
    url: `http://127.0.0.1:${port}/mcp`,
    seen: [],
    refreshes: [],
    fail: false,
    forgetSessions: () => sessions.clear(),
    stop: () => {
      server.close();
      server.closeAllConnections();
    },
    listen,
  };
  return stub;
}
