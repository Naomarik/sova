// The kill-9 fuzz's offer child (kill9.test.ts, r12): a durable host on the shipped org, person and baton
// charts, on a virtual clock kept in a file (so time survives kills). It offers batons to three people in
// three zones (Ana 22:00–23:30 UTC, Bo 03:00–11:00, Cy no hours), moves the clock on by up to ~2 h a step
// and fires what is due, recording every per-invitee mint-link the host runs. Prints "ready <problems>"
// once open and "acted" after 5 steps (the parent kills only after that line).
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OrgHost } from "./index";

const [root, seedArg] = process.argv.slice(2);
let seed = Number(seedArg) || 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const clockFile = join(root!, "clock");
let now = existsSync(clockFile) ? Number(readFileSync(clockFile, "utf8")) || 1700000000000 : 1700000000000;
const tick = (ms: number) => {
  now += ms;
  writeFileSync(`${clockFile}.tmp`, String(now));
  renameSync(`${clockFile}.tmp`, clockFile); // atomic: a kill never leaves a torn clock
};

const everyDay = [0, 1, 2, 3, 4, 5, 6];
const people = [
  { id: "p1", name: "Ana", status: "active", tz: "UTC", hours: { days: everyDay, from: "22:00", to: "23:30" } },
  { id: "p2", name: "Bo", status: "active", tz: "UTC", hours: { days: everyDay, from: "03:00", to: "11:00" } },
  { id: "p3", name: "Cy", status: "active" },
];
const operator = { by: "operator" };

const host = await OrgHost.open({ orgId: "o1", workspaceDir: join(root!, "ws"), stateDir: join(root!, "state"), clock: () => now });
host.effects.register("mint-link", async (e) => {
  appendFileSync(join(root!, "mints.log"), `${JSON.stringify({ key: e.key, chartKey: e["chartKey"], personId: e["personId"], at: now })}\n`);
  return { minted: 1 };
});
process.stdout.write(`ready ${JSON.stringify(host.problems())}\n`);

if (!host.configuration("org/o1")) {
  await host.start("org/o1", "org", { id: "o1", name: "Acme", slug: "acme", createdAt: 1 }, operator);
  for (const p of people) {
    const { id, ...person } = p;
    await host.start(`person/o1/${id}`, "person", { orgId: "o1", id, person: { ...person, role: "R", decides: [], skills: [] }, changed: [], by: { kind: "operator" } }, operator);
  }
}

let steps = 0;
for (;;) {
  if (rnd() < 0.3) {
    const n = host.sessions("baton").length + 1;
    const sid = `baton/o1/s${n}`;
    if (!host.configuration(sid))
      await host.start(sid, "baton", {
        orgId: "o1", projectId: "pr1", sessionId: `s${n}`, publicTitle: "Logo", goal: "G", owner: { overseerOf: "pr1" },
        targets: ["p1", "p2", "p3"], targetPeople: people, names: { p1: "Ana", p2: "Bo", p3: "Cy" }, operatorName: "Omar",
      }, operator);
  }
  tick(Math.floor(rnd() * 2 * 3_600_000));
  host.fireDue();
  if (++steps === 5) process.stdout.write("acted\n");
  await new Promise((r) => setTimeout(r, rnd() < 0.3 ? 2 : 0));
}
