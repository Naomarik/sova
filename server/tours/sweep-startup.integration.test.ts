// Run: node scripts/run-tests.mjs --integration server/tours/sweep-startup.integration.test.ts
// The deleted-chat tour sweep as the real server starts it (server/index.ts): against a throwaway
// PI_CODING_AGENT_DIR, a leftover from a cleanup a crash cut off is removed by the startup pass,
// a chat whose transcript is still there keeps its tour, and stop waits for the pass in flight.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-tour-sweep-start-")));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.PORT = "0";
for (const name of ["SOVA_TOKEN", "SOVA_AUTH", "HOST", "SOVA_ALLOWED_HOSTS", "SOVA_ALLOWED_ORIGINS"]) delete process.env[name];
process.env.SOVA_USAGE_POLL = "off"; process.env.SOVA_PRICES_FETCH = "off";
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const state = join(tmp, "agent", "sova");
const { tourEditionAssetsFixture, tourEditionFixture } = await import("../../shared/tour-fixtures");
const { TourStore } = await import("./store");
const { markTourSessionDeleted } = await import("./deleted");
const store = new TourStore(join(state, "tours"));
const leftover = tourEditionFixture(); leftover.sessionId = "crashed-cleanup-chat"; store.publishEdition(leftover, tourEditionAssetsFixture());
markTourSessionDeleted(state, leftover.sessionId); // The transcript was unlinked; its cleanup never ran.
const kept = tourEditionFixture(); kept.sessionId = "kept-transcript-chat"; store.publishEdition(kept, tourEditionAssetsFixture());
const project = join(tmp, "agent", "sessions", "--fixture-project--"); mkdirSync(project, { recursive: true });
writeFileSync(join(project, `2026-01-02T03-04-05-000Z_${kept.sessionId}.jsonl`), JSON.stringify({ type: "session", version: 3, id: kept.sessionId, timestamp: "2026-01-02T03:04:05.000Z", cwd: tmp }) + "\n");

// A chat whose remembered transcript is gone with no deletion marker: absence alone, first sighting.
const absent = tourEditionFixture(); absent.sessionId = "absent-transcript-chat"; store.publishEdition(absent, tourEditionAssetsFixture());
const absentFile = join(project, `2026-01-02T03-04-05-000Z_${absent.sessionId}.jsonl`);
writeFileSync(absentFile, JSON.stringify({ type: "session", version: 3, id: absent.sessionId, timestamp: "2026-01-02T03:04:05.000Z", cwd: tmp }) + "\n");
const { rememberTourOwner, readKnownTourOwner } = await import("./ownership");
if (!await rememberTourOwner(absent.sessionId, absentFile, { root: state })) throw new Error("fixture: the absent chat's owner was not remembered");
unlinkSync(absentFile);

const { server, tourSweep } = await import("../index");
after(() => { server.close(); server.closeAllConnections(); rmSync(tmp, { recursive: true, force: true }); });

test("the real server's startup pass removes a cut-off cleanup, keeps a present owner's tour, and stops cleanly", async () => {
  const first = await tourSweep.first;
  assert.equal(first.removed, 1, "the leftover with a durable deletion marker is cleaned at startup");
  assert.equal(first.failed, 0); assert.ok(first.unknown >= 1, "the absent chat was sighted, not cleaned");
  assert.equal(existsSync(join(state, "tours", leftover.sessionId)), false);
  assert.ok(store.readEdition(kept.sessionId, kept.manifest.id, kept.manifest.editionId), "a chat whose transcript exists keeps its checked edition");
  assert.ok(store.readEdition(absent.sessionId, absent.manifest.id, absent.manifest.editionId), "absence alone is never cleaned on the first pass after a start");
  assert.equal(readKnownTourOwner(absent.sessionId, state).status, "known", "positive control: its absence was provable (remembered file, plain folder)");
  await tourSweep.stop();
  assert.deepEqual(await tourSweep.run(), { checked: 0, removed: 0, unknown: 0, failed: 0 }, "no pass runs after stop");
  assert.ok(store.readEdition(kept.sessionId, kept.manifest.id, kept.manifest.editionId));
});
