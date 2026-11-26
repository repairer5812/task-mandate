// Acceptance tests for person attestation and one slot per person at a site. Do not edit to make a change pass.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { issueMandate, issuePersonAttestation, pairwiseId, memoryStore } from "@task-mandate/core";
import { signRequest } from "@task-mandate/node";
import { createApp } from "../apps/demo-site/src/app";

const SITE = "https://court.example";
const SITE2 = "https://pool.example";
const IDP = "https://idp.example";
const SECRET = "test-only-pairwise-secret";
const T0 = new Date("2026-12-01T00:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

type Pair = { priv: JsonWebKey; pub: JsonWebKey };
async function ed25519Jwk(): Promise<Pair> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}
const pubOnly = (k: JsonWebKey): JsonWebKey => ({ kty: k.kty, crv: k.crv, x: k.x });

let clock: Date;
const now = () => clock;
function setClock(d: Date) {
  clock = d;
  vi.setSystemTime(d);
}
let idp: Pair;
let otherIdp: Pair;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setClock(T0);
  idp = await ed25519Jwk();
  otherIdp = await ed25519Jwk();
});
afterEach(() => vi.useRealTimers());

function attest(personId: string, principal: Pair, opts: { audience?: string; durationSec?: number; key?: Pair } = {}) {
  return issuePersonAttestation({
    idpKey: (opts.key ?? idp).priv,
    idpIssuer: IDP,
    secret: SECRET,
    personId,
    audience: opts.audience ?? SITE,
    principalPublicKey: principal.pub,
    durationSec: opts.durationSec ?? 30 * 86400,
    now: clock,
  });
}

async function mandate(principal: Pair, agent: Pair, opts: { pa?: string; tid?: string; tbeg?: Date; maxActions?: number } = {}) {
  return issueMandate({
    principalKey: principal.priv,
    agentPublicKey: agent.pub,
    audience: SITE,
    task: { type: "reserve", resource: "court-3" },
    limits: { maxActions: opts.maxActions ?? 100 },
    ...(opts.pa ? { personAttestation: opts.pa } : {}),
    ...(opts.tid ? { taskId: opts.tid } : {}),
    ...(opts.tbeg ? { taskBegin: opts.tbeg } : {}),
    // With a task ID, set a task end (7 days) like a real renewed task.
    ...(opts.tid ? { taskEnd: at(7 * 24 * 60) } : {}),
    durationSec: 600,
    now: clock,
  });
}

function site(over: Record<string, unknown> = {}) {
  return createApp({
    origin: SITE,
    store: memoryStore({ now }),
    seats: { "court-3": 100 },
    now,
    personIssuers: [{ iss: IDP, jwks: [pubOnly(idp.pub)] }],
    requirePerson: true,
    onePerPerson: true,
    minSwitchSec: 600,
    ...over,
  } as Parameters<typeof createApp>[0]);
}

async function reserve(app: ReturnType<typeof createApp>, m: string, agent: Pair) {
  const req = new Request(`${SITE}/reserve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ facility: "court-3" }),
  });
  const res = await app.request(await signRequest(req, { mandate: m, agentKey: agent.priv, now: clock }));
  const body = await res.json();
  return { status: res.status, code: body.code as string | undefined };
}

describe("person attestation", () => {
  it("the pairwise id differs by site and is stable for the same input", async () => {
    const a = await pairwiseId(SECRET, "person-1", SITE);
    expect(await pairwiseId(SECRET, "person-1", SITE)).toBe(a);
    expect(await pairwiseId(SECRET, "person-1", SITE2)).not.toBe(a);
    expect(await pairwiseId(SECRET, "person-2", SITE)).not.toBe(a);
  });

  it("a site that requires an attestation returns PERSON_REQUIRED when it is absent", async () => {
    const me = await ed25519Jwk(), ag = await ed25519Jwk();
    expect((await reserve(site(), await mandate(me, ag), ag)).code).toBe("PERSON_REQUIRED");
  });

  it("a valid attestation is allowed", async () => {
    const me = await ed25519Jwk(), ag = await ed25519Jwk();
    const pa = await attest("person-1", me);
    const r = await reserve(site(), await mandate(me, ag, { pa, tid: "t1", tbeg: T0 }), ag);
    expect(r.status).toBe(200);
  });

  it("an attestation for another site is PERSON_INVALID", async () => {
    const me = await ed25519Jwk(), ag = await ed25519Jwk();
    const pa = await attest("person-1", me, { audience: SITE2 });
    expect((await reserve(site(), await mandate(me, ag, { pa, tid: "t1", tbeg: T0 }), ag)).code).toBe("PERSON_INVALID");
  });

  it("attaching someone else's attestation to my key is PERSON_INVALID", async () => {
    const victim = await ed25519Jwk(), me = await ed25519Jwk(), ag = await ed25519Jwk();
    const stolen = await attest("victim", victim);
    expect((await reserve(site(), await mandate(me, ag, { pa: stolen, tid: "t1", tbeg: T0 }), ag)).code).toBe("PERSON_INVALID");
  });

  it("an attestation from an untrusted issuer is PERSON_INVALID", async () => {
    const me = await ed25519Jwk(), ag = await ed25519Jwk();
    const pa = await attest("person-1", me, { key: otherIdp });
    expect((await reserve(site(), await mandate(me, ag, { pa, tid: "t1", tbeg: T0 }), ag)).code).toBe("PERSON_INVALID");
  });

  it("a site that does not require an attestation still rejects a bad one", async () => {
    const me = await ed25519Jwk(), ag = await ed25519Jwk();
    const pa = await attest("person-1", me, { audience: SITE2 });
    const app = site({ requirePerson: false, onePerPerson: false });
    expect((await reserve(app, await mandate(me, ag, { pa }), ag)).code).toBe("PERSON_INVALID");
  });

  it("an attestation that ends before the chunk cannot be used to issue", async () => {
    const me = await ed25519Jwk(), ag = await ed25519Jwk();
    const pa = await attest("person-1", me, { durationSec: 60 });
    await expect(mandate(me, ag, { pa })).rejects.toThrow();
  });
});

describe("one task per person at a site", () => {
  it("splitting one person's keys still blocks the second task", async () => {
    const app = site();
    const key1 = await ed25519Jwk(), key2 = await ed25519Jwk(), a1 = await ed25519Jwk(), a2 = await ed25519Jwk();
    const m1 = await mandate(key1, a1, { pa: await attest("p", key1), tid: "t1", tbeg: T0 });
    const m2 = await mandate(key2, a2, { pa: await attest("p", key2), tid: "t2", tbeg: T0 });
    expect((await reserve(app, m1, a1)).status).toBe(200);
    expect((await reserve(app, m2, a2)).code).toBe("SUPERSEDED");
  });

  it("giving the same task id to another agent still blocks that agent", async () => {
    const app = site();
    const me = await ed25519Jwk(), a1 = await ed25519Jwk(), a2 = await ed25519Jwk();
    const pa = await attest("p", me);
    expect((await reserve(app, await mandate(me, a1, { pa, tid: "t1", tbeg: T0 }), a1)).status).toBe(200);
    expect((await reserve(app, await mandate(me, a2, { pa, tid: "t1", tbeg: T0 }), a2)).code).toBe("SUPERSEDED");
  });

  it("a renewal chunk of the same task still passes", async () => {
    const app = site();
    const me = await ed25519Jwk(), ag = await ed25519Jwk();
    const pa = await attest("p", me);
    expect((await reserve(app, await mandate(me, ag, { pa, tid: "t1", tbeg: T0 }), ag)).status).toBe(200);
    setClock(at(5));
    expect((await reserve(app, await mandate(me, ag, { pa, tid: "t1", tbeg: T0 }), ag)).status).toBe(200);
    setClock(at(15));
    expect((await reserve(app, await mandate(me, ag, { pa, tid: "t1", tbeg: T0 }), ag)).status).toBe(200);
  });

  it("a new task inside the switch gap is blocked", async () => {
    const app = site();
    const me = await ed25519Jwk(), a1 = await ed25519Jwk(), a2 = await ed25519Jwk();
    const pa = await attest("p", me);
    expect((await reserve(app, await mandate(me, a1, { pa, tid: "old", tbeg: T0 }), a1)).status).toBe(200);
    setClock(at(5));
    expect((await reserve(app, await mandate(me, a2, { pa, tid: "new", tbeg: at(5) }), a2)).code).toBe("SUPERSEDED");
  });

  it("after the switch gap, a new task displaces the old one and the old one does not return", async () => {
    const app = site();
    const me = await ed25519Jwk(), a1 = await ed25519Jwk(), a2 = await ed25519Jwk();
    const pa = await attest("p", me);
    expect((await reserve(app, await mandate(me, a1, { pa, tid: "old", tbeg: T0 }), a1)).status).toBe(200);
    setClock(at(11));
    expect((await reserve(app, await mandate(me, a2, { pa, tid: "new", tbeg: at(11) }), a2)).status).toBe(200);
    expect((await reserve(app, await mandate(me, a1, { pa, tid: "old", tbeg: T0 }), a1)).code).toBe("SUPERSEDED");
    // The old task does not come back after the new task's chunk ends.
    setClock(at(40));
    expect((await reserve(app, await mandate(me, a1, { pa, tid: "old", tbeg: T0 }), a1)).code).toBe("SUPERSEDED");
  });

  it("the same task with only a new start is blocked, and the original chunk still passes", async () => {
    const app = site();
    const me = await ed25519Jwk(), ag = await ed25519Jwk();
    const pa = await attest("p", me);
    expect((await reserve(app, await mandate(me, ag, { pa, tid: "t1", tbeg: T0 }), ag)).status).toBe(200);
    setClock(at(11));
    expect((await reserve(app, await mandate(me, ag, { pa, tid: "t1", tbeg: at(11) }), ag)).code).toBe("SUPERSEDED");
    expect((await reserve(app, await mandate(me, ag, { pa, tid: "t1", tbeg: T0 }), ag)).status).toBe(200);
  });

  it("one-per-person with a task id and no start is MANDATE_MALFORMED", async () => {
    const me = await ed25519Jwk(), ag = await ed25519Jwk();
    const pa = await attest("p", me);
    expect((await reserve(site(), await mandate(me, ag, { pa, tid: "t1" }), ag)).code).toBe("MANDATE_MALFORMED");
  });

  it("different people do not block each other", async () => {
    const app = site();
    const p1 = await ed25519Jwk(), p2 = await ed25519Jwk(), a1 = await ed25519Jwk(), a2 = await ed25519Jwk();
    expect((await reserve(app, await mandate(p1, a1, { pa: await attest("alice", p1), tid: "t", tbeg: T0 }), a1)).status).toBe(200);
    expect((await reserve(app, await mandate(p2, a2, { pa: await attest("bob", p2), tid: "t", tbeg: T0 }), a2)).status).toBe(200);
  });
});

describe("site config errors", () => {
  it("a bad combination fails at startup", () => {
    expect(() => site({ requirePerson: false })).toThrow();
    expect(() => site({ minSwitchSec: 0 })).toThrow();
    expect(() => site({ personIssuers: [] })).toThrow();
    expect(() => site({ personIssuers: [{ iss: IDP, jwks: [pubOnly(idp.pub)] }, { iss: "https://idp2.example", jwks: [pubOnly(otherIdp.pub)] }] })).toThrow();
    expect(() => site({ origin: "https://Court.example/" })).toThrow();
  });
});
