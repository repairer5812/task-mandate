import { issueMandate } from "@task-mandate/core";
import { describe, expect, it, vi } from "vitest";
import { mandatedFetch, signRequest } from "../src/index.js";

const SITE = "https://court.example";
const NOW = new Date("2026-12-01T00:00:00Z");

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", pair.privateKey), pub: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

async function mandate(audience = SITE, durationSec = 600) {
  const principal = await keys();
  const agent = await keys();
  const token = await issueMandate({ principalKey: principal.priv, agentPublicKey: agent.pub, audience, task: { type: "reserve" }, durationSec, now: NOW });
  return { agent, token };
}

describe("agent behavior", () => {
  it("rejects a different origin, a broken signature, and expiry before sending", async () => {
    const { agent, token } = await mandate();
    const body = JSON.stringify({ facility: "court-3" });
    const fake = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fake);
    try {
      await expect(mandatedFetch("https://evil.example/reserve", { method: "POST", body }, { mandate: token, agentKey: agent.priv, now: NOW })).rejects.toMatchObject({ code: "INPUT_INVALID" });
      const forged = token.replace(".", ".e");
      await expect(mandatedFetch(`${SITE}/reserve`, { method: "POST", body }, { mandate: forged, agentKey: agent.priv, now: NOW })).rejects.toMatchObject({ code: "INPUT_INVALID" });
      await expect(mandatedFetch(`${SITE}/reserve`, { method: "POST", body }, { mandate: token, agentKey: agent.priv, now: new Date(NOW.getTime() + 700_000) })).rejects.toMatchObject({ code: "INPUT_INVALID" });
      const exp = Math.floor(NOW.getTime() / 1000) + 600;
      await expect(mandatedFetch(`${SITE}/slots`, undefined, { mandate: token, agentKey: agent.priv, now: new Date((exp + 30) * 1000) })).rejects.toMatchObject({ code: "INPUT_INVALID" });
      expect(fake).not.toHaveBeenCalled();
      await mandatedFetch(`${SITE}/slots`, undefined, { mandate: token, agentKey: agent.priv, now: new Date((exp + 29) * 1000) });
      expect(fake).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("signRequest does not check the mandate and only creates a signature", async () => {
    const { agent, token } = await mandate();
    const body = JSON.stringify({ facility: "court-3" });
    const signed = await signRequest(new Request("https://evil.example/reserve", { method: "POST", body }), { mandate: token, agentKey: agent.priv, now: NOW });
    expect(signed.headers.get("signature")).toBeTruthy();
    expect(signed.headers.get("agent-mandate")).toBe(token);
  });

  it("does not create a signature when the body is over the limit", async () => {
    const { agent, token } = await mandate();
    const body = "x".repeat(64);
    await expect(signRequest(new Request(`${SITE}/reserve`, { method: "POST", body }), { mandate: token, agentKey: agent.priv, now: NOW, maxBodyBytes: 16 })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
});
