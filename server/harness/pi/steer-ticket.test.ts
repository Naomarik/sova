// Run: pnpm test -- server/harness/pi/steer-ticket.test.ts. The steer ticket (steer-ticket.ts, quirk P29) on a
// stand-in of pi's shapes: an agent whose `steer` pushes onto `steeringQueue.messages`, a session whose
// `_steeringMessages` mirrors it. The real pi is pinned by contract.test.ts's P29 canary; this drives the case
// pi can't be made to produce on demand: an input step that queues a steer of its own, in the ticket's own
// async context, before the user's message is queued.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { steerTicket } from "./steer-ticket";

interface Msg {
  role: "user";
  content: { type: "text"; text: string }[];
}

/** pi's queueing half, structurally: `_queueSteer` pushes the mirror's text, then hands the object to `agent.steer`. */
function fakeSession() {
  const agent = {
    steeringQueue: { messages: [] as Msg[] },
    steer(message: Msg) {
      this.steeringQueue.messages.push(message);
    },
  };
  const session = {
    agent,
    _steeringMessages: [] as string[],
    updates: 0,
    _emitQueueUpdate() {
      this.updates++;
    },
  };
  /** AgentSession._queueSteer. */
  const queueSteer = (text: string): Msg => {
    session._steeringMessages.push(text);
    const msg: Msg = { role: "user", content: [{ type: "text", text }] };
    session.agent.steer(msg);
    return msg;
  };
  /** The agent loop's drain (steering mode all). */
  const drain = () => agent.steeringQueue.messages.splice(0);
  return { session, agent, queueSteer, drain };
}

/** A gate the hand-off's input step waits on (vision-delegate describing an image). */
function gate() {
  let open!: () => void;
  const shut = new Promise<void>((r) => (open = r));
  return { open, shut };
}

describe("steer ticket: a removal asked for during the hand-off (P29)", () => {
  test("an input step that queues a foreign steer first, in the ticket's context: the foreign one stays, the answer is unknown, nothing is spliced", async () => {
    const { session, agent, queueSteer } = fakeSession();
    const g = gate();
    const ticket = steerTicket(session as never);
    let foreign!: Msg;
    let mine!: Msg;
    const handing = ticket.run(async () => {
      foreign = queueSteer("an extension's own steer"); // pushed inside our hand-off, before ours
      await g.shut;
      mine = queueSteer("look at this");
    });
    assert.equal(ticket.remove(), "later", "asked for while the hand-off runs");
    assert.deepEqual(agent.steeringQueue.messages, [foreign], "nothing taken out at the first push");
    g.open();
    await handing;
    assert.deepEqual(agent.steeringQueue.messages, [foreign, mine], "two pushes in the hand-off: nothing spliced, the foreign steer stays");
    assert.deepEqual(session._steeringMessages, ["an extension's own steer", "look at this"]);
    assert.equal(ticket.remove(), "unknown", "no one message to name: refused, never guessed");
    assert.deepEqual(agent.steeringQueue.messages, [foreign, mine]);
  });

  test("the plain image case: one push, removed when the hand-off settles, the agent never gets it", async () => {
    const { session, agent, queueSteer, drain } = fakeSession();
    const other = queueSteer("someone else's, queued before"); // outside any ticket
    const g = gate();
    const ticket = steerTicket(session as never);
    const handing = ticket.run(async () => {
      await g.shut;
      queueSteer("look at this");
    });
    assert.equal(ticket.remove(), "later");
    g.open();
    await handing;
    assert.deepEqual(agent.steeringQueue.messages, [other], "ours is out of the lane, the other sender's stays");
    assert.deepEqual(session._steeringMessages, ["someone else's, queued before"], "and one entry of its text out of the mirror");
    assert.ok(session.updates >= 1, "pi's queue_update announced the shorter queue");
    assert.equal(ticket.remove(), "removed", "asking again says the same");
    assert.deepEqual(drain(), [other], "the agent's next step gets nothing of it");
  });

  test("a hand-off that queued nothing settles to unknown", async () => {
    const { session } = fakeSession();
    const ticket = steerTicket(session as never);
    const handing = ticket.run(async () => {});
    assert.equal(ticket.remove(), "later");
    await handing;
    assert.equal(ticket.remove(), "unknown");
  });

  test("after the hand-off settled: removed while in the lane, taken once the loop drained it", async () => {
    const { session, agent, queueSteer, drain } = fakeSession();
    const a = steerTicket(session as never);
    const b = steerTicket(session as never);
    await a.run(async () => void queueSteer("same"));
    await b.run(async () => void queueSteer("same"));
    const [first] = agent.steeringQueue.messages;
    assert.equal(b.remove(), "removed");
    assert.deepEqual(agent.steeringQueue.messages, [first], "exactly b's object left, by identity");
    drain();
    assert.equal(a.remove(), "taken");
  });
});
