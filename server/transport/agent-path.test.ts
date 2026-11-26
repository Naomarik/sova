// The Transport agent writes its tools' own install folders but never a folder on the user's PATH: the sandbox it opens
// with (its scope, resolved by the sandbox extension's own policy and write check) refuses ~/.local/bin, the shim
// folders, the tool folders' bin folders and any folder the PATH names inside a tool folder, and lets every install
// folder beside them through.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { resolveSessionPolicy } from "../../pi-config/extensions/sandbox/session-policy.ts";
import { checkWrite } from "../../pi-config/extensions/sandbox/backend.ts";
import { agentScope } from "./agent-scope";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-agent-path-")));
after(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home");
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
cpSync(join(import.meta.dirname, "..", "..", "pi-config", "sandbox-policy"), join(agentDir, "sandbox-policy"), { recursive: true });
const folder = join(home, "webapps", "motors");
const nodeBin = join(home, ".local/share/mise/installs/node/22.11.0/bin");
const asdfBin = join(home, ".asdf/installs/ruby/3.3.0/bin");
for (const d of [folder, nodeBin, asdfBin, ".asdf/shims", ".local/bin", ".local/share/mise/shims", ".cargo/bin", ".cargo/registry", ".rustup", ".bun/bin", ".bun/install", "go/bin", "go/pkg"]) mkdirSync(d.startsWith("/") ? d : join(home, d), { recursive: true });

test("the agent's sandbox writes the tools' install folders and refuses every folder on the PATH", () => {
  // The server's own PATH (a service's) names none of the user's tool folders: what the user's shell adds is held anyway.
  const scope = agentScope({ folder, home, pathDirs: ["/usr/local/bin", "/usr/bin"] });
  const r = resolveSessionPolicy({ agentDir, cwd: folder, sessionId: "agent-path", home, parent: scope });
  assert.ok(r.ok, r.ok ? "" : r.error);
  // The backend's own view of it, as the sandbox extension builds one (index.ts backendPolicy).
  const policy = { ...r.value, network: { mode: "none" as const }, env: {}, sessionId: "agent-path" };
  const writes = (p: string) => checkWrite(policy, join(home, p)).ok;
  for (const p of ["webapps/motors/node_modules/x", ".local/share/mise/installs/python/3.12/lib/x", ".local/share/mise/installs/node/22.11.0/lib/node_modules/x", ".local/share/mise/installs/node/23.1.0/bin/node", ".asdf/installs/ruby/3.3.0/lib/x", ".cargo/registry/x", ".rustup/toolchains/x", ".bun/install/cache/x", "go/pkg/mod/x"])
    assert.equal(writes(p), true, `${p}: an install folder, writable`);
  for (const p of [".local/bin/git", ".local/share/mise/shims/node", ".cargo/bin/cargo-evil", ".bun/bin/bun", "go/bin/tool", ".local/share/mise/installs/node/22.11.0/bin/npx", ".asdf/installs/ruby/3.3.0/bin/gem-evil", ".asdf/shims/ruby"])
    assert.equal(writes(p), false, `${p}: on the PATH, read-only`);
});
