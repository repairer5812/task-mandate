import { decodeMandateUnverified, memoryStore, PROFILE, thumbprint, verifyRequest } from "@task-mandate/core";
import { actionCountKey, CLAIM } from "@task-mandate/core/internal";
import { signRequest } from "@task-mandate/node";
import { beforeEach, describe, expect, it } from "vitest";
import { code, decide, ed25519, issue, type KeyPair, NOW, SITE, signed, signedUnchecked } from "./helpers.js";

let principal: KeyPair;
let agent: KeyPair;
let thief: KeyPair;

beforeEach(async () => {
  principal = await ed25519();
  agent = await ed25519();
  thief = await ed25519();
});

describe("verify codes", () => {
  it("on allow, returns the principal, agent, mandate id, and task, and increments the action count", async () => {
    const token = await issue(principal, agent, { limits: { maxActions: 2 } });
    const decoded = decodeMandateUnverified(token);
    const store = memoryStore();
    const decision = await decide(await signed(token, agent.priv), { store });
    expect(token.endsWith("~")).toBe(true);
    expect(decoded?.header.typ).toBe("dc+sd-jwt");
    expect(decoded?.header.alg).toBe("EdDSA");
    if (!decoded) throw new Error("mandate did not decode");
    expect((decoded.header.jwk as JsonWebKey).d).toBeUndefined();
    expect(decoded.payload[CLAIM.vct]).toBe(PROFILE.vct);
    expect((decoded.payload.cnf as { jwk: JsonWebKey }).jwk.d).toBeUndefined();
    expect(decision).toMatchObject({
      decision: "allow",
      principal: `${"urn:jwk-thumbprint:sha-256:"}${await thumbprint(principal.pub)}`,
      agentKeyId: await thumbprint(agent.pub),
      mandateId: decoded?.payload[CLAIM.jti],
      taskId: decoded?.payload[CLAIM.jti],
      task: { type: "reserve", resource: "court-3" },
      actionConsumed: true,
    });
    if (decision.decision !== "allow") throw new Error("expected an allow");
    const jti = String(decoded?.payload[CLAIM.jti]);
    const key = actionCountKey(decision.principal, SITE, decision.taskId);
    expect(await store.consumeAction(key, 2, 60)).toBe(true);
    expect(await store.consumeAction(key, 2, 60)).toBe(false);
    expect(await store.consumeAction(jti, 1, 60)).toBe(true);
  });

  it("does not increment the action count when requireTask is missing", async () => {
    const token = await issue(principal, agent);
    const store = memoryStore();
    const skipped = await decide(await signed(token, agent.priv), { route: {}, store });
    expect(skipped).toMatchObject({ decision: "allow", actionConsumed: false });
    expect(code(await decide(await signed(token, agent.priv), { store }))).toBe("allow");
    expect(code(await decide(await signed(token, agent.priv), { store }))).toBe("LIMIT_EXCEEDED");
  });

  it("does not count actions when limits is missing, even if requireTask is set", async () => {
    const token = await issue(principal, agent, { limits: undefined });
    const inner = memoryStore();
    let consumes = 0;
    const store = {
      claimNonce: (nonce: string, ttlSec: number) => inner.claimNonce(nonce, ttlSec),
      consumeAction: async (jti: string, max: number, ttlSec: number) => {
        consumes += 1;
        return inner.consumeAction(jti, max, ttlSec);
      },
      refundAction: (jti: string) => inner.refundAction(jti),
      claimPersonSlot: (...args: Parameters<typeof inner.claimPersonSlot>) => inner.claimPersonSlot(...args),
    };
    const first = await decide(await signed(token, agent.priv), { store });
    const second = await decide(await signed(token, agent.priv), { store });
    expect(first).toMatchObject({ decision: "allow", actionConsumed: false });
    expect(second).toMatchObject({ decision: "allow", actionConsumed: false });
    expect(consumes).toBe(0);
  });

  it("is a challenge when the mandate is missing", async () => {
    expect(await decide(new Request("https://court.example/reserve"))).toEqual({ decision: "challenge", code: "NO_MANDATE" });
  });

  it("is deny when the mandate is missing and onNoMandate is deny", async () => {
    const decision = await decide(new Request("https://court.example/reserve"), { config: { onNoMandate: "deny" } });
    expect(decision).toEqual({ decision: "deny", code: "NO_MANDATE" });
  });

  it("an empty header, a broken mandate, and a different vct are MANDATE_MALFORMED", async () => {
    const empty = new Request("https://court.example/reserve", { headers: { "agent-mandate": "" } });
    expect(code(await decide(empty))).toBe("MANDATE_MALFORMED");
    const garbage = new Request("https://court.example/reserve", { headers: { "agent-mandate": "nope" } });
    expect(code(await decide(garbage))).toBe("MANDATE_MALFORMED");
    const token = await issue(principal, agent);
    const [h, p, s] = token.split("~")[0]!.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as { vct: string };
    claims.vct = "urn:other";
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}~`;
    expect(code(await decide(await signedUnchecked(forged, agent.priv)))).toBe("MANDATE_MALFORMED");
  });

  it("a tampered mandate is MANDATE_SIG_INVALID", async () => {
    const token = await issue(principal, agent);
    const [h, p, s] = token.split("~")[0]!.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as { task: { resource: string } };
    claims.task.resource = "court-4";
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}~`;
    expect(code(await decide(await signedUnchecked(forged, agent.priv)))).toBe("MANDATE_SIG_INVALID");
  });

  it("is ISSUER_NOT_TRUSTED when the issuer is not in trustedIssuers", async () => {
    const token = await issue(principal, agent);
    const decision = await decide(await signed(token, agent.priv), { config: { trustedIssuers: ["urn:jwk-thumbprint:sha-256:nope"] } });
    expect(code(decision)).toBe("ISSUER_NOT_TRUSTED");
  });

  it("a mandate for another site is AUD_MISMATCH", async () => {
    const token = await issue(principal, agent, { audience: "https://other.example" });
    expect(code(await decide(await signedUnchecked(token, agent.priv)))).toBe("AUD_MISMATCH");
  });

  it("is AUD_MISMATCH when the request host differs from the origin host", async () => {
    const token = await issue(principal, agent);
    const req = await signedUnchecked(token, agent.priv, NOW, "https://evil.example/reserve");
    expect(code(await decide(req))).toBe("AUD_MISMATCH");
  });

  it("is MANDATE_MALFORMED when sub differs from iss or the time order is reversed", async () => {
    const token = await issue(principal, agent);
    const otherSub = rewriteClaims(token, (claims) => {
      claims.sub = "urn:jwk-thumbprint:sha-256:someone-else";
    });
    expect(code(await decide(await signedUnchecked(otherSub, agent.priv)))).toBe("MANDATE_MALFORMED");
    const lateStart = rewriteClaims(token, (claims) => {
      claims.nbf = Number(claims.exp) + 1;
    });
    expect(code(await decide(await signedUnchecked(lateStart, agent.priv)))).toBe("MANDATE_MALFORMED");
    const lateIssue = rewriteClaims(token, (claims) => {
      claims.iat = Number(claims.exp) + 1;
    });
    expect(code(await decide(await signedUnchecked(lateIssue, agent.priv)))).toBe("MANDATE_MALFORMED");
  });

  it("distinguishes not yet valid, expired, and a lifetime that is too long", async () => {
    const early = await issue(principal, agent, { notBefore: new Date(NOW_MS + 600_000) });
    expect(code(await decide(await signed(early, agent.priv)))).toBe("NOT_YET_VALID");
    const short = await issue(principal, agent, { durationSec: 60 });
    const later = new Date(NOW_MS + 120_000);
    expect(code(await decide(await signed(short, agent.priv), { now: later }))).toBe("EXPIRED");
    const long = await issue(principal, agent, { durationSec: 120 });
    expect(code(await decide(await signed(long, agent.priv), { config: { maxLifetimeSec: 60 } }))).toBe("LIFETIME_TOO_LONG");
  });

  it("is SIG_MISSING when the signature is absent, and SIG_INVALID when only one side is present", async () => {
    const token = await issue(principal, agent);
    const missing = new Request("https://court.example/reserve", { headers: { "agent-mandate": token } });
    expect(code(await decide(missing))).toBe("SIG_MISSING");
    const signedReq = await signed(token, agent.priv);
    const headers = new Headers(signedReq.headers);
    headers.delete("signature");
    const one = new Request(signedReq, { headers });
    expect(code(await decide(one))).toBe("SIG_INVALID");
  });

  it("is KEY_MISMATCH when signed with a different key", async () => {
    const token = await issue(principal, agent);
    expect(code(await decide(await signed(token, thief.priv)))).toBe("KEY_MISMATCH");
    const store = memoryStore();
    await decide(await signed(token, thief.priv), { store });
    expect(await store.consumeAction(String(decodeMandateUnverified(token)?.payload[CLAIM.jti]), 1, 60)).toBe(true);
  });

  it("is SIG_INVALID when the signature is broken or too old", async () => {
    const token = await issue(principal, agent);
    const req = await signed(token, agent.priv);
    const headers = new Headers(req.headers);
    const value = headers.get("signature") ?? "";
    headers.set("signature", value.slice(0, -2) + (value.at(-2) === "A" ? "B" : "A") + value.slice(-1));
    expect(code(await decide(new Request(req, { headers })))).toBe("SIG_INVALID");
    const old = new Date(NOW_MS - 600_000);
    expect(code(await decide(await signed(token, agent.priv, old)))).toBe("SIG_INVALID");
  });

  it("the same nonce is REPLAY, and going over the count is LIMIT_EXCEEDED", async () => {
    const replayStore = memoryStore();
    const replayToken = await issue(principal, agent, { limits: { maxActions: 5 } });
    const replayReq = await signed(replayToken, agent.priv);
    expect(code(await decide(replayReq.clone(), { store: replayStore }))).toBe("allow");
    expect(code(await decide(replayReq, { store: replayStore }))).toBe("REPLAY");

    const limitStore = memoryStore();
    const limitToken = await issue(principal, agent, { limits: { maxActions: 1 } });
    expect(code(await decide(await signed(limitToken, agent.priv), { store: limitStore }))).toBe("allow");
    expect(code(await decide(await signed(limitToken, agent.priv), { store: limitStore }))).toBe("LIMIT_EXCEEDED");
  });

  it("a different task type or resource is TASK_NOT_ALLOWED, and the nonce is recorded before that", async () => {
    const wrongType = await issue(principal, agent, { task: { type: "lookup", resource: "court-3" } });
    expect(code(await decide(await signed(wrongType, agent.priv)))).toBe("TASK_NOT_ALLOWED");
    const token = await issue(principal, agent);
    const route = { requireTask: { type: "reserve", resource: "court-4" } };
    expect(code(await decide(await signed(token, agent.priv), { route }))).toBe("TASK_NOT_ALLOWED");

    const store = memoryStore();
    const req = await signed(wrongType, agent.priv);
    expect(code(await decide(req.clone(), { store }))).toBe("TASK_NOT_ALLOWED");
    expect(code(await decide(req, { store }))).toBe("REPLAY");
    expect(await store.consumeAction(String(decodeMandateUnverified(wrongType)?.payload[CLAIM.jti]), 1, 60)).toBe(true);
  });

  it("does not issue when maxActions is below 1, and a mandate that has it is MANDATE_MALFORMED at the format step", async () => {
    await expect(issue(principal, agent, { limits: { maxActions: 0 } })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    const token = await issue(principal, agent);
    for (const maxActions of [0, -1]) {
      const forged = rewriteClaims(token, (claims) => {
        claims.limits = { maxActions };
      });
      expect(code(await decide(await signedUnchecked(forged, agent.priv)))).toBe("MANDATE_MALFORMED");
    }
  });

  it("the same tid shares the action count even when the mandate id differs", async () => {
    const store = memoryStore();
    const first = await issue(principal, agent, { taskId: "task-1", limits: { maxActions: 1 } });
    const second = await issue(principal, agent, { taskId: "task-1", limits: { maxActions: 1 } });
    const allowed = await decide(await signed(first, agent.priv), { store });
    expect(decodeMandateUnverified(first)?.payload[CLAIM.tid]).toBe("task-1");
    expect(decodeMandateUnverified(first)?.payload[CLAIM.jti]).not.toBe(decodeMandateUnverified(second)?.payload[CLAIM.jti]);
    expect(allowed).toMatchObject({ decision: "allow", taskId: "task-1" });
    expect(code(await decide(await signed(second, agent.priv), { store }))).toBe("LIMIT_EXCEEDED");

    const plain = await issue(principal, agent, { limits: { maxActions: 1 } });
    expect(decodeMandateUnverified(plain)?.payload[CLAIM.tid]).toBeUndefined();
    const plainDecision = await decide(await signed(plain, agent.priv));
    expect(plainDecision).toMatchObject({ decision: "allow", taskId: decodeMandateUnverified(plain)?.payload[CLAIM.jti] });
    await expect(issue(principal, agent, { taskId: "" })).rejects.toThrow(/taskId/);
  });

  it("the action key separates issuer, audience, and task id, so the same id does not mix", async () => {
    const store = memoryStore();
    const mine = await issue(principal, agent, { taskId: "shared", limits: { maxActions: 1 } });
    const theirs = await issue(thief, agent, { taskId: "shared", limits: { maxActions: 1 } });
    expect(code(await decide(await signed(mine, agent.priv), { store }))).toBe("allow");
    expect(code(await decide(await signed(theirs, agent.priv), { store }))).toBe("allow");

    const other = "https://other.example";
    const abroad = await issue(principal, agent, { taskId: "shared", audience: other, limits: { maxActions: 1 } });
    const req = await signRequest(new Request(`${other}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility: "court-3" }) }), { mandate: abroad, agentKey: agent.priv, now: NOW });
    expect(code(await verifyRequest(req, { origin: other }, { requireTask: { type: "reserve" } }, store, NOW))).toBe("allow");
  });

  it("does not issue when taskEnd is earlier than the chunk, and a tend earlier than exp is a bad mandate", async () => {
    await expect(issue(principal, agent, { taskEnd: new Date(NOW.getTime() + 1799 * 1000) })).rejects.toThrow(/taskEnd/);
    const same = await issue(principal, agent, { taskEnd: new Date(NOW.getTime() + 1800 * 1000) });
    const exp = Math.floor(NOW.getTime() / 1000) + 1800;
    expect(decodeMandateUnverified(same)?.payload[CLAIM.tend]).toBe(exp);
    const later = await issue(principal, agent, { taskId: "long", limits: { maxActions: 1 }, durationSec: 600, taskEnd: new Date(NOW.getTime() + 3 * 86_400 * 1000) });
    expect(decodeMandateUnverified(later)?.payload[CLAIM.tend]).toBe(Math.floor(NOW.getTime() / 1000) + 3 * 86_400);

    const early = rewriteClaims(later, (claims) => {
      claims[CLAIM.tend] = (claims[CLAIM.exp] as number) - 1;
    });
    expect(code(await decide(await signedUnchecked(early, agent.priv)))).toBe("MANDATE_MALFORMED");
    const fractional = rewriteClaims(same, (claims) => {
      claims[CLAIM.tend] = 1.5;
    });
    expect(code(await decide(await signedUnchecked(fractional, agent.priv)))).toBe("MANDATE_MALFORMED");

    let nowMs = NOW.getTime();
    const store = memoryStore({ now: () => new Date(nowMs) });
    expect(code(await decide(await signed(later, agent.priv), { store, now: new Date(nowMs) }))).toBe("allow");
    nowMs = NOW.getTime() + 2 * 86_400 * 1000;
    const next = await issue(principal, agent, { taskId: "long", limits: { maxActions: 1 }, durationSec: 600, notBefore: new Date(nowMs), now: new Date(nowMs), taskEnd: new Date(NOW.getTime() + 3 * 86_400 * 1000) });
    expect(code(await decide(await signed(next, agent.priv, new Date(nowMs)), { store, now: new Date(nowMs) }))).toBe("LIMIT_EXCEEDED");
  });

  it("an empty or non-numeric tid is a bad mandate", async () => {
    const token = await issue(principal, agent);
    expect(
      code(
        await decide(
          await signedUnchecked(
            rewriteClaims(token, (claims) => {
              claims[CLAIM.tid] = "";
            }),
            agent.priv,
          ),
        ),
      ),
    ).toBe("MANDATE_MALFORMED");
    expect(
      code(
        await decide(
          await signedUnchecked(
            rewriteClaims(token, (claims) => {
              claims[CLAIM.tid] = 1;
            }),
            agent.priv,
          ),
        ),
      ),
    ).toBe("MANDATE_MALFORMED");
  });

  it("under onePerPerson, a bad signature with only tid is MANDATE_MALFORMED", async () => {
    const token = await issue(principal, agent, { taskId: "task-1" });
    const config = { requirePerson: true, onePerPerson: true, personIssuers: [{ iss: "https://idp.example", jwks: [principal.pub] }] };
    expect(decodeMandateUnverified(token)?.payload[CLAIM.tid]).toBe("task-1");
    expect(decodeMandateUnverified(token)?.payload[CLAIM.tbeg]).toBeUndefined();
    expect(code(await decide(await signed(token, agent.priv), { config }))).toBe("MANDATE_MALFORMED");
    const forged = rewriteClaims(token, (claims) => {
      const task = claims[CLAIM.task];
      if (!task || typeof task !== "object") throw new Error("task is missing");
      (task as { resource: string }).resource = "court-9";
      delete claims[CLAIM.tbeg];
    });
    expect(decodeMandateUnverified(forged)?.payload[CLAIM.tid]).toBe("task-1");
    expect(decodeMandateUnverified(forged)?.payload[CLAIM.tbeg]).toBeUndefined();
    expect(code(await decide(await signedUnchecked(forged, agent.priv), { config }))).toBe("MANDATE_MALFORMED");
    expect(code(await decide(await signedUnchecked(forged, agent.priv)))).toBe("MANDATE_SIG_INVALID");
  });
});

const NOW_MS = Date.parse("2026-12-01T00:00:00Z");

function rewriteClaims(token: string, edit: (claims: Record<string, unknown>) => void): string {
  const [header, payload, signature] = token.split("~")[0]!.split(".");
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown>;
  edit(claims);
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}~`;
}
