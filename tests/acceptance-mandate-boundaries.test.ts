// Acceptance tests for mandate limits, attestation expiry, the send cutoff, and slot order. Do not edit to make a change pass.
import { describe, expect, it, vi } from "vitest";
import { ISSUER_PREFIX, issueMandate, issuePersonAttestation, memoryStore, thumbprint, verifyRequest } from "@task-mandate/core";
import { mandatedFetch, signRequest } from "@task-mandate/node";
import { createApp } from "../apps/demo-site/src/app";

const SITE = "https://court.example";
const IDP = "https://idp.example";
const T0 = new Date("2026-12-01T00:00:00Z");
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const at = (s: number) => new Date(T0.getTime() + s * 1000);

type Pair = { priv: JsonWebKey; pub: JsonWebKey };
async function ed25519(): Promise<Pair> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}
const pub = (k: JsonWebKey): JsonWebKey => ({ kty: k.kty, crv: k.crv, x: k.x });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

async function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: JsonWebKey): Promise<string> {
  const input = `${b64(header)}.${b64(payload)}`;
  const k = await crypto.subtle.importKey("jwk", key, { name: "Ed25519" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, k, new TextEncoder().encode(input))).toString("base64url");
  return `${input}.${sig}`;
}

function forge(token: string, edit: (c: Record<string, unknown>) => void): string {
  const [h, p, s] = token.split("~")[0]!.split(".");
  const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
  edit(claims);
  return `${h}.${b64(claims)}.${s}~`;
}

const reserveReq = (facility = "court-3") =>
  new Request(`${SITE}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility }) });

describe("limits.maxActions must be 1 or greater", () => {
  it("a mandate with maxActions 0 is MANDATE_MALFORMED", async () => {
    const principal = await ed25519(), agent = await ed25519();
    const ok = await issueMandate({ principalKey: principal.priv, agentPublicKey: agent.pub, audience: SITE, task: { type: "reserve", resource: "court-3" }, limits: { maxActions: 1 }, durationSec: 600, now: T0 });
    const zero = forge(ok, (c) => { c.limits = { maxActions: 0 }; });
    const req = await signRequest(reserveReq(), { mandate: zero, agentKey: agent.priv, now: T0 });
    expect(await verifyRequest(req, { origin: SITE }, { requireTask: { type: "reserve" } }, memoryStore(), T0)).toMatchObject({ decision: "deny", code: "MANDATE_MALFORMED" });
  });
});

describe("person attestation must not expire before the mandate", () => {
  it("attestation exp earlier than mandate exp is PERSON_INVALID", async () => {
    const principal = await ed25519(), agent = await ed25519(), idp = await ed25519();
    const pa = await issuePersonAttestation({ idpKey: idp.priv, idpIssuer: IDP, secret: "s".repeat(32), personId: "p1", audience: SITE, principalPublicKey: principal.pub, durationSec: 300, now: T0 });
    const paSub = JSON.parse(Buffer.from(pa.split(".")[1]!, "base64url").toString()).sub;
    const iss = `${ISSUER_PREFIX}${await thumbprint(pub(principal.pub))}`;
    const mandate = `${await signJwt(
      { typ: "dc+sd-jwt", alg: "EdDSA", jwk: pub(principal.pub) },
      { vct: "urn:task-mandate:v0", iss, sub: paSub, aud: SITE, cnf: { jwk: pub(agent.pub) }, task: { type: "reserve", resource: "court-3" }, iat: sec(T0), nbf: sec(T0), exp: sec(T0) + 600, jti: "j-1", pa },
      principal.priv,
    )}~`;
    const req = await signRequest(reserveReq(), { mandate, agentKey: agent.priv, now: T0 });
    const config = { origin: SITE, requirePerson: true, personIssuers: [{ iss: IDP, jwks: [pub(idp.pub)] }] };
    expect(await verifyRequest(req, config, {}, memoryStore(), T0)).toMatchObject({ decision: "deny", code: "PERSON_INVALID" });
  });
});

describe("mandatedFetch uses the verifier's expiry boundary", () => {
  it("refuses to send at exactly exp + 30", async () => {
    const principal = await ed25519(), agent = await ed25519();
    const mandate = await issueMandate({ principalKey: principal.priv, agentPublicKey: agent.pub, audience: SITE, task: { type: "reserve" }, durationSec: 600, now: T0 });
    const fake = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fake);
    try {
      await expect(mandatedFetch(`${SITE}/slots`, undefined, { mandate, agentKey: agent.priv, now: at(630) })).rejects.toThrow();
      expect(fake).not.toHaveBeenCalled();
      await mandatedFetch(`${SITE}/slots`, undefined, { mandate, agentKey: agent.priv, now: at(629) });
      expect(fake).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("/reserve checks the facility before counting or claiming a slot", () => {
  it("a wrong-facility request is rejected before the count and the slot", async () => {
    let clock = T0;
    const now = () => clock;
    const idp = await ed25519();
    const app = createApp({
      origin: SITE,
      store: memoryStore({ now }),
      seats: { "court-3": 10, "court-4": 10 },
      now,
      requirePerson: true,
      onePerPerson: true,
      personIssuers: [{ iss: IDP, jwks: [pub(idp.pub)] }],
    });
    const principal = await ed25519();
    const pa = await issuePersonAttestation({ idpKey: idp.priv, idpIssuer: IDP, secret: "s".repeat(32), personId: "p1", audience: SITE, principalPublicKey: principal.pub, durationSec: 7200, now: T0 });
    const agentA = await ed25519(), agentB = await ed25519();
    const mandateA = await issueMandate({ principalKey: principal.priv, agentPublicKey: agentA.pub, audience: SITE, task: { type: "reserve", resource: "court-3" }, limits: { maxActions: 5 }, taskId: "task-a", taskBegin: T0, durationSec: 3600, personAttestation: pa, now: T0 });
    const first = await app.request(await signRequest(reserveReq("court-3"), { mandate: mandateA, agentKey: agentA.priv, now: clock }));
    expect(first.status).toBe(200);

    clock = at(700);
    const mandateB = await issueMandate({ principalKey: principal.priv, agentPublicKey: agentB.pub, audience: SITE, task: { type: "reserve", resource: "court-3" }, limits: { maxActions: 5 }, taskId: "task-b", taskBegin: clock, durationSec: 3000, personAttestation: pa, now: clock });
    const wrong = await app.request(await signRequest(reserveReq("court-4"), { mandate: mandateB, agentKey: agentB.priv, now: clock }));
    expect((await wrong.json()).code).toBe("TASK_NOT_ALLOWED");

    const again = await app.request(await signRequest(reserveReq("court-3"), { mandate: mandateA, agentKey: agentA.priv, now: clock }));
    expect(again.status).toBe(200);
  });
});
