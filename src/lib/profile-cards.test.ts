// Run: pnpm test -- src/lib/profile-cards.test.ts. The profile cards' pure parts: the caption line
// and the Settings summary line, the groups and the filter threshold, a card's unusable reason, the System context fold's open
// state, and that Recent lists profile sessions.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ListedProfile, ProfilesListing } from "../../shared/profiles";
import type { SessionSummary } from "../../shared/protocol";
import { CARD_FILTER_AFTER, cardCount, cardMatches, cardUnusable, mySettingsCaption, pickerProfiles, pickerSections, profileCaption, profileSummary } from "./profiles";
import { recentEligible } from "./recent";
import { setSetupContextOpen, setupContextOpen } from "./setup-fold";

const SUBAGENTS = [
  { id: "off", footprint: "the agent picks" },
  { id: "claude-subs", footprint: "Opus 5.5 · Sonnet 5.5" },
];
const listed = (id: string, extra: Partial<ListedProfile> = {}): ListedProfile => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  icon: "wrench",
  description: "",
  remove: [],
  grant: [],
  singleton: false,
  limits: { hops: 3, perMessage: 10, perDay: 40, targetsPerRun: 5, perPair: 6 },
  overseerMayStart: false,
  source: "user",
  key: `user:${id}`,
  ...extra,
});
const listing = (yours: ListedProfile[], extra: Partial<ProfilesListing> = {}): ProfilesListing => ({
  builtins: [listed("default", { source: "sova", key: "sova:default", label: "My settings" })],
  yours,
  yoursFile: "/x/session-profiles.json",
  project: { state: "none", profiles: [] },
  problems: [],
  hidden: [],
  running: {},
  ...extra,
});

test("a card's caption: what it sets, in order, else its description", () => {
  assert.equal(
    profileCaption({ model: "claude-code-cli/claude-opus-5-5", thinking: "high", subagents: "claude-subs", description: "ignored" }, SUBAGENTS),
    "Opus 5.5 · high · subagents: Opus 5.5 · Sonnet 5.5",
  );
  assert.equal(profileCaption({ model: "deepseek/deepseek-v4", description: "" }, SUBAGENTS), "deepseek-v4");
  assert.equal(profileCaption({ subagents: "off", description: "" }, SUBAGENTS), "subagents: off");
  assert.equal(profileCaption({ subagents: "gone", description: "" }, SUBAGENTS), "subagents: gone", "an id this device lacks reads as the id");
  assert.equal(profileCaption({ thinking: "low", description: "" }), "low");
  assert.equal(profileCaption({ description: "Reads sessions; no shell." }, SUBAGENTS), "Reads sessions; no shell.");
});

test("a card's caption and the Settings summary add the mode and minor modes only when the profile sets them", () => {
  assert.equal(
    profileCaption({ thinking: "high", mode: "delegate", minorModes: ["align", "spec", "vis"], description: "ignored" }),
    "high · delegate · align, spec, vis",
  );
  assert.equal(profileCaption({ minorModes: [], description: "ignored" }), "no minor modes", "[] is said, never left out");
  assert.equal(profileCaption({ mode: "normal", description: "" }), "normal");
  const sum = (p: Partial<Parameters<typeof profileSummary>[0]>) => profileSummary({ remove: [], grant: [], singleton: false, ...p });
  assert.equal(sum({ grant: ["sessions.read"], singleton: true, mode: "delegate", minorModes: ["spec"] }), "reads sessions · One at a time · delegate · spec");
  assert.equal(sum({ minorModes: [] }), "no minor modes");
  assert.equal(sum({ remove: ["web"] }), "no web", "a profile that sets neither: as before");
  assert.equal(sum({}), "Nothing changed");
});

test("the grid's groups leave hidden profiles out, never My settings; the filter shows past 9 cards", () => {
  const l = listing([listed("a"), listed("b")], { hidden: ["user:b", "sova:default"] });
  const g = pickerProfiles(l);
  assert.equal(g.mine?.key, "sova:default", "My settings is its own card, whatever the hidden list says");
  assert.deepEqual(g.builtins, [], "Default is not among the shipped ones");
  assert.deepEqual(g.yours.map((p) => p.key), ["user:a"]);
  assert.equal(cardCount(g), 3, "My settings, a and Custom…");
  const many = pickerProfiles(listing(Array.from({ length: 8 }, (_, i) => listed(`p${i}`))));
  assert.equal(cardCount(many), 10);
  assert.ok(cardCount(many) > CARD_FILTER_AFTER);
  assert.ok(!(cardCount(pickerProfiles(listing(Array.from({ length: 7 }, (_, i) => listed(`p${i}`))))) > CARD_FILTER_AFTER), "9 cards: no field");
  assert.equal(cardMatches({ label: "Claude session" }, "  claude "), true);
  assert.equal(cardMatches({ label: "Claude session" }, "deep"), false);
  assert.equal(cardMatches({ label: "Claude session" }, ""), true);
});

test("the picker's order: My settings, Yours, This project, then a shipped profile", () => {
  const shipped = listed("ship", { source: "sova", key: "sova:ship" });
  const proj = listed("proj", { source: "project", key: "project:/w#proj", project: "/w", projectName: "w" });
  const g = pickerProfiles(listing([listed("mine-1")], { builtins: [listing([]).builtins[0]!, shipped], project: { state: "ok", name: "w", root: "/w", profiles: [proj] } }));
  const s = pickerSections(g);
  assert.deepEqual(
    s.map((x) => [x.label, x.cards.map((p) => p.key)]),
    [
      [null, ["sova:default"]],
      ["Yours", ["user:mine-1"]],
      ["This project (w)", ["project:/w#proj"]],
      ["Built in", ["sova:ship"]],
    ],
  );
  assert.deepEqual(pickerSections(pickerProfiles(listing([]))).map((x) => x.id), ["mine"], "an empty section is left out");
});

test("My settings' caption: the mode, minor modes, model and effort it stands for", () => {
  assert.equal(mySettingsCaption({ mode: "delegate", minorModes: ["align"], model: "claude-code-cli/claude-opus-5-5" }), "Delegate · Align · Opus 5.5");
  assert.equal(mySettingsCaption({ mode: "normal", minorModes: ["align", "spec"], model: "zai/glm-5.3", thinking: "high" }), "Normal · Align, Spec · glm-5.3 · high");
  assert.equal(mySettingsCaption({ mode: "normal", minorModes: [] }), "Normal", "no minor modes: left out");
  assert.equal(mySettingsCaption(null), "Your own settings");
  assert.equal(mySettingsCaption({}), "Your own settings");
});

test("a card is unusable exactly when the listing says why", () => {
  const l = listing([listed("a"), listed("b")], { unusable: { "user:b": "No credentials here for zai/glm-5.3." } });
  assert.equal(cardUnusable(l, { key: "user:a" }), null);
  assert.equal(cardUnusable(l, { key: "user:b" }), "No credentials here for zai/glm-5.3.");
  assert.equal(cardUnusable(undefined, { key: "user:b" }), null);
});

test("the System context fold: closed by default, kept open per session until closed", () => {
  assert.equal(setupContextOpen("/s/a.jsonl"), false);
  setSetupContextOpen("/s/a.jsonl", true);
  assert.equal(setupContextOpen("/s/a.jsonl"), true, "a redraw for the same session opens it again");
  assert.equal(setupContextOpen("/s/b.jsonl"), false, "another session's is its own");
  setSetupContextOpen("/s/a.jsonl", false);
  assert.equal(setupContextOpen("/s/a.jsonl"), false);
});

const session = (id: string, profile?: SessionSummary["profile"]) =>
  ({ id, path: `/s/${id}.jsonl`, title: id, cwd: "/w", createdAt: "2026-10-01T00:00:00Z", lastActiveAt: "2026-10-01T00:00:00Z", origin: "web", ...(profile ? { profile } : {}) }) as unknown as SessionSummary;

test("a profile session is in Recent, capability-neutral or not", () => {
  const neutral = session("n", { id: "claude", label: "Claude session", icon: "wrench", source: "user", neutral: true });
  const reviewer = session("r", { id: "reviewer", label: "Docs reviewer", icon: "eye", source: "user" });
  assert.equal(recentEligible(neutral), true);
  assert.equal(recentEligible(reviewer), true);
});
