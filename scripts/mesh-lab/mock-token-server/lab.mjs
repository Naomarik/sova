// The mock token server's place in the mesh lab (for scripts/mesh-lab/lab.mjs to import).
//
// pi posts refreshes to FIXED URLs (https://auth.openai.com/oauth/token for Codex,
// https://platform.claude.com/v1/oauth/token for Anthropic). In the lab those names must reach
// this mock, from every process in every host container (the Sova server's own c-lite refresh and
// its sessions, the pi CLI): so the mock answers https for those names with a lab-only CA, each
// host trusts that CA through NODE_EXTRA_CA_CERTS, and each host's /etc/hosts points the names at
// the mock container (getaddrinfo reads /etc/hosts before any DNS, MagicDNS included).
//
// Nothing here can reach the real providers: inside a lab host the names always resolve from
// /etc/hosts, to the mock or (when the mock can't be found) to 0.0.0.0, never past it to DNS.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const MOCK_NAMES = ["auth.openai.com", "platform.claude.com"];
export const MOCK_HTTP_PORT = 8080;
/** The laptop's loopback port for the harness endpoints (/mock/login, /mock/events, …). */
export const MOCK_LAPTOP_PORT = 4888;
/** Inside hosts: where the Claude store simulator keeps its store (never /root/.claude). */
export const CLAUDE_SIM_DIR = "/root/.claude-lab";

/** A lab CA and a leaf for MOCK_NAMES under `<stateDir>/mock-token/`; idempotent. */
export function ensureMockCerts(stateDir) {
  const dir = join(stateDir, "mock-token");
  const files = { ca: join(dir, "ca.pem"), caKey: join(dir, "ca.key"), cert: join(dir, "cert.pem"), key: join(dir, "key.pem") };
  if (Object.values(files).every(existsSync)) return { dir, ...files };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ssl = (args) => {
    const r = spawnSync("openssl", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr}`);
  };
  ssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=sova mesh lab mock CA", "-keyout", files.caKey, "-out", files.ca]);
  const csr = join(dir, "leaf.csr");
  const ext = join(dir, "leaf.ext");
  spawnSync("sh", ["-c", `printf 'subjectAltName=%s\\nbasicConstraints=CA:FALSE\\nkeyUsage=digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth\\n' '${MOCK_NAMES.map((n) => `DNS:${n}`).join(",")},DNS:mocktoken' > '${ext}'`]);
  ssl(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=auth.openai.com", "-keyout", files.key, "-out", csr]);
  ssl(["x509", "-req", "-in", csr, "-CA", files.ca, "-CAkey", files.caKey, "-CAcreateserial", "-days", "30", "-extfile", ext, "-out", files.cert]);
  return { dir, ...files };
}

/**
 * The compose service. `image` is any lab image with node and the worktree at /sova (the plain
 * host image); its own entrypoint is bypassed.
 */
export function mockTokenService({ image, containerName, certDir, network = "lab", accessTtlS = 90 }) {
  return {
    image,
    container_name: containerName,
    hostname: "mocktoken",
    entrypoint: ["node", "/sova/scripts/mesh-lab/mock-token-server/server.mjs"],
    environment: {
      PORT: "443",
      HTTP_PORT: String(MOCK_HTTP_PORT),
      ACCESS_TTL_S: String(accessTtlS),
      TLS_CERT: "/run/mock-token/cert.pem",
      TLS_KEY: "/run/mock-token/key.pem",
    },
    volumes: [`${certDir}:/run/mock-token:ro`],
    ports: [`127.0.0.1:${MOCK_LAPTOP_PORT}:${MOCK_HTTP_PORT}`],
    networks: [network],
    labels: { "sova.mesh-lab": "1", "sova.mesh-lab.role": "mocktoken" },
  };
}

/** What a Sova host container adds to reach and trust the mock, and to have a Claude store. */
export function hostMockEnv({ mockContainer }) {
  return {
    NODE_EXTRA_CA_CERTS: "/run/mock-token/ca.pem",
    SOVA_SYNC_CLAUDE_DIR: CLAUDE_SIM_DIR,
    MOCK_TOKEN_URL: `http://${mockContainer}:${MOCK_HTTP_PORT}`,
    LAB_MOCK_CONTAINER: mockContainer,
    LAB_MOCK_NAMES: MOCK_NAMES.join(","),
  };
}
export const hostMockVolume = (certDir) => `${certDir}/ca.pem:/run/mock-token/ca.pem:ro`;

/**
 * For the host entrypoint, before Sova starts: point MOCK_NAMES at the mock container in
 * /etc/hosts, resolved through Docker's own DNS (the mock's container name). Idempotent.
 */
export const HOSTS_SNIPPET = `
if [ -n "\${LAB_MOCK_CONTAINER:-}" ]; then
  mip=""
  for _ in $(seq 1 50); do mip=$(getent hosts "$LAB_MOCK_CONTAINER" | awk '{print $1; exit}'); [ -n "$mip" ] && break; sleep 0.2; done
  # Fail closed: without the mock, the provider names go nowhere rather than to the real ones.
  [ -n "$mip" ] || { mip=0.0.0.0; echo "[lab] mock token server not resolvable; provider names blackholed" >&2; }
  sed -i '/# lab-mock-token$/d' /etc/hosts
  for n in \${LAB_MOCK_NAMES//,/ }; do echo "$mip $n # lab-mock-token" >> /etc/hosts; done
  mkdir -p "\${SOVA_SYNC_CLAUDE_DIR:-/root/.claude-lab}"
fi
`;
