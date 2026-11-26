import { memoryStore, verifyRequest } from "@task-mandate/core";
import { describe, expect, it } from "vitest";
import { issueMandate, signRequest } from "../apps/demo-worker/public/js/task-mandate.js";

const ORIGIN = "https://court.example";
const NOW = new Date("2026-12-18T05:00:00Z");

async function ed25519(): Promise<{ priv: JsonWebKey; pub: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", pair.privateKey), pub: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

describe("browser signing bundle", () => {
  it("a mandate issued with the bundle, and its signature, pass verification", async () => {
    const principal = await ed25519();
    const agent = await ed25519();
    const mandate = await issueMandate({ principalKey: principal.priv, agentPublicKey: agent.pub, audience: ORIGIN, task: { type: "apply", resource: "basic-pension" }, limits: { maxActions: 1 }, durationSec: 600, now: NOW });
    const signed = await signRequest(new Request(`${ORIGIN}/civil/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "basic-pension" }) }), { mandate, agentKey: agent.priv, now: NOW });
    const decision = await verifyRequest(signed, { origin: ORIGIN }, { requireTask: { type: "apply", resource: "basic-pension" } }, memoryStore({ now: () => NOW }), NOW);
    expect(decision.decision).toBe("allow");
  });
});
