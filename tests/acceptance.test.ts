// Acceptance tests for reserving a facility with a task mandate. Do not edit to make a change pass.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { issueMandate, memoryStore } from "@task-mandate/core";
import { signRequest, mandatedFetch } from "@task-mandate/node";
import { createApp } from "../apps/demo-site/src/app";

const SITE = "https://court.example";
const OTHER_SITE = "https://other.example";
const NOW = new Date("2026-12-01T00:00:00Z");

async function ed25519Jwk() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { priv, pub };
}

let principal: { priv: JsonWebKey; pub: JsonWebKey };
let agent: { priv: JsonWebKey; pub: JsonWebKey };
let thief: { priv: JsonWebKey; pub: JsonWebKey };

beforeEach(async () => {
  principal = await ed25519Jwk();
  agent = await ed25519Jwk();
  thief = await ed25519Jwk();
});

function app() {
  return createApp({ origin: SITE, store: memoryStore(), seats: { "court-3": 2, "court-4": 1 }, now: () => NOW });
}

async function mandate(over: Partial<Parameters<typeof issueMandate>[0]> = {}) {
  return issueMandate({
    principalKey: principal.priv,
    agentPublicKey: agent.pub,
    audience: SITE,
    task: { type: "reserve", resource: "court-3" },
    limits: { maxActions: 1 },
    durationSec: 1800,
    now: NOW,
    ...over,
  });
}

// A mandate signed directly with the principal key, to test values that issueMandate refuses.
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
async function issuerOf(pub: JsonWebKey) {
  const canon = JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x });
  return `urn:jwk-thumbprint:sha-256:${b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon)))}`;
}
async function forgeMandate(signer: { priv: JsonWebKey; pub: JsonWebKey }, over: Record<string, unknown>) {
  const iss = await issuerOf(signer.pub);
  const base = Math.floor(NOW.getTime() / 1000);
  const header = { typ: "dc+sd-jwt", alg: "EdDSA", jwk: { kty: "OKP", crv: "Ed25519", x: signer.pub.x } };
  const payload = {
    vct: "urn:task-mandate:v0", iss, sub: iss, aud: SITE,
    cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: agent.pub.x } },
    task: { type: "reserve", resource: "court-3" }, limits: { maxActions: 1 },
    iat: base, nbf: base, exp: base + 1800, jti: crypto.randomUUID(), ...over,
  };
  const input = `${b64u(new TextEncoder().encode(JSON.stringify(header)))}.${b64u(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const key = await crypto.subtle.importKey("jwk", { ...signer.priv, alg: undefined } as JsonWebKey, { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(input));
  return `${input}.${b64u(sig)}~`;
}

async function reserveRequest(m: string, body: unknown) {
  return signRequest(
    new Request(`${SITE}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { mandate: m, agentKey: agent.priv, now: NOW },
  );
}

async function reserve(a: ReturnType<typeof app>, m: string | undefined, key: JsonWebKey, facility = "court-3", at = NOW) {
  let req = new Request(`${SITE}/reserve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ facility }),
  });
  if (m) req = await signRequest(req, { mandate: m, agentKey: key, now: at });
  return a.request(req);
}

describe("task-mandate reservation", () => {
  it("the named agent can reserve the named facility during the window", async () => {
    const a = app();
    const res = await reserve(a, await mandate(), agent.priv);
    expect(res.status).toBe(200);
    const slots = await (await a.request(`${SITE}/slots`)).json();
    expect(slots["court-3"]).toBe(1);
  });

  it("a reservation without a mandate is a 401 challenge", async () => {
    const res = await reserve(app(), undefined, agent.priv);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ decision: "challenge", code: "NO_MANDATE" });
  });

  it("another key that stole the mandate cannot use it", async () => {
    const res = await reserve(app(), await mandate(), thief.priv);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ decision: "deny", code: "KEY_MISMATCH" });
  });

  it("a mandate for another site is rejected", async () => {
    const res = await reserve(app(), await mandate({ audience: OTHER_SITE }), agent.priv);
    expect((await res.json()).code).toBe("AUD_MISMATCH");
  });

  it("an expired mandate is rejected", async () => {
    const later = new Date(NOW.getTime() + 3600_000);
    const a = createApp({ origin: SITE, store: memoryStore(), seats: { "court-3": 2 }, now: () => later });
    const res = await reserve(a, await mandate(), agent.priv, "court-3", later);
    expect((await res.json()).code).toBe("EXPIRED");
  });

  it("a mandate before its start is rejected", async () => {
    const m = await mandate({ notBefore: new Date(NOW.getTime() + 600_000) });
    const res = await reserve(app(), m, agent.priv);
    expect((await res.json()).code).toBe("NOT_YET_VALID");
  });

  it("a facility that was not delegated cannot be reserved", async () => {
    const res = await reserve(app(), await mandate(), agent.priv, "court-4");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("TASK_NOT_ALLOWED");
  });

  it("a mandate for a different task type cannot reserve", async () => {
    const res = await reserve(app(), await mandate({ task: { type: "lookup", resource: "court-3" } }), agent.priv);
    expect((await res.json()).code).toBe("TASK_NOT_ALLOWED");
  });

  it("exceeding the action limit is rejected", async () => {
    const a = app();
    const m = await mandate();
    expect((await reserve(a, m, agent.priv)).status).toBe(200);
    const second = await reserve(a, m, agent.priv);
    expect((await second.json()).code).toBe("LIMIT_EXCEEDED");
  });

  it("sending the same signed request again is rejected", async () => {
    const a = app();
    const m = await mandate({ limits: { maxActions: 5 } });
    const req = await signRequest(
      new Request(`${SITE}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility: "court-3" }) }),
      { mandate: m, agentKey: agent.priv, now: NOW },
    );
    expect((await a.request(req.clone())).status).toBe(200);
    expect((await (await a.request(req)).json()).code).toBe("REPLAY");
  });

  it("a mandate longer than the site maximum is rejected", async () => {
    const res = await reserve(app(), await mandate({ durationSec: 30 * 86400 }), agent.priv);
    expect((await res.json()).code).toBe("LIFETIME_TOO_LONG");
  });

  it("a tampered mandate is rejected", async () => {
    const m = await mandate();
    const [h, p, s] = m.split("~")[0].split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.task.resource = "court-4";
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}~`;
    const res = await reserve(app(), forged, agent.priv, "court-4");
    expect((await res.json()).code).toBe("MANDATE_SIG_INVALID");
  });

  it("a full facility is 409", async () => {
    const a = app();
    const m1 = await mandate({ task: { type: "reserve", resource: "court-4" } });
    expect((await reserve(a, m1, agent.priv, "court-4")).status).toBe(200);
    const m2 = await mandate({ task: { type: "reserve", resource: "court-4" } });
    expect((await reserve(a, m2, agent.priv, "court-4")).status).toBe(409);
  });

  it("a rejection for an undelegated facility does not consume an action", async () => {
    const a = app();
    const m = await mandate();
    expect((await reserve(a, m, agent.priv, "court-4")).status).toBe(403);
    expect((await reserve(a, m, agent.priv, "court-3")).status).toBe(200);
  });

  it("a request that fails because the facility is full does not consume an action", async () => {
    // Two site instances sharing one store: the first has no seats, the second has seats.
    const store = memoryStore();
    const a = createApp({ origin: SITE, store, seats: { "court-3": 0 }, now: () => NOW });
    const m = await mandate();
    expect((await reserve(a, m, agent.priv)).status).toBe(409);
    const b = createApp({ origin: SITE, store, seats: { "court-3": 1 }, now: () => NOW });
    expect((await reserve(b, m, agent.priv)).status).toBe(200);
  });

  it("concurrent requests do not pass the action limit", async () => {
    const a = createApp({ origin: SITE, store: memoryStore(), seats: { "court-3": 10 }, now: () => NOW });
    const m = await mandate({ limits: { maxActions: 2 } });
    const results = await Promise.all(Array.from({ length: 6 }, () => reserve(a, m, agent.priv)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    const slots = await (await a.request(`${SITE}/slots`)).json();
    expect(slots["court-3"]).toBe(8);
  });

  it("a mandate whose subject names someone else is rejected", async () => {
    const victim = await ed25519Jwk();
    const m = await forgeMandate(principal, { sub: await issuerOf(victim.pub) });
    expect((await (await reserve(app(), m, agent.priv)).json()).code).toBe("MANDATE_MALFORMED");
  });

  it("a mandate whose start is after its expiry is rejected", async () => {
    const base = Math.floor(NOW.getTime() / 1000);
    const m = await forgeMandate(principal, { nbf: base + 50, exp: base - 10 });
    expect((await (await reserve(app(), m, agent.priv)).json()).code).toBe("MANDATE_MALFORMED");
  });

  it("a request signed for another site and replayed here is rejected", async () => {
    const m = await mandate();
    const signed = await signRequest(
      new Request("https://evil.example/reserve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility: "court-3" }) }),
      { mandate: m, agentKey: agent.priv, now: NOW },
    );
    // Forward a request sent to evil.example to the court.example server unchanged (Host stays evil.example).
    const res = await app().request(signed);
    expect((await res.json()).code).toBe("AUD_MISMATCH");
  });

  it("moving a seat-lookup signature onto a reservation is rejected", async () => {
    const m = await mandate({ limits: { maxActions: 5 } });
    const get = await signRequest(new Request(`${SITE}/slots`), { mandate: m, agentKey: agent.priv, now: NOW });
    const headers = new Headers(get.headers);
    headers.set("content-type", "application/json");
    const post = new Request(`${SITE}/reserve`, { method: "POST", headers, body: JSON.stringify({ facility: "court-3" }) });
    expect((await (await app().request(post)).json()).code).toBe("SIG_INVALID");
  });

  it("changing the body after signing is rejected", async () => {
    const m = await mandate({ limits: { maxActions: 5 } });
    const signed = await reserveRequest(m, { facility: "court-3" });
    const tampered = new Request(signed.url, { method: "POST", headers: signed.headers, body: JSON.stringify({ facility: "court-3", note: "x" }) });
    expect((await (await app().request(tampered)).json()).code).toBe("SIG_INVALID");
  });

  it("a facility whose name is an inherited property is treated as missing", async () => {
    const m = await mandate({ task: { type: "reserve", resource: "toString" } });
    const res = await reserve(app(), m, agent.priv, "toString");
    expect(res.status).toBe(404);
  });

  it("the agent fetch does not send to a site other than the mandate audience", async () => {
    const m = await mandate();
    const fake = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fake);
    try {
      await expect(mandatedFetch(`${OTHER_SITE}/reserve`, { method: "POST" }, { mandate: m, agentKey: agent.priv, now: NOW })).rejects.toThrow();
      expect(fake).not.toHaveBeenCalled();
      // Sends to the same site and does not follow the redirect.
      await mandatedFetch(`${SITE}/slots`, undefined, { mandate: m, agentKey: agent.priv, now: NOW });
      expect(fake).toHaveBeenCalledTimes(1);
      const sent = fake.mock.calls[0] as unknown[];
      const redirect = sent[0] instanceof Request ? sent[0].redirect : (sent[1] as RequestInit | undefined)?.redirect;
      expect(redirect).toBe("manual");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a directly signed mandate is allowed when its values are valid (control)", async () => {
    const m = await forgeMandate(principal, {});
    expect((await reserve(app(), m, agent.priv)).status).toBe(200);
  });

  it("listing seats does not need a mandate", async () => {
    const res = await app().request(`${SITE}/slots`);
    expect(res.status).toBe(200);
  });
});
