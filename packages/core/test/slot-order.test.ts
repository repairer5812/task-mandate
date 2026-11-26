import { issueMandate, issuePersonAttestation, memoryStore } from "@task-mandate/core";
import { signRequest } from "@task-mandate/node";
import { describe, expect, it } from "vitest";
import { code, decide, ed25519, type KeyPair, NOW, SITE } from "./helpers.js";

const IDP = "https://idp.example";

function pub(key: KeyPair): JsonWebKey {
  return { kty: key.pub.kty, crv: key.pub.crv, x: key.pub.x };
}

// A LIMIT_EXCEEDED request from another agent with a later tbeg must not switch the slot.
describe("person slot and action count order", () => {
  it("a request over the limit does not change the person slot", async () => {
    const idp = await ed25519();
    const principal = await ed25519();
    const agent1 = await ed25519();
    const agent2 = await ed25519();
    const pa = await issuePersonAttestation({ idpKey: idp.priv, idpIssuer: IDP, secret: "slot-order-secret", personId: "person-1", audience: SITE, principalPublicKey: principal.pub, durationSec: 86_400, now: NOW });
    const taskEnd = new Date(NOW.getTime() + 86_400_000);
    const store = memoryStore();
    const config = { requirePerson: true, onePerPerson: true, minSwitchSec: 1, personIssuers: [{ iss: IDP, jwks: [pub(idp)] }] };
    const first = await issueMandate({ principalKey: principal.priv, agentPublicKey: agent1.pub, audience: SITE, task: { type: "reserve", resource: "court-3" }, limits: { maxActions: 1 }, taskId: "shared-task", taskBegin: NOW, taskEnd, personAttestation: pa, durationSec: 3600, now: NOW });
    expect(code(await decide(await signRequest(reserve(), { mandate: first, agentKey: agent1.priv, now: NOW }), { config, store }))).toBe("allow");

    const later = new Date(NOW.getTime() + 2_000);
    const second = await issueMandate({ principalKey: principal.priv, agentPublicKey: agent2.pub, audience: SITE, task: { type: "reserve", resource: "court-3" }, limits: { maxActions: 1 }, taskId: "shared-task", taskBegin: later, taskEnd, personAttestation: pa, durationSec: 3600, now: later });
    expect(code(await decide(await signRequest(reserve(), { mandate: second, agentKey: agent2.priv, now: later }), { config, store, now: later }))).toBe("LIMIT_EXCEEDED");

    const probe = await signRequest(new Request(`${SITE}/slots`), { mandate: first, agentKey: agent1.priv, now: later });
    expect(code(await decide(probe, { config, store, route: {}, now: later }))).toBe("allow");
  });
});

function reserve(): Request {
  return new Request(`${SITE}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility: "court-3" }) });
}
