// The Transport agent writes only its tools' install and cache folders, never what runs, unconfined, in the user's next
// shell or chat: under the sandbox it opens with (its scope, resolved by the sandbox extension's own policy and write
// check), a folder on the PATH, a file a shell profile sources, a tool folder's own top and every version, plugin and
// toolchain already installed (and anything they link to or load) are refused, while a version it installs is its own.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { resolveSessionPolicy } from "../../pi-config/extensions/sandbox/session-policy.ts";
import { checkWrite } from "../../pi-config/extensions/sandbox/backend.ts";
import { agentScope, toolDirsToMake } from "./agent-scope";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-agent-path-")));
after(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home");
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
cpSync(join(import.meta.dirname, "..", "..", "pi-config", "sandbox-policy"), join(agentDir, "sandbox-policy"), { recursive: true });
const folder = join(home, "webapps", "motors");
mkdirSync(folder, { recursive: true });
/** A file in the home, its folder made. */
const file = (p: string, text = "x") => {
  mkdirSync(dirname(join(home, p)), { recursive: true });
  writeFileSync(join(home, p), text);
};
// What a real home holds: shell-sourced files at the tools' tops, their bin and shim folders, installed versions whose
// bin entries link into their own lib, a toolchain behind a proxy, a Python version's .pth, a bun global package.
for (const f of [
  ".bun/_bun", ".bun/bin/bun", ".bun/install/global/node_modules/cowsay/index.js",
  ".cargo/env", ".cargo/bin/rustc", ".cargo/registry/index/x",
  ".rustup/settings.toml", ".rustup/toolchains/stable-x86_64/bin/rustc",
  ".local/share/mise/installs/node/22.11.0/lib/node_modules/npm/bin/npx-cli.js", ".local/share/mise/shims/node", ".local/share/mise/plugins/foo/bin/exec-env",
  ".asdf/asdf.sh", ".asdf/installs/python/3.12.1/lib/python3.12/site-packages/evil.pth", ".asdf/shims/python",
  ".volta/bin/node", ".volta/tools/image/node/20.11.0/bin/node", ".volta/tools/user/platform.json",
  ".deno/bin/deno", ".deno/env", ".local/bin/git", "go/bin/gopls", "go/pkg/mod/cache/x",
]) file(f);
symlinkSync("../lib/node_modules/npm/bin/npx-cli.js", (mkdirSync(join(home, ".local/share/mise/installs/node/22.11.0/bin"), { recursive: true }), join(home, ".local/share/mise/installs/node/22.11.0/bin/npx")));
symlinkSync("22.11.0", join(home, ".local/share/mise/installs/node/22"));
// What the agent's start makes first (agent.ts makeToolDirs).
for (const d of toolDirsToMake(home, () => false)) mkdirSync(d, { recursive: true });

test("the agent writes only its tools' install and cache folders: no PATH folder, no file a shell sources, no tool folder's top, nothing already installed", () => {
  // The server's own PATH (a service's) names none of the user's tool folders: what the user's shell adds is held anyway.
  const scope = agentScope({ folder, home, pathDirs: ["/usr/local/bin", "/usr/bin"] });
  const r = resolveSessionPolicy({ agentDir, cwd: folder, sessionId: "agent-path", home, parent: scope });
  assert.ok(r.ok, r.ok ? "" : r.error);
  // The backend's own view of it, as the sandbox extension builds one (index.ts backendPolicy).
  const policy = { ...r.value, network: { mode: "none" as const }, env: {}, sessionId: "agent-path" };
  const writes = (p: string) => checkWrite(policy, join(home, p)).ok;
  for (const p of [
    "webapps/motors/node_modules/x",
    ".local/share/mise/installs/node/23.1.0/bin/node", ".local/share/mise/installs/python/3.13.0/bin/python", ".local/share/mise/downloads/x", ".local/share/mise/plugins/new-plugin/bin/x",
    ".asdf/installs/python/3.13.0/bin/python",
    ".cargo/registry/cache/x.crate", ".cargo/git/db/x",
    ".rustup/toolchains/nightly-x86_64/bin/rustc", ".rustup/downloads/x", ".rustup/update-hashes/nightly",
    "go/pkg/mod/github.com/x/y@v1/z.go", ".bun/install/cache/x", ".volta/tools/image/node/22.1.0/bin/node", ".volta/tools/inventory/node/x.tar.gz",
  ])
    assert.equal(writes(p), true, `${p}: an install or cache folder, or a version it installs, writable`);
  for (const p of [
    // Files a shell profile sources, and anything new at a tool folder's top.
    ".bun/_bun", ".cargo/env", ".asdf/asdf.sh", ".deno/env", ".bun/fresh.sh", ".cargo/config.toml", ".rustup/settings.toml", ".volta/tools/user/platform.json",
    // On the PATH.
    ".local/bin/git", ".local/share/mise/shims/node", ".asdf/shims/python", ".cargo/bin/cargo-evil", ".bun/bin/bun", "go/bin/tool", ".deno/bin/deno", ".volta/bin/node",
    // Already installed, and what its bin entries link to or load.
    ".local/share/mise/installs/node/22.11.0/lib/node_modules/npm/bin/npx-cli.js", ".local/share/mise/installs/node/22.11.0/bin/npx", ".local/share/mise/installs/node/22/lib/x",
    ".local/share/mise/plugins/foo/bin/exec-env", ".asdf/installs/python/3.12.1/lib/python3.12/site-packages/evil.pth",
    ".rustup/toolchains/stable-x86_64/bin/rustc", ".volta/tools/image/node/20.11.0/bin/node", ".bun/install/global/node_modules/cowsay/index.js",
  ])
    assert.equal(writes(p), false, `${p}: runs in the user's next shell or chat, read-only`);
});
