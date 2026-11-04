// A stub OAuth-protected streamable-HTTP MCP server for tests: PRM, AS metadata, DCR, authorize, token, MCP.
import { createServer } from "node:http";
export async function startOAuthServer() {
  const seen: string[] = [];
  const token = "stand-in-access";
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    seen.push(`${req.method} ${url.pathname}`);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname === "/.well-known/oauth-authorization-server") return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
      if (url.pathname === "/register") return json(201, { client_id: "stub-client", redirect_uris: JSON.parse(raw).redirect_uris, token_endpoint_auth_method: "none" });
      if (url.pathname === "/authorize") { const to = new URL(url.searchParams.get("redirect_uri")!); to.searchParams.set("code", "stub-code"); to.searchParams.set("state", url.searchParams.get("state")!); to.searchParams.set("iss", base); res.writeHead(302, { location: to.href }); return res.end(); }
      if (url.pathname === "/token") return json(200, { access_token: token, token_type: "Bearer", expires_in: 3600, refresh_token: "stand-in-refresh" });
      if (url.pathname === "/mcp") {
        if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
        if (req.method !== "POST") { res.writeHead(405); return res.end(); }
        const m = JSON.parse(raw);
        if (m.id === undefined) { res.writeHead(202); return res.end(); }
        const reply = (result: unknown) => json(200, { jsonrpc: "2.0", id: m.id, result });
        if (m.method === "initialize") return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "oauthstub", version: "1" }, instructions: "Stub behind OAuth" });
        if (m.method === "tools/list") return reply({ tools: [{ name: "whoami", description: "Who you are", inputSchema: { type: "object", properties: {} } }, { name: "search", description: "Search", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] });
        return json(200, { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nf" } });
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as any).port}/mcp`, seen, stop: () => server.close() };
}
