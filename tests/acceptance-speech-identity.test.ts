// Acceptance tests for speech interpretation and mock identity. Do not edit to make a change pass.
import { describe, it, expect, vi } from "vitest";
import { issueMandate, memoryStore } from "@task-mandate/core";
import { signRequest } from "@task-mandate/node";
import { createApp, memoryCivilLog, memoryCivilLimiter, memorySimBudget, type SimOptions } from "../apps/demo-site/src/app";

const SITE = "https://court.example";
const NOW = new Date("2026-12-18T05:00:00Z");
const now = () => NOW;

async function ed25519Jwk() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}

function app(sim: SimOptions, extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({ origin: SITE, store: memoryStore({ now }), seats: { "court-3": 5 }, civilLog: memoryCivilLog(), now, sim, ...extra });
}

function interpret(a: ReturnType<typeof createApp>, text: unknown, headers: Record<string, string> = {}) {
  return a.request(
    new Request(`${SITE}/sim/interpret`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ text }),
    }),
  );
}

describe("speech interpretation: rules", () => {
  it("without an LLM, rules interpret the speech", async () => {
    const res = await interpret(app({}), "기초연금 신청해 줘");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source: "rule", service: "basic-pension", title: "기초연금 신청(모의)", durationSec: 3600, maxActions: 1 });
  });

  it("count and duration words are understood", async () => {
    const body = await (await interpret(app({}), "등본 두 번 떼 줘, 오늘까지")).json();
    expect(body).toMatchObject({ source: "rule", service: "resident-copy", maxActions: 2, durationSec: 86400 });
    const taxi = await (await interpret(app({}), "콜택시 등록 10분 안에 세 번")).json();
    expect(taxi).toMatchObject({ service: "disability-taxi", maxActions: 3, durationSec: 600 });
  });

  it("an unknown task has a null service", async () => {
    expect((await (await interpret(app({}), "여권 만들어 줘")).json()).service).toBeNull();
  });

  it("empty speech or speech over 200 characters is 400 and does not call the LLM", async () => {
    const llm = vi.fn(async () => ({}));
    const a = app({ interpret: llm });
    expect((await interpret(a, "")).status).toBe(400);
    expect((await interpret(a, 3)).status).toBe(400);
    expect((await interpret(a, "가".repeat(201))).status).toBe(400);
    expect(llm).not.toHaveBeenCalled();
  });
});

describe("speech interpretation: LLM", () => {
  it("uses the LLM result and source is llm", async () => {
    const a = app({ interpret: async () => ({ service: "disability-taxi", durationSec: 600, maxActions: 2 }) });
    expect(await (await interpret(a, "택시 좀")).json()).toEqual({
      source: "llm",
      service: "disability-taxi",
      title: "장애인 콜택시 이용 등록(모의)",
      durationSec: 600,
      maxActions: 2,
    });
  });

  it("LLM output is clamped to the allowed range", async () => {
    const a = app({ interpret: async () => ({ service: "passport", durationSec: 999999, maxActions: 9, extra: "x" }) });
    expect(await (await interpret(a, "아무거나")).json()).toEqual({ source: "llm", service: null, title: null, durationSec: 86400, maxActions: 3 });
    const b = app({ interpret: async () => ({ service: "basic-pension", durationSec: 5, maxActions: 0 }) });
    expect(await (await interpret(b, "기초연금")).json()).toMatchObject({ durationSec: 60, maxActions: 1 });
    const c = app({ interpret: async () => "not an object" });
    expect(await (await interpret(c, "기초연금")).json()).toMatchObject({ source: "llm", service: null, durationSec: 3600, maxActions: 1 });
  });

  it("when the LLM fails, rules take over", async () => {
    const a = app({ interpret: async () => { throw new Error("down"); } });
    expect(await (await interpret(a, "기초연금 신청해 줘")).json()).toMatchObject({ source: "rule", service: "basic-pension" });
  });

  it("one IP gets 3 LLM calls per 600 seconds, then rules", async () => {
    const llm = vi.fn(async () => ({ service: "basic-pension", durationSec: 600, maxActions: 1 }));
    const a = app({ interpret: llm, llmLimiter: memoryCivilLimiter({ limit: 3, windowSec: 600 }), budget: memorySimBudget() });
    const ip = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < 3; i++) expect((await (await interpret(a, "기초연금", ip)).json()).source).toBe("llm");
    expect((await (await interpret(a, "기초연금", ip)).json()).source).toBe("rule");
    expect(llm).toHaveBeenCalledTimes(3);
    expect((await (await interpret(a, "기초연금", { "cf-connecting-ip": "198.51.100.9" })).json()).source).toBe("llm");
  });

  it("30 LLM calls per day, then rules", async () => {
    const llm = vi.fn(async () => ({ service: "basic-pension" }));
    const a = app({ interpret: llm, budget: memorySimBudget() });
    for (let i = 0; i < 30; i++) {
      expect((await (await interpret(a, "기초연금", { "cf-connecting-ip": `10.0.0.${i}` })).json()).source).toBe("llm");
    }
    expect((await (await interpret(a, "기초연금", { "cf-connecting-ip": "10.0.1.1" })).json()).source).toBe("rule");
    expect(llm).toHaveBeenCalledTimes(30);
  });

  it("a correct presenter code skips the limit, a wrong one does not", async () => {
    const llm = vi.fn(async () => ({ service: "basic-pension" }));
    const a = app({ interpret: llm, presenterCode: "stage-1218" });
    const ip = "203.0.113.7";
    for (let i = 0; i < 5; i++) {
      const body = await (await interpret(a, "기초연금", { "cf-connecting-ip": ip, "x-presenter-code": "stage-1218" })).json();
      expect(body.source).toBe("llm");
    }
    for (let i = 0; i < 3; i++) await interpret(a, "기초연금", { "cf-connecting-ip": ip, "x-presenter-code": "wrong" });
    expect((await (await interpret(a, "기초연금", { "cf-connecting-ip": ip, "x-presenter-code": "wrong" })).json()).source).toBe("rule");
  });
});

describe("mock identity", () => {
  async function idp() {
    const k = await ed25519Jwk();
    return { key: k.priv, pub: k.pub, issuer: "https://idp.example", secret: "s".repeat(32) };
  }

  function attest(a: ReturnType<typeof createApp>, body: unknown, ip = "203.0.113.7") {
    return a.request(
      new Request(`${SITE}/sim/attest`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify(body),
      }),
    );
  }

  it("a mandate built from an issued attestation is accepted at a site that requires a person", async () => {
    const i = await idp();
    const a = app(
      { idp: { key: i.key, issuer: i.issuer, secret: i.secret } },
      { requirePerson: true, personIssuers: [{ iss: i.issuer, jwks: [i.pub] }] },
    );
    const principal = await ed25519Jwk();
    const agent = await ed25519Jwk();
    const res = await attest(a, { principalPublicKey: principal.pub });
    expect(res.status).toBe(200);
    const { attestation, issuer } = await res.json();
    expect(issuer).toBe(i.issuer);
    const mandate = await issueMandate({
      principalKey: principal.priv,
      agentPublicKey: agent.pub,
      audience: SITE,
      task: { type: "apply", resource: "basic-pension" },
      limits: { maxActions: 1 },
      durationSec: 600,
      personAttestation: attestation,
      now: NOW,
    });
    const req = new Request(`${SITE}/civil/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "basic-pension" }),
    });
    const applied = await a.request(await signRequest(req, { mandate, agentKey: agent.priv, now: NOW }));
    expect(applied.status).toBe(200);
  });

  it("a private key or a non-Ed25519 key is 400", async () => {
    const i = await idp();
    const a = app({ idp: { key: i.key, issuer: i.issuer, secret: i.secret } });
    const principal = await ed25519Jwk();
    expect((await attest(a, { principalPublicKey: principal.priv })).status).toBe(400);
    expect((await attest(a, { principalPublicKey: { kty: "EC", crv: "P-256", x: "a", y: "b" } })).status).toBe(400);
    expect((await attest(a, {})).status).toBe(400);
  });

  it("missing issuer keys are 503", async () => {
    const principal = await ed25519Jwk();
    expect((await attest(app({}), { principalPublicKey: principal.pub })).status).toBe(503);
  });

  it("one IP gets 10 calls per 600 seconds, and the 11th is 429", async () => {
    const i = await idp();
    const a = app({ idp: { key: i.key, issuer: i.issuer, secret: i.secret } });
    const principal = await ed25519Jwk();
    for (let n = 0; n < 10; n++) expect((await attest(a, { principalPublicKey: principal.pub })).status).toBe(200);
    expect((await attest(a, { principalPublicKey: principal.pub })).status).toBe(429);
    expect((await attest(a, { principalPublicKey: principal.pub }, "198.51.100.9")).status).toBe(200);
  });
});
