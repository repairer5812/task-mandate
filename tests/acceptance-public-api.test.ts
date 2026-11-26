// Acceptance tests for the public API and shared verifier behavior. Do not edit to make a change pass.
import { describe, it, expect } from "vitest";
import * as core from "@task-mandate/core";
import * as internal from "@task-mandate/core/internal";
import { issueMandate, memoryStore, verifyRequest } from "@task-mandate/core";
import { signRequest, taskMandate } from "@task-mandate/node";

const SITE = "https://court.example";
const NOW = new Date("2026-12-01T00:00:00Z");

async function ed25519Jwk() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}

async function signedPost(body: string) {
  const principal = await ed25519Jwk(), agent = await ed25519Jwk();
  const mandate = await issueMandate({
    principalKey: principal.priv,
    agentPublicKey: agent.pub,
    audience: SITE,
    task: { type: "reserve", resource: "court-3" },
    durationSec: 600,
    now: NOW,
  });
  const req = new Request(`${SITE}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body });
  return signRequest(req, { mandate, agentKey: agent.priv, now: NOW });
}

describe("body size cap", () => {
  it("at or below maxBodyBytes passes, above it is BODY_TOO_LARGE", async () => {
    const ok = await verifyRequest(await signedPost("x".repeat(16)), { origin: SITE, maxBodyBytes: 16 }, {}, memoryStore(), NOW);
    expect(ok.decision).toBe("allow");
    const big = await verifyRequest(await signedPost("x".repeat(17)), { origin: SITE, maxBodyBytes: 16 }, {}, memoryStore(), NOW);
    expect(big).toMatchObject({ decision: "deny", code: "BODY_TOO_LARGE" });
  });

  it("the default cap is 1 MiB", async () => {
    const big = await verifyRequest(await signedPost("x".repeat(1048577)), { origin: SITE }, {}, memoryStore(), NOW);
    expect(big).toMatchObject({ decision: "deny", code: "BODY_TOO_LARGE" });
  });

  it("a bad maxBodyBytes is a config error", () => {
    expect(() => core.assertVerifierConfig({ origin: SITE, maxBodyBytes: 0 })).toThrow();
    expect(() => core.assertVerifierConfig({ origin: SITE, maxBodyBytes: 1.5 })).toThrow();
  });
});

describe("memory store cleanup", () => {
  it("expired nonce and action rows are removed", async () => {
    let clock = NOW;
    const store = memoryStore({ now: () => clock });
    await store.claimNonce("n1", 1);
    await store.consumeAction("k1", 5, 1);
    expect(store.size()).toMatchObject({ nonces: 1, actions: 1 });
    clock = new Date(NOW.getTime() + 2000);
    await store.claimNonce("n2", 60);
    expect(store.size()).toMatchObject({ nonces: 1, actions: 0 });
  });
});

describe("middleware requires a store", () => {
  it("missing store is a config error", () => {
    expect(() => taskMandate({ origin: SITE } as Parameters<typeof taskMandate>[0])).toThrow();
    expect(() => taskMandate({ origin: SITE, store: memoryStore() })).not.toThrow();
  });
});

describe("public API", () => {
  it("internal names are absent from core and present on internal", () => {
    for (const name of ["CLAIM", "COMPONENT", "JOSE", "PERSON", "SIGNATURE_TAG", "signatureComponents", "contentDigest", "digestKey", "normalizePrivateJwk", "applyPersonClaim", "prunePersonState", "actionCountKey", "readMandate"]) {
      expect(Object.hasOwn(core, name), name).toBe(false);
    }
    for (const name of ["CLAIM", "COMPONENT", "JOSE", "PERSON", "SIGNATURE_TAG", "signatureComponents", "contentDigest", "digestKey", "normalizePrivateJwk", "applyPersonClaim", "prunePersonState", "actionCountKey", "advanceAction"]) {
      expect(Object.hasOwn(internal, name), name).toBe(true);
    }
  });

  it("the public names that remain", () => {
    for (const name of ["verifyRequest", "assertVerifierConfig", "DEFAULT_CLOCK_SKEW_SEC", "SIGNATURE_MAX_AGE_SEC", "ISSUER_PREFIX", "PROFILE", "issueMandate", "issuePersonAttestation", "pairwiseId", "decodeMandateUnverified", "memoryStore", "nextRenewal", "thumbprint", "normalizePublicJwk"]) {
      expect(Object.hasOwn(core, name), name).toBe(true);
    }
  });

  it("decodeMandateUnverified returns header and payload without checking the signature", async () => {
    const principal = await ed25519Jwk(), agent = await ed25519Jwk();
    const m = await issueMandate({ principalKey: principal.priv, agentPublicKey: agent.pub, audience: SITE, task: { type: "reserve" }, durationSec: 600, now: NOW });
    expect(core.decodeMandateUnverified(m)?.payload.aud).toBe(SITE);
  });

  it("an allow decision has no actionConsumed", async () => {
    const d = await verifyRequest(await signedPost("{}"), { origin: SITE }, {}, memoryStore(), NOW);
    expect(d.decision).toBe("allow");
    expect(Object.hasOwn(d, "actionConsumed")).toBe(false);
  });
});

describe("advanceAction", () => {
  it("does not shorten expiry and counts to the limit", () => {
    const first = internal.advanceAction(undefined, 1000, 2, 60);
    expect(first).toMatchObject({ allowed: true });
    const second = internal.advanceAction(first.row, 1010, 2, 30);
    expect(second.allowed).toBe(true);
    expect(second.row.expiresAt).toBeGreaterThanOrEqual(first.row.expiresAt);
    expect(internal.advanceAction(second.row, 1020, 2, 60).allowed).toBe(false);
  });
});
