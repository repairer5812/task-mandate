import { Jwt, uint8ArrayToBase64Url } from "@sd-jwt/core";
import { ISSUER_PREFIX, issueMandate, issuePersonAttestation, memoryStore, pairwiseId, thumbprint } from "@task-mandate/core";
import { CLAIM, JOSE, normalizePrivateJwk, PERSON } from "@task-mandate/core/internal";
import { describe, expect, it } from "vitest";
import { code, decide, ed25519, issue, type KeyPair, NOW, SITE, signed } from "./helpers.js";

const IDP = "https://idp.example";
const SECRET = "test-only-person-secret";

function pub(key: KeyPair): JsonWebKey {
  return { kty: key.pub.kty, crv: key.pub.crv, x: key.pub.x };
}

function attest(idp: KeyPair, principal: KeyPair, over: Partial<Parameters<typeof issuePersonAttestation>[0]> = {}) {
  return issuePersonAttestation({ idpKey: idp.priv, idpIssuer: IDP, secret: SECRET, personId: "person-1", audience: SITE, principalPublicKey: principal.pub, durationSec: 86_400, now: NOW, ...over });
}

describe("person attestation key", () => {
  it("verifies with the key kid points to, and does not trust the jwk in the header", async () => {
    const oldKey = await ed25519();
    const newKey = await ed25519();
    const principal = await ed25519();
    const agent = await ed25519();
    const pa = await attest(newKey, principal);
    const token = await issue(principal, agent, { personAttestation: pa, durationSec: 600 });
    const both = { origin: SITE, requirePerson: true, personIssuers: [{ iss: IDP, jwks: [pub(oldKey), pub(newKey)] }] };
    expect(code(await decide(await signed(token, agent.priv), { config: both }))).toBe("allow");
    expect(code(await decide(await signed(token, agent.priv), { config: { ...both, personIssuers: [{ iss: IDP, jwks: [pub(oldKey)] }] } }))).toBe("PERSON_INVALID");
    expect(code(await decide(await signed(token, agent.priv), { config: { ...both, personIssuers: [{ iss: IDP, jwks: [pub(newKey)] }] } }))).toBe("allow");

    const forged = await signedAttestation(
      newKey,
      { [JOSE.typ]: PERSON.typ, [JOSE.alg]: JOSE.algValue, [JOSE.kid]: "not-the-key", jwk: pub(newKey) },
      { [CLAIM.iss]: IDP, [CLAIM.sub]: await pairwiseId(SECRET, "person-1", SITE), [CLAIM.aud]: SITE, [CLAIM.cnf]: { [CLAIM.jwk]: pub(principal) }, [CLAIM.iat]: Math.floor(NOW.getTime() / 1000), [CLAIM.exp]: Math.floor(NOW.getTime() / 1000) + 86_400 },
    );
    const forgedMandate = await issue(principal, agent, { personAttestation: forged, durationSec: 600 });
    expect(code(await decide(await signed(forgedMandate, agent.priv), { config: both }))).toBe("PERSON_INVALID");
  });

  it("only an attestation longer than the chunk goes into the mandate, and the person id is the attestation sub", async () => {
    const idp = await ed25519();
    const principal = await ed25519();
    const agent = await ed25519();
    const short = await attest(idp, principal, { durationSec: 60 });
    await expect(issue(principal, agent, { personAttestation: short, durationSec: 600 })).rejects.toThrow(/attestation/);
    const pa = await attest(idp, principal, { durationSec: 600 });
    const token = await issueMandate({ principalKey: principal.priv, agentPublicKey: agent.pub, audience: SITE, task: { type: "reserve" }, personAttestation: pa, taskBegin: NOW, durationSec: 600, now: NOW });
    const payload = JSON.parse(Buffer.from(token.split("~")[0]!.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
    const claims = JSON.parse(Buffer.from(pa.split(".")[1]!, "base64url").toString()) as { sub: string };
    expect(payload[CLAIM.sub]).toBe(claims.sub);
    expect(payload[CLAIM.sub]).not.toBe(payload[CLAIM.iss]);
    expect(payload[CLAIM.tbeg]).toBe(Math.floor(NOW.getTime() / 1000));
    expect(code(await decide(await signed(token, agent.priv), { config: { requirePerson: true, personIssuers: [{ iss: IDP, jwks: [pub(idp)] }] } }))).toBe("allow");
  });

  it("is NOT_YET_VALID when iat is later than the allowed skew, and LIFETIME_TOO_LONG when the task length exceeds maxTaskSec", async () => {
    const principal = await ed25519();
    const agent = await ed25519();
    const later = new Date(NOW.getTime() + 120_000);
    const future = await issue(principal, agent, { now: later, notBefore: NOW, durationSec: 1800 });
    expect(code(await decide(await signed(future, agent.priv)))).toBe("NOT_YET_VALID");
    const long = await issue(principal, agent, { taskId: "long", taskBegin: NOW, taskEnd: new Date(NOW.getTime() + 40 * 86_400_000), durationSec: 600 });
    expect(code(await decide(await signed(long, agent.priv), { config: { maxTaskSec: 30 * 86_400 }, store: memoryStore() }))).toBe("LIFETIME_TOO_LONG");
  });

  it("applies the person slot even on a route that does not require a task", async () => {
    const idp = await ed25519();
    const principal = await ed25519();
    const agent = await ed25519();
    const pa = await attest(idp, principal);
    const store = memoryStore();
    const config = { requirePerson: true, onePerPerson: true, minSwitchSec: 600, personIssuers: [{ iss: IDP, jwks: [pub(idp)] }] };
    const taskEnd = new Date(NOW.getTime() + 86_400_000);
    const first = await issue(principal, agent, { personAttestation: pa, taskId: "a", taskBegin: NOW, taskEnd, durationSec: 600 });
    const second = await issue(principal, agent, { personAttestation: pa, taskId: "b", taskBegin: NOW, taskEnd, durationSec: 600 });
    expect(code(await decide(await signed(first, agent.priv), { config, route: {}, store }))).toBe("allow");
    expect(code(await decide(await signed(second, agent.priv), { config, route: {}, store }))).toBe("SUPERSEDED");
  });

  it("is PERSON_INVALID when the attestation iat is later than exp or the attestation ends before the mandate", async () => {
    const idp = await ed25519();
    const principal = await ed25519();
    const agent = await ed25519();
    const sec = Math.floor(NOW.getTime() / 1000);
    const config = { requirePerson: true, personIssuers: [{ iss: IDP, jwks: [pub(idp)] }] };
    const iss = `${ISSUER_PREFIX}${await thumbprint(pub(principal))}`;
    const sub = await pairwiseId(SECRET, "person-1", SITE);
    const header = { [JOSE.typ]: PERSON.typ, [JOSE.alg]: JOSE.algValue, [JOSE.kid]: await thumbprint(pub(idp)) };
    const reversed = await signedAttestation(idp, header, { [CLAIM.iss]: IDP, [CLAIM.sub]: sub, [CLAIM.aud]: SITE, [CLAIM.cnf]: { [CLAIM.jwk]: pub(principal) }, [CLAIM.iat]: sec, [CLAIM.exp]: sec - 1 });
    const reversedMandate = await signMandate(principal, { vct: "urn:task-mandate:v0", iss, sub, aud: SITE, cnf: { jwk: pub(agent) }, task: { type: "reserve", resource: "court-3" }, iat: sec - 1, nbf: sec - 1, exp: sec - 1, jti: "j-rev", pa: reversed });
    expect(code(await decide(await signed(reversedMandate, agent.priv), { config }))).toBe("PERSON_INVALID");

    const early = await attest(idp, principal, { durationSec: 300 });
    const earlySub = JSON.parse(Buffer.from(early.split(".")[1]!, "base64url").toString()).sub as string;
    const earlyMandate = await signMandate(principal, { vct: "urn:task-mandate:v0", iss, sub: earlySub, aud: SITE, cnf: { jwk: pub(agent) }, task: { type: "reserve", resource: "court-3" }, iat: sec, nbf: sec, exp: sec + 600, jti: "j-early", pa: early });
    expect(code(await decide(await signed(earlyMandate, agent.priv), { config }))).toBe("PERSON_INVALID");
  });

  it("does not create an attestation when audience is not an RFC 6454 origin", async () => {
    const idp = await ed25519();
    const principal = await ed25519();
    await expect(attest(idp, principal, { audience: "https://Court.example/" })).rejects.toThrow(/origin/);
  });
});

async function signMandate(principal: KeyPair, payload: Record<string, unknown>): Promise<string> {
  const compact = await signedAttestation(principal, { [JOSE.typ]: JOSE.typValue, [JOSE.alg]: JOSE.algValue, [JOSE.jwk]: pub(principal) }, payload);
  return `${compact}~`;
}

async function signedAttestation(idp: KeyPair, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", normalizePrivateJwk(idp.priv), { name: "Ed25519" }, false, ["sign"]);
  const jwt = new Jwt<Record<string, unknown>, Record<string, unknown>>();
  jwt.setHeader(header);
  jwt.setPayload(payload);
  return jwt.sign(async (data) => uint8ArrayToBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(data)))));
}
