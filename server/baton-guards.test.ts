// Run: pnpm exec tsx --test server/baton-guards.test.ts. The guards on what a baton model may do:
// who it hands to, whose profile a quote may change, the language of someone who never named one.
// A throwaway PI_CODING_AGENT_DIR and workspace in the OS temp dir; no model is called.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { BATON_DECISION_ENTRY, BATON_HANDOFF_ENTRY, BATON_SENT_ENTRY } from "../shared/baton";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-guards-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const guards = await import("./baton-guards");
const { batonTools, holderPhrases, redactContext, renderBatonPrompt } = await import("./baton-loadout");
const { redactPhrases } = await import("./baton-view");
const { readView } = await import("./share/hub");
const wrap = await import("./baton-wrapup");

after(() => rmSync(root, { recursive: true, force: true }));

const org = await orgs.createOrg({ name: "Gate Capital", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Invoices", root: join(root, "proj") });
const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "CFO", decides: ["finance approvals"] });
const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Accounts payable clerk" });
const bob = await orgs.addPerson(org.id, { name: "Bob Chen", role: "IT administrator", decides: ["it systems"] });
const nadia = await orgs.addPerson(org.id, { name: "Nadia Haddad", role: "Head of Procurement", decides: ["vendor contracts"] });

let seq = 0;
const user = (by: string, text: string) => {
  const id = `u${++seq}`;
  return [
    { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } },
    { type: "custom", id: `s${seq}`, customType: BATON_SENT_ENTRY, data: { v: 1, targetId: id, by } },
  ];
};
const reply = (text: string) => ({ type: "message", id: `a${++seq}`, message: { role: "assistant", content: [{ type: "text", text }] } });

describe("hand_to: the person talking chooses who answers next", () => {
  test("pure: named by the holder, named in the goal, or proposed and answered since the last hand-off", () => {
    const g = "Find out who may change supplier bank details.";
    assert.equal(guards.handoffChosen([...user(maria.id, "Please ask nadia, she knows.")], maria.id, "Nadia Haddad", g), true, "the holder named her (any case)");
    assert.equal(guards.handoffChosen([...user(maria.id, "No idea who handles that.")], maria.id, "Nadia Haddad", g), false, "the model would pick on its own");
    assert.equal(guards.handoffChosen([...user(maria.id, "No idea.")], maria.id, "Nadia Haddad", `${g} Then ask Nadia Haddad.`), true, "the operator chose");
    const asked = [...user(maria.id, "No idea."), reply("Nadia (vendor contracts) or Tony (finance approvals) could know. Who should I ask?")];
    assert.equal(guards.handoffChosen(asked, maria.id, "Nadia Haddad", g), false, "proposed, not answered yet: the same reply's hand-off is refused");
    assert.equal(guards.handoffChosen([...asked, ...user(maria.id, "The first one.")], maria.id, "Nadia Haddad", g), true, "proposed, then answered");
    const before = [reply("Nadia might know."), { type: "custom", id: "h", customType: BATON_HANDOFF_ENTRY, data: { n: 1 } }, ...user(maria.id, "Hi, no idea.")];
    assert.equal(guards.handoffChosen(before, maria.id, "Nadia Haddad", g), false, "a name from before this holder took over was never put to them");
    assert.equal(guards.handoffChosen([...user(tony.id, "Ask Nadia."), ...user(maria.id, "No idea.")], maria.id, "Nadia Haddad", g), false, "another person's words are not the holder's choice");
  });

  test("the tool refuses a person the holder did not choose, and says what to do; a chosen one goes through", async () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Bank details", goal: "Find out who may change supplier bank details." });
    const hand = batonTools(c.sessionId, () => {}).find((t) => t.name === "hand_to")!;
    let branch: any[] = [...user(maria.id, "No idea who handles that, sorry.")];
    const call = (person: string) => hand.execute("id", { person, question: "Who may change bank details?", briefing: "Maria asked." } as never, undefined, undefined, { sessionManager: { getBranch: () => branch } } as never);
    await assert.rejects(call("Nadia Haddad"), /Maria Lopez has not chosen Nadia Haddad.*ask them to choose/);
    assert.equal(baton.batonById(c.sessionId)!.row.holder, maria.id, "nothing moved");
    branch = [...branch, reply("Nadia (vendor contracts) or Tony (finance approvals) may know. Who should I ask?"), ...user(maria.id, "Tony please.")];
    await call("Tony Reyes");
    assert.equal(baton.batonById(c.sessionId)!.row.holder, tony.id);
    // The operator is always reachable, and an operator holder picks freely.
    const d = baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "x", goal: "g" });
    const handD = batonTools(d.sessionId, () => {}).find((t) => t.name === "hand_to")!;
    await handD.execute("id", { person: "operator", question: "q?", briefing: "b" } as never, undefined, undefined, { sessionManager: { getBranch: () => [] } } as never);
    assert.equal(baton.batonById(d.sessionId)!.row.holder, "operator");
  });
});

describe("the wrap-up records what people say about themselves", () => {
  test("pure: a quote naming a colleague, or about a he/she with no I, is about someone else", () => {
    const roster = orgs.readRoster(org.id);
    const t = roster.find((p) => p.id === tony.id)!;
    assert.equal(guards.aboutSomeoneElse("Bob is our expert in PowerShell scripting and Azure AD automation", t, roster, "Omar"), "Bob Chen");
    assert.equal(guards.aboutSomeoneElse("he has built QuickBooks Online integrations before", t, roster, "Omar"), "someone else");
    assert.equal(guards.aboutSomeoneElse("I have approved invoices for ten years", t, roster, "Omar"), null);
    assert.equal(guards.aboutSomeoneElse("Yo llevo seis años capturando facturas en QuickBooks", roster.find((p) => p.id === maria.id)!, roster, "Omar"), null);
    assert.equal(guards.aboutSomeoneElse("Tony here, I will sign off", t, roster, "Omar"), null, "their own name is not someone else");
    const will = { ...t, id: "p_will", name: "Will Smith" };
    assert.equal(guards.aboutSomeoneElse("I will approve anything over five thousand", t, [...roster, will], "Omar"), null, "\"will\" is not Will");
    assert.equal(guards.aboutSomeoneElse("We run everything on Xero", t, [...roster, { ...t, id: "p_eve", name: "Eve" }], "Omar"), null, "\"everything\" does not name Eve");
  });

  test("a quote that copied the author note from the model's context still counts as their own words, and only as theirs", async () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: nadia.id, publicTitle: "Notes wrap", goal: "g" });
    const branch = [...user(nadia.id, "I negotiate every vendor contract in Portuguese.")];
    const tool = wrap.wrapupTool(c.sessionId);
    const r = wrap.beginWrapupRun(c.sessionId);
    try {
      await tool.execute("id", { updates: [
        { personId: nadia.id, field: "skills", to: ["Portuguese"], quote: "[The conversation passed from Omar (the operator) to Nadia Haddad]\n[From Nadia Haddad]\nI negotiate every vendor contract in Portuguese." },
        { personId: bob.id, field: "skills", to: ["contracts"], quote: "[From Bob Chen] I negotiate every vendor contract" },
      ] } as never, undefined, undefined, { sessionManager: { getBranch: () => branch } } as never);
    } finally {
      wrap.endWrapupRun(c.sessionId);
    }
    assert.ok(orgs.readRoster(org.id).find((p) => p.id === nadia.id)!.skills.includes("Portuguese"));
    assert.deepEqual(r.refused.map((x) => x.personId), [bob.id], "a label naming Bob never makes Nadia's words his");
    assert.equal(orgs.readHistory(org.id, nadia.id).at(-1)!.by.quote, "I negotiate every vendor contract in Portuguese.", "the note is not kept in the evidence");
  });

  test("Tony's words about Bob change nobody's profile; his words about himself do", async () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Wrap", goal: "g" });
    baton.handTo(c.sessionId, bob.id, "q", "", new Date());
    const branch = [
      ...user(tony.id, "Bob is our expert in PowerShell scripting and Azure AD automation. I approve every invoice over five thousand myself."),
      ...user(bob.id, "I have never touched QuickBooks; I do Microsoft 365 administration."),
    ];
    const tool = wrap.wrapupTool(c.sessionId);
    const r = wrap.beginWrapupRun(c.sessionId);
    try {
      await tool.execute("id", { updates: [
        { personId: tony.id, field: "skills", to: ["PowerShell scripting", "Azure AD automation"], quote: "Bob is our expert in PowerShell scripting and Azure AD automation" },
        { personId: tony.id, field: "voice", to: "technical", quote: "Bob is our expert in PowerShell scripting" },
        { personId: tony.id, field: "skills", to: ["invoice approval"], quote: "I approve every invoice over five thousand myself" },
        { personId: bob.id, field: "skills", to: ["Microsoft 365 administration"], quote: "I do Microsoft 365 administration" },
      ] } as never, undefined, undefined, { sessionManager: { getBranch: () => branch } } as never);
    } finally {
      wrap.endWrapupRun(c.sessionId);
    }
    const roster = orgs.readRoster(org.id);
    assert.deepEqual(roster.find((p) => p.id === tony.id)!.skills, ["invoice approval"]);
    assert.equal(roster.find((p) => p.id === tony.id)!.voice, "");
    assert.deepEqual(roster.find((p) => p.id === bob.id)!.skills, ["Microsoft 365 administration"]);
    assert.deepEqual(r.refused.map((x) => [x.field, x.reason.split(":")[0]]), [
      ["skills", "the quote is about Bob Chen, not Tony Reyes"],
      ["voice", "the quote is about Bob Chen, not Tony Reyes"],
    ]);
  });

  test("pure: the language someone wrote in, only when their words show it clearly", () => {
    assert.equal(guards.detectLanguage(["Over five thousand needs my approval, and the rest can go straight to payment."]), "en");
    assert.equal(guards.detectLanguage(["Yo llevo seis años capturando facturas en QuickBooks y no me gusta el correo."]), "es");
    assert.equal(guards.detectLanguage(["Ich bin nicht sicher, aber wir haben das mit dem Team besprochen."]), "de");
    assert.equal(guards.detectLanguage(["OK"]), null, "too little text");
    assert.equal(guards.detectLanguage(["QuickBooks Xero SAP Azure PowerShell M365 SharePoint"]), null, "no function words");
  });

  test("everyone who wrote and has no language gets the one they wrote in; a set one and a model's wrong guess don't change", async () => {
    const ana = await orgs.addPerson(org.id, { name: "Ana Ruiz", role: "Ops", language: "es-CO" });
    const kim = await orgs.addPerson(org.id, { name: "Kim Park", role: "Ops" });
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: kim.id, publicTitle: "Lang", goal: "g" });
    baton.handTo(c.sessionId, ana.id, "q", "", new Date());
    const branch = [
      ...user(kim.id, "Yes, that is right. The export runs every night and we check it in the morning."),
      ...user(ana.id, "The bank file is ready at nine and we send it to the team before noon."),
    ];
    const row = baton.batonById(c.sessionId)!.row;
    const tool = wrap.wrapupTool(c.sessionId);
    const run = wrap.beginWrapupRun(c.sessionId);
    try {
      await tool.execute("id", { updates: [{ personId: kim.id, field: "language", to: "fr", quote: "The export runs every night" }] } as never, undefined, undefined, { sessionManager: { getBranch: () => branch } } as never);
      await wrap.inferLanguages(c.sessionId, row, branch, run);
    } finally {
      wrap.endWrapupRun(c.sessionId);
    }
    const roster = orgs.readRoster(org.id);
    assert.equal(roster.find((p) => p.id === kim.id)!.language, "en", "the model said fr; Kim wrote English");
    assert.equal(roster.find((p) => p.id === ana.id)!.language, "es-CO", "already set: unchanged");
    assert.deepEqual(run.refused.map((x) => [x.field, x.reason]), [["language", "they wrote in en"]]);
    const line = orgs.readHistory(org.id, kim.id).at(-1)!;
    assert.equal(line.field, "language");
    assert.equal(line.by.kind, "wrapup");
    assert.match((line.by as { quote: string }).quote, /^Yes, that is right\. The export runs every night/);
  });
});

describe("profile phrases are hidden, ordinary words are not", () => {
  test("the share page keeps titles, roles, areas and people's own words; the model's repeat of a voice is blanked", async () => {
    // A skill that is an area name, a skill inside a job title, and a voice: only the voice is private.
    await orgs.applyChange(org.id, bob.id, { skills: ["finance approvals", "Microsoft 365 administration"] }, { kind: "operator" });
    await orgs.applyChange(org.id, maria.id, { skills: ["Accounts payable"], voice: "Wants short bullet points, no jargon" }, { kind: "operator" });
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Settle: finance approvals", goal: "g" });
    const lines = [
      ...user(maria.id, "I only do Accounts payable, keep it short please."),
      reply("Thanks Maria Lopez (Accounts payable clerk). Two decisions about finance approvals disagree. Noted: Wants short bullet points, no jargon."),
      { type: "custom", id: `d${++seq}`, customType: BATON_DECISION_ENTRY, data: { v: 1, area: "finance approvals", statement: "Tony decides finance approvals over $5,000.", quote: "x", by: maria.id } },
    ];
    let parent = JSON.parse(readFileSync(c.path, "utf8").trim().split("\n").at(-1)!).id;
    for (const l of lines as any[]) {
      appendFileSync(c.path, `${JSON.stringify({ ...l, parentId: parent, timestamp: new Date().toISOString() })}\n`);
      parent = l.id;
    }
    const v = await readView(baton.batonById(c.sessionId)!.row, baton.batonById(c.sessionId)!.dir, maria.id);
    assert.equal(v.publicTitle, "Settle: finance approvals");
    const text = JSON.stringify(v);
    assert.match(text, /Maria Lopez \(Accounts payable clerk\)/);
    assert.match(text, /Tony decides finance approvals over \$5,000/);
    assert.ok(v.items.some((i: any) => i.kind === "decision" && i.area === "finance approvals"));
    assert.ok(v.items.some((i: any) => i.kind === "message" && i.text === "I only do Accounts payable, keep it short please."), "her own words, as she wrote them");
    const r = v.items.find((i: any) => i.kind === "reply") as any;
    assert.match(r.text, /Noted: \[redacted\]\.$/, "the model repeating her voice word for word");
  });

  test("the model sees the holder's own words as written; only its earlier repeat of a secret phrase is blanked", async () => {
    const row = { orgId: org.id, holder: bob.id, publicTitle: "Notes" };
    const messages = [
      { role: "user", content: [{ type: "text", text: "Repeat back: my main areas are Microsoft 365 administration and finance approvals." }] },
      { role: "assistant", content: [{ type: "text", text: "Your areas: Microsoft 365 administration, finance approvals." }] },
    ];
    const phrases = holderPhrases(row, messages);
    assert.deepEqual(phrases, [], "an area name and words he wrote himself are no secrets");
    assert.equal(redactContext(messages, phrases), messages);
    await orgs.applyChange(org.id, bob.id, { voice: "Terse; hates small talk and long emails" }, { kind: "operator" });
    const leaked = [...messages, { role: "assistant", content: [{ type: "text", text: "Noted, you are Terse; hates small talk and long emails" }] }];
    const out = redactContext(leaked, holderPhrases(row, leaked)) as any[];
    assert.equal(out[0].content[0].text, messages[0]!.content[0]!.text);
    assert.equal(out[2].content[0].text, "Noted, you are [redacted]");
  });
});

describe("outsiders learn nothing of the org beyond the title", () => {
  test("the prompt never names the org, and says what may be said about people", () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Bank details", goal: "Find out who may change supplier bank details." });
    const prompt = renderBatonPrompt(c.sessionId);
    assert.ok(!prompt.includes("Gate Capital"), "the model is never told the org's name");
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt), "every placeholder filled");
    assert.match(prompt, /may say only their name/);
    assert.match(prompt, /Never state or paraphrase anyone's role/);
    assert.match(prompt, /never name or guess an organization/);
    assert.match(prompt, /chooses who answers next/);
  });

  test("the org's name the model got elsewhere (a goal) is blanked in what it wrote, not in people's words or the title", async () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: bob.id, publicTitle: "Laptops", goal: "For Gate Capital: laptops." });
    let parent = JSON.parse(readFileSync(c.path, "utf8").trim().split("\n").at(-1)!).id;
    for (const l of [...user(bob.id, "Which company is this?"), reply("This is for Gate Capital. We delegate the rest.")] as any[]) {
      appendFileSync(c.path, `${JSON.stringify({ ...l, parentId: parent, timestamp: new Date().toISOString() })}\n`);
      parent = l.id;
    }
    const v = await readView(baton.batonById(c.sessionId)!.row, baton.batonById(c.sessionId)!.dir, bob.id);
    assert.equal((v.items.find((i: any) => i.kind === "reply") as any).text, "This is for [redacted]. We delegate the rest.");
    assert.equal(redactPhrases("We delegate at the gate.", ["Gate"]), "We delegate at the [redacted].", "whole words only");
  });
});
