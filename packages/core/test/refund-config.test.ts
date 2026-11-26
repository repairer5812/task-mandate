import { assertVerifierConfig, memoryStore, TaskMandateError } from "@task-mandate/core";
import { prunePersonState } from "@task-mandate/core/internal";
import { describe, expect, it } from "vitest";
import { code, decide, ed25519, issue, NOW, SITE, signed } from "./helpers.js";

describe("verify refund", () => {
  it("refund is a no-op on an allow that did not consume an action", async () => {
    const principal = await ed25519();
    const agent = await ed25519();
    const token = await issue(principal, agent, { limits: undefined });
    const store = memoryStore({ now: () => NOW });
    const decision = await decide(await signed(token, agent.priv), { store });
    expect(decision.decision).toBe("allow");
    if (decision.decision !== "allow") return;
    await decision.refund();
    await decision.refund();
    expect(code(await decide(await signed(token, agent.priv), { store }))).toBe("allow");
  });
});

describe("config and body length", () => {
  it("checks the clockSkewSec and maxTaskSec ranges", () => {
    expect(() => assertVerifierConfig({ origin: SITE, clockSkewSec: -1 })).toThrow(TaskMandateError);
    expect(() => assertVerifierConfig({ origin: SITE, maxTaskSec: 2_592_001 })).toThrow(TaskMandateError);
    expect(() => assertVerifierConfig({ origin: SITE, clockSkewSec: 0, maxTaskSec: 1 })).not.toThrow();
  });

  it("a person slot stays at the verification time even when the store clock is ahead", async () => {
    const now = 1_800_000_000;
    const store = memoryStore({ now: () => new Date((now + 7_200) * 1000) });
    const first = { personKey: "idp\u0000p", taskKey: "t1", agentKeyId: "a", taskBegin: now, expiresAt: now + 3_600, now, minSwitchSec: 600 };
    expect(await store.claimPersonSlot(first)).toBe("ok");
    expect(await store.claimPersonSlot({ ...first, taskKey: "t2", agentKeyId: "b", taskBegin: now + 10, now: now + 10 })).toBe("superseded");
  });

  it("onePerPerson alone is a config error, and without an attestation the action count is not consumed", async () => {
    expect(() => assertVerifierConfig({ origin: SITE, onePerPerson: true })).toThrow(TaskMandateError);
    const principal = await ed25519();
    const agent = await ed25519();
    const token = await issue(principal, agent);
    let consumed = 0;
    const store = memoryStore({ now: () => NOW });
    const wrapped = {
      claimNonce: store.claimNonce.bind(store),
      consumeAction: async (key: string, max: number, ttl: number) => {
        consumed += 1;
        return store.consumeAction(key, max, ttl);
      },
      refundAction: store.refundAction.bind(store),
      claimPersonSlot: store.claimPersonSlot.bind(store),
    };
    const decision = await decide(await signed(token, agent.priv), { store: wrapped, config: { requirePerson: true, personIssuers: [{ iss: "https://idp.example", jwks: [principal.pub] }] } });
    expect(code(decision)).toBe("PERSON_REQUIRED");
    expect(consumed).toBe(0);
  });
});

describe("person slot cleanup", () => {
  it("returns the same object when nothing is expired", () => {
    const state = { displaced: [{ taskKey: "t", agentKeyId: "a", expiresAt: 5_000 }] };
    expect(prunePersonState(state, 1_000)).toBe(state);
    expect(prunePersonState(state, 5_000)).not.toBe(state);
  });
});
