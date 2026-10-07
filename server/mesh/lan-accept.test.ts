// Run: pnpm test -- server/mesh/lan-accept.test.ts
// Sova's handoff socket's rules that bind nothing (§mesh.lan/accept-process): the directory it will
// listen in, and its header deadline. The accept process and the handoff over real sockets:
// lan-accept.integration.test.ts.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { mintLanIdentity } from "./lan-cert";
import { HandoffServer } from "./lan-handoff";
import { HEADER_MS } from "./lan-handoff-protocol";

const sova = mintLanIdentity();
const root = mkdtempSync(join(tmpdir(), "acc-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDir = () => {
  const d = join(root, `d${n++}`);
  mkdirSync(d, { mode: 0o750 });
  chmodSync(d, 0o750);
  return d;
};

test("the handoff socket's directory must be Sova's own, closed to others; anything else at the path is left alone", async () => {
  const opts = (path: string) => ({ path, build: () => "b1", identity: () => sova, acceptedByPin: () => null, onPeer: () => {} });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const open = freshDir();
    chmodSync(open, 0o755);
    assert.match((await new HandoffServer(opts(join(open, "h.sock"))).start())!, /open to other users/);
    const gw = freshDir();
    chmodSync(gw, 0o770);
    assert.match((await new HandoffServer(opts(join(gw, "h.sock"))).start())!, /group writes/);
    const real = freshDir();
    const link = join(root, `link${n++}`);
    symlinkSync(real, link);
    assert.match((await new HandoffServer(opts(join(link, "h.sock"))).start())!, /symlink/);
    const other = freshDir();
    assert.match((await new HandoffServer({ ...opts(join(other, "h.sock")), owner: { uid: 12345, gid: 12345 } }).start())!, /owned by this user/);
    const file = freshDir();
    writeFileSync(join(file, "h.sock"), "not a socket");
    assert.match((await new HandoffServer(opts(join(file, "h.sock"))).start())!, /other than a socket/);
    assert.match((await new HandoffServer(opts(join(root, "missing", "h.sock"))).start())!, /doesn't exist/);
  } finally {
    console.warn = warn;
  }
});

test("a connection's header must arrive within 2 s: the handoff socket's default deadline", () => {
  assert.equal(HEADER_MS, 2_000);
});
