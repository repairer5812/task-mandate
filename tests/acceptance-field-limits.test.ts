// Acceptance tests for field and header size limits. Do not edit to make a change pass.
import { describe, it, expect } from "vitest";
import { issueMandate, memoryStore, verifyRequest } from "@task-mandate/core";
import { signRequest } from "@task-mandate/node";

const SITE = "https://court.example";
const NOW = new Date("2026-12-01T00:00:00Z");

async function ed25519Jwk() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}

async function verify(over: Partial<Parameters<typeof issueMandate>[0]>, extraHeader?: [string, string]) {
  const principal = await ed25519Jwk(), agent = await ed25519Jwk();
  const m = await issueMandate({
    principalKey: principal.priv,
    agentPublicKey: agent.pub,
    audience: SITE,
    task: { type: "reserve", resource: "court-3" },
    durationSec: 600,
    now: NOW,
    ...over,
  });
  let req = await signRequest(new Request(`${SITE}/slots`), { mandate: m, agentKey: agent.priv, now: NOW });
  if (extraHeader) {
    const h = new Headers(req.headers);
    h.set(extraHeader[0], extraHeader[1]);
    req = new Request(req.url, { headers: h });
  }
  return verifyRequest(req, { origin: SITE }, {}, memoryStore(), NOW);
}

describe("public deployment limits: field length", () => {
  it("a normal length is allowed", async () => {
    expect((await verify({ taskId: "t".repeat(128) })).decision).toBe("allow");
  });

  it("a task id over 128 characters is MANDATE_MALFORMED", async () => {
    const d = await verify({ taskId: "t".repeat(129) });
    expect(d).toMatchObject({ decision: "deny", code: "MANDATE_MALFORMED" });
  });

  it("a mandate header over 8192 bytes is MANDATE_MALFORMED before signature checks", async () => {
    const d = await verify({}, ["agent-mandate", "x".repeat(8193)]);
    expect(d).toMatchObject({ decision: "deny", code: "MANDATE_MALFORMED" });
  });

  it("a large task that pushes the header over 8192 bytes is MANDATE_MALFORMED", async () => {
    const d = await verify({ task: { type: "reserve", resource: "court-3", params: { note: "x".repeat(9000) } } });
    expect(d).toMatchObject({ decision: "deny", code: "MANDATE_MALFORMED" });
  });
});
