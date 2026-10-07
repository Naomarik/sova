// Run: pnpm exec tsx --test server/org-about-privacy.integration.test.ts. §app.organizations/about:
// over a real share listener on 127.0.0.1, a gathering link's page and its view never carry the
// org's About text. The whole of who sees it (every model, every surface) is org-about-privacy.test.ts,
// which reads the share routes in-process. A throwaway PI_CODING_AGENT_DIR and workspace in the OS
// temp dir; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "./test-scratch";

const root = scratchRoot("sova-about-int-");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const { createShareServer } = await import("./share/listener");
const { settled } = await import("./workspace-git");

const MARK = "ABOUT-SENTINEL-7f3a1c";
const ABOUT = `${MARK}. They pay late; keep Maria out of pricing.`;
const leaks = (s: string) => s.includes(MARK) || s.includes("pay late");

const server = createShareServer();
after(async () => {
  server.close();
  server.closeAllConnections();
  await settled(join(root, "ws"));
});

test("a gathering link's page and view over the share listener never carry the About text", async () => {
  const org = await orgs.createOrg({ name: "Qorvex Holdings", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Ledger", root: join(root, "proj") });
  const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });
  await orgs.patchOrg(org.id, { about: ABOUT });
  const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Servers", goal: "Find where the ledger runs" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = baton.rotateLink(c.sessionId).token;
  for (const p of [`/api/h/${token}`, `/h/${token}`]) {
    const res = await fetch(base + p);
    const text = await res.text();
    assert.ok(!leaks(text), `GET ${p} (${res.status})`);
  }
  // (/h/ is the shell page: 503 with no built page here, and never the session's content either way.)
  // Control: the page does carry what it should, so the absence above means something.
  assert.match(await (await fetch(`${base}/api/h/${token}`)).text(), /Servers/);
});
