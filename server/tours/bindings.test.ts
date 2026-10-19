import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { TOUR_ATTACHMENT_ENTRY, TOUR_DETACHMENT_ENTRY, TOUR_LIMITS, projectTourPublic } from "../../shared/tour";
import { tourEditionAssetsFixture, tourManifestFixture } from "../../shared/tour-fixtures";
import type { HEntry } from "../../shared/harness";
import { BATON_OFFER_ENTRY, BATON_WRAPUP_ENTRY } from "../../shared/baton";
import { batonView } from "../baton-view";
import { TourBindings, tourBackupInventory, tourSnapshotFits, visibleTour } from "./bindings";
import { scopedTourRead, type BindingScope, type BindingReader } from "./bindings-scope";
import { commitAll, initRepo } from "../workspace-git";

const presentation = () => projectTourPublic(tourManifestFixture(), { id: "public-tour", editionId: "checked-edition" });
const pictures = () => { const a = tourEditionAssetsFixture(); a.delete("contact-sheet.png"); return a; };
const entry = (id: string, key: string, data: unknown): HEntry => ({ kind: "state", id, parentId: null, key, data });
const row = { publicTitle: "A reviewed interface", state: "open" as const, holder: "reader" };

test("checked handoff snapshot restores using the workspace alone, without source metadata or recording host", () => {
  const root = mkdtempSync(join(tmpdir(), "sova-tour-bindings-"));
  try {
    const source = join(root, "source-workspace"), restored = join(root, "restored-workspace");
    const bindings = new TourBindings(source), m = presentation(), attachment = bindings.publish("conversation-one", m, pictures());
    // The backup must carry the conversation's authority too, not just picture files.
    mkdirSync(join(source, "sessions"));
    writeFileSync(join(source, "sessions", "conversation-one.jsonl"), JSON.stringify(entry("bound-tour", TOUR_ATTACHMENT_ENTRY, attachment)) + "\n");
    cpSync(source, restored, { recursive: true }); rmSync(source, { recursive: true });
    const restoredBranch: HEntry[] = readFileSync(join(restored, "sessions", "conversation-one.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const restoredView = batonView({ row, branch: restoredBranch, names: {}, redact: t => t });
    const restoredAttachment = visibleTour(restoredView, restoredBranch, attachment.handle);
    assert.deepEqual(restoredAttachment, attachment, "binding authority is recovered only from the copied conversation");
    const restoredStore = new TourBindings(restored), snapshot = restoredStore.read("conversation-one", restoredAttachment!);
    assert.ok(snapshot); assert.notEqual(snapshot.id, m.id); assert.notEqual(snapshot.editionId, m.editionId);
    assert.equal(snapshot.steps[0]!.views[0]!.route, null);
    for (const a of snapshot.assets) assert.deepEqual(restoredStore.asset("conversation-one", attachment, a.file)?.bytes, Buffer.from(pictures().get(a.file)!));
    for (const key of ["source", "provenance", "scriptDigest", "check", "accountId"]) assert.ok(!(key in snapshot));
    assert.equal(restoredStore.read("conversation-two", attachment), null);
    assert.equal(restoredStore.asset("conversation-one", attachment, "contact-sheet.png"), null);
    assert.equal(restoredStore.asset("conversation-one", attachment, "guessed.png"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("portable inventory validates exact public bytes and refuses symlinks, corruption and oversize snapshots", () => {
  const root = mkdtempSync(join(tmpdir(), "sova-tour-backup-"));
  try {
    const workspace = join(root, "workspace"), bindings = new TourBindings(workspace), attachment = bindings.publish("conversation-one", presentation(), pictures());
    const snapshot = join(workspace, "tours", "conversation-one", attachment.handle, attachment.edition);
    writeFileSync(join(snapshot, "private-script.json"), "not approved");
    const inventory = bindings.backupFiles(workspace, "conversation-one", attachment);
    assert.equal(inventory.length, attachment.files.length + 1);
    assert.ok(inventory.every(file => file.path.startsWith(`tours/conversation-one/${attachment.handle}/${attachment.edition}/`) && /^[a-f0-9]{40}$/.test(file.sha1) && /^[a-f0-9]{64}$/.test(file.sha256)));
    assert.ok(!inventory.some(file => file.path.endsWith("private-script.json")));
    const image = join(snapshot, attachment.files[0]!), bytes = readFileSync(image);
    const corrupted = Buffer.from(bytes); corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1; writeFileSync(image, corrupted);
    assert.throws(() => bindings.backupFiles(workspace, "conversation-one", attachment), /backup is incomplete/);
    writeFileSync(image, bytes);
    const outside = join(root, "outside.png"); writeFileSync(outside, bytes); rmSync(image); symlinkSync(outside, image);
    assert.throws(() => bindings.backupFiles(workspace, "conversation-one", attachment), /backup is incomplete/);
    const oversize = presentation(); oversize.assets = Array.from({ length: 18 }, (_, i) => ({ ...oversize.assets[0]!, file: `picture-${i}.png`, bytes: TOUR_LIMITS.assetBytes }));
    assert.equal(tourSnapshotFits(oversize), false);
    assert.throws(() => bindings.publish("conversation-two", oversize, pictures()), /every reviewed picture/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("backup inventory skips unreadable no-tour transcripts but never an unreadable attached one", async () => {
  const root = mkdtempSync(join(tmpdir(), "sova-tour-inventory-"));
  try {
    const workspace = join(root, "workspace"), sessions = join(workspace, "sessions"); mkdirSync(sessions, { recursive: true });
    // A conversation mid-creation: pi opens the file before its header line lands.
    writeFileSync(join(sessions, "2026-10-15_conversation-new.jsonl"), "");
    writeFileSync(join(sessions, "2026-10-15_conversation-partial.jsonl"), '{"type":"session","ver');
    assert.deepEqual(await tourBackupInventory(workspace), { files: [], conversations: [], detached: [], removedConversations: [] }, "ordinary content never blocks the backup");
    // Negative control: the same unreadable header with an attachment row is uncertainty, not skippable.
    const attachment = new TourBindings(workspace).publish("conversation-one", presentation(), pictures());
    writeFileSync(join(sessions, "conversation-one.jsonl"), JSON.stringify({ type: "custom", customType: TOUR_ATTACHMENT_ENTRY, data: attachment }) + "\n");
    await assert.rejects(tourBackupInventory(workspace), "an attached transcript whose identity cannot be read refuses rather than dropping its inventory");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an operator's ignore rule for tours/ never fails the backup: exact inventory travels, siblings never, detach leaves the next tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "sova-tour-ignored-"));
  try {
    const workspace = join(root, "workspace"); mkdirSync(workspace);
    writeFileSync(join(workspace, ".gitignore"), "/tours/\n*.png\nmanifest.json\n");
    await initRepo(workspace);
    const bindings = new TourBindings(workspace), attachment = bindings.publish("conversation-one", presentation(), pictures());
    const snapshot = join(workspace, "tours", "conversation-one", attachment.handle, attachment.edition);
    writeFileSync(join(snapshot, "recording-script.json"), "A private made-up script.");
    bindings.publish("conversation-one", projectTourPublic(tourManifestFixture(), { id: "unbound-tour", editionId: "unbound-edition" }), pictures());
    mkdirSync(join(workspace, "sessions")); const transcript = join(workspace, "sessions", "conversation-one.jsonl");
    writeFileSync(transcript, "A made-up transcript.\n");
    let branch: HEntry[] = [entry("bound", TOUR_ATTACHMENT_ENTRY, attachment)];
    const readTourConversation = async () => ({ id: "conversation-one", branch });
    const inventory = ["manifest.json", ...attachment.files].map(file => `tours/conversation-one/${attachment.handle}/${attachment.edition}/${file}`).sort();
    const committedTours = () => execFileSync("git", ["-C", workspace, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" }).split("\n").filter(path => path.startsWith("tours/")).sort();
    const ignored = await commitAll(workspace, "Back up a checked tour despite tours/ being ignored", { readTourConversation });
    assert.equal(ignored.error, undefined, ignored.error); assert.equal(ignored.committed, true);
    assert.deepEqual(committedTours(), inventory, "exact checked files only, never the script or the unbound snapshot");
    // The operator removes every ignore rule: plain add now sees the siblings, which must still stay out.
    writeFileSync(join(workspace, ".gitignore"), "*.tmp\n");
    const open = await commitAll(workspace, "Back up with no ignore rules", { readTourConversation });
    assert.equal(open.error, undefined, open.error); assert.deepEqual(committedTours(), inventory);
    branch = [...branch, entry("detach", TOUR_DETACHMENT_ENTRY, { v: 1, handle: attachment.handle })];
    writeFileSync(transcript, "A made-up transcript.\nDetached.\n");
    const detached = await commitAll(workspace, "Back up a detachment", { readTourConversation });
    assert.equal(detached.error, undefined, detached.error); assert.deepEqual(committedTours(), [], "the next tree drops the detached snapshot and picks up no sibling");
    for (const path of inventory) assert.ok(existsSync(join(workspace, path)), "detaching never deletes the retained bytes");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("neutral tour projection follows offer cut, wrap-up and branch; tool-result payloads never authorize a handle", async () => {
  const a = { v: 1 as const, handle: "tr_abcdefghijklmnop", title: "Public explanation", summary: "What to notice", steps: 1, edition: "edition-one", files: ["desktop.png", "phone.png"] };
  const tour = entry("tour-entry", TOUR_ATTACHMENT_ENTRY, a);
  const offer = entry("offer", BATON_OFFER_ENTRY, { n: 2, from: "operator", to: ["reader"], question: "Look?" });
  const wrap = entry("wrap", BATON_WRAPUP_ENTRY, {});
  const view = (branch: HEntry[], untilOffer?: number) => batonView({ row, branch, names: {}, viewer: "reader", redact: t => t.replace("Public", "Safe"), untilOffer });
  const visible = view([tour, offer], 2);
  assert.equal(visible.items[0]?.kind, "tour");
  assert.equal(visibleTour(visible, [tour, offer], a.handle)?.edition, a.edition);
  assert.ok(!JSON.stringify(visible).includes(a.edition)); assert.ok(!JSON.stringify(visible).includes("desktop.png"));
  assert.equal(visible.items[0]?.kind === "tour" && visible.items[0].title, "Safe explanation");
  for (const branch of [[offer, tour], [wrap, tour]]) {
    const filtered = view(branch, 2);
    assert.equal(visibleTour(filtered, branch, a.handle), null);
  }
  assert.equal(visibleTour(visible, [], a.handle), null, "branch switch discards stale view authority");
  const detached = [tour, offer, wrap, entry("detach", TOUR_DETACHMENT_ENTRY, { v: 1, handle: a.handle })];
  assert.equal(visibleTour(view(detached, 2), detached, a.handle), null, "detachment beyond visible offer/wrap-up cut revokes old handle");
  assert.equal(visibleTour(visible, detached, a.handle), null, "even a stale filtered item cannot bypass the active branch tombstone");
  const forged: HEntry = { kind: "tool-result", id: "tool", parentId: null, blocks: [], details: a };
  assert.equal(visibleTour(view([forged]), [forged], a.handle), null);
});

test("a show_tour result shows the attached tour again at its position, re-checked at view time", () => {
  const a = { v: 1 as const, handle: "tr_abcdefghijklmnop", title: "Public explanation", summary: "What to notice", steps: 1, edition: "edition-one", files: ["desktop.png"] };
  const tour = entry("tour-entry", TOUR_ATTACHMENT_ENTRY, a);
  const shown = (id: string, handle: string, extra: Partial<Extract<HEntry, { kind: "tool-result" }>> = {}): HEntry => ({ kind: "tool-result", id, parentId: null, tool: "show_tour", blocks: [], details: { v: 1, handle, title: "Forged title", summary: "Forged", steps: 9 }, ...extra });
  const reply: HEntry = { kind: "assistant", id: "reply", parentId: null, blocks: [{ type: "text", text: "Here it is." }] } as HEntry;
  const view = (branch: HEntry[], untilOffer?: number) => batonView({ row, branch, names: {}, viewer: "reader", redact: t => t.replace("Public", "Safe"), untilOffer });
  const tours = (branch: HEntry[], untilOffer?: number) => view(branch, untilOffer).items.flatMap(i => i.kind === "tour" ? [{ id: i.id, handle: i.handle, title: i.title, steps: i.steps }] : []);
  // Positive: attached above, shown later -> a second card at the result's position, copied from the attachment.
  const branch = [tour, reply, shown("show-1", a.handle)];
  assert.deepEqual(tours(branch), [{ id: "tour-entry", handle: a.handle, title: "Safe explanation", steps: 1 }, { id: "show-1", handle: a.handle, title: "Safe explanation", steps: 1 }]);
  assert.equal(view(branch).items.at(-1)?.id, "show-1", "placed where the model showed it, after its reply");
  assert.equal(visibleTour(view(branch), branch, a.handle)?.edition, a.edition, "authority still resolves to the attachment entry");
  // Detach removes both, even past the reader's cut.
  const detached = [...branch, entry("detach", TOUR_DETACHMENT_ENTRY, { v: 1, handle: a.handle })];
  assert.deepEqual(tours(detached), []);
  // Unbound / other-conversation handles, errors, other tools and a show before the attachment render nothing.
  assert.deepEqual(tours([tour, shown("other", "tr_zzzzzzzzzzzzzzzz")]).map(t => t.id), ["tour-entry"]);
  assert.deepEqual(tours([shown("alone", a.handle)]), [], "a result in a conversation without that attachment shows nothing");
  assert.deepEqual(tours([shown("early", a.handle), tour]).map(t => t.id), ["tour-entry"], "a show before the attachment authorizes nothing");
  assert.deepEqual(tours([tour, shown("failed", a.handle, { isError: true })]).map(t => t.id), ["tour-entry"]);
  assert.deepEqual(tours([tour, shown("other-tool", a.handle, { tool: "record_tour" })]).map(t => t.id), ["tour-entry"]);
  // Outside the reader's offer cut: never reached.
  const offer = entry("offer", BATON_OFFER_ENTRY, { n: 2, from: "operator", to: ["reader"], question: "Look?" });
  assert.deepEqual(tours([tour, offer, shown("late", a.handle)], 2).map(t => t.id), ["tour-entry"]);
});

test("revoked/expired, other conversation, outside-cut, cross-edition and guessed requests are 404-equivalent with zero tour file reads", async () => {
  const attachment = { v: 1 as const, handle: "tr_abcdefghijklmnop", title: "Public", summary: "Explanation", steps: 1, edition: "edition-one", files: ["desktop.png", "phone.png"] };
  const scope: BindingScope = { workspace: "/fake-workspace", sessionId: "conversation-one", reader: "person-one", attachment, phrase: t => t };
  let reads = 0;
  const reader: BindingReader = { read: () => { reads++; return presentation(); }, asset: () => { reads++; return { bytes: Buffer.from([1]), mime: "image/png" }; } };
  const store = () => reader;
  for (const why of ["revoked token", "expired token", "another conversation", "outside filtered cut", "never-holder invitee"]) {
    assert.equal(await scopedTourRead(async () => null, undefined, store), null, why);
    assert.equal(await scopedTourRead(async () => null, "desktop.png", store), null, why);
  }
  for (const file of ["other-edition.png", "guessed.png", "contact-sheet.png", "../desktop.png"]) assert.equal(await scopedTourRead(async () => scope, file, store), null, file);
  assert.equal(reads, 0, "authorization and immutable branch inventory precede ALL snapshot/asset reads");
  assert.ok(await scopedTourRead(async () => scope, "desktop.png", store)); assert.equal(reads, 1, "positive control reaches real read seam");
  let n = 0;
  assert.equal(await scopedTourRead(async () => ++n === 1 ? scope : null, "desktop.png", store), null, "revocation during asynchronous byte read discards bytes");
  n = 0;
  assert.equal(await scopedTourRead(async () => ++n === 1 ? scope : { ...scope, attachment: { ...attachment, edition: "edition-two" } }, undefined, store), null, "edition changed during asynchronous manifest read");
});
