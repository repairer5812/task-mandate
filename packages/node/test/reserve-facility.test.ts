import { issueMandate, issuePersonAttestation, memoryStore, type Store } from "@task-mandate/core";
import { signRequest } from "@task-mandate/node";
import { describe, expect, it } from "vitest";
import { createApp } from "../../../apps/demo-site/src/app.js";
import { ed25519, type KeyPair } from "../../core/test/helpers.js";

const SITE = "https://court.example";
const IDP = "https://idp.example";
const T0 = new Date("2026-12-01T00:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function pub(key: KeyPair): JsonWebKey {
  return { kty: key.pub.kty, crv: key.pub.crv, x: key.pub.x };
}

function watched(now: () => Date): { store: Store; consumed: () => number; slotted: () => number } {
  const inner = memoryStore({ now });
  let consumed = 0;
  let slotted = 0;
  return {
    store: {
      claimNonce: (nonce, ttlSec) => inner.claimNonce(nonce, ttlSec),
      consumeAction: async (key, max, ttlSec) => {
        consumed += 1;
        return inner.consumeAction(key, max, ttlSec);
      },
      refundAction: (key) => inner.refundAction(key),
      claimPersonSlot: async (input) => {
        slotted += 1;
        return inner.claimPersonSlot(input);
      },
    },
    consumed: () => consumed,
    slotted: () => slotted,
  };
}

describe("reserve facility check", () => {
  it("a different facility name is TASK_NOT_ALLOWED before the action count and the person slot", async () => {
    let clock = T0;
    const now = () => clock;
    const counts = watched(now);
    const idp = await ed25519();
    const app = createApp({ origin: SITE, store: counts.store, seats: { "court-3": 10, "court-4": 10 }, now, requirePerson: true, onePerPerson: true, personIssuers: [{ iss: IDP, jwks: [pub(idp)] }] });
    const principal = await ed25519();
    const pa = await issuePersonAttestation({ idpKey: idp.priv, idpIssuer: IDP, secret: "s".repeat(32), personId: "p1", audience: SITE, principalPublicKey: principal.pub, durationSec: 7200, now: T0 });
    const agentA = await ed25519();
    const agentB = await ed25519();
    const mandateA = await issueMandate({ principalKey: principal.priv, agentPublicKey: agentA.pub, audience: SITE, task: { type: "reserve", resource: "court-3" }, limits: { maxActions: 5 }, taskId: "task-a", taskBegin: T0, durationSec: 3600, personAttestation: pa, now: T0 });
    const reserve = (facility: string, mandate: string, agent: KeyPair, when: Date) => signRequest(new Request(`${SITE}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility }) }), { mandate, agentKey: agent.priv, now: when });

    expect((await app.request(await reserve("court-3", mandateA, agentA, clock))).status).toBe(200);
    const consumed = counts.consumed();
    const slotted = counts.slotted();

    clock = at(700);
    const mandateB = await issueMandate({ principalKey: principal.priv, agentPublicKey: agentB.pub, audience: SITE, task: { type: "reserve", resource: "court-3" }, limits: { maxActions: 5 }, taskId: "task-b", taskBegin: clock, durationSec: 3000, personAttestation: pa, now: clock });
    const wrong = await app.request(await reserve("court-4", mandateB, agentB, clock));
    expect((await wrong.json()).code).toBe("TASK_NOT_ALLOWED");
    expect(counts.consumed()).toBe(consumed);
    expect(counts.slotted()).toBe(slotted);

    expect((await app.request(await reserve("court-3", mandateA, agentA, clock))).status).toBe(200);
  });
});
