import { SIGNATURE_MAX_AGE_SEC, TaskMandateError } from "@task-mandate/core";
import { COMPONENT, signatureComponents } from "@task-mandate/core/internal";
import { mandatedFetch, signRequest } from "@task-mandate/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signComponents } from "../../agent/src/sign.js";
import { code, decide, ed25519, issue, type KeyPair, NOW, reserveRequest, SITE, signed } from "./helpers.js";

let principal: KeyPair;
let agent: KeyPair;

beforeEach(async () => {
  principal = await ed25519();
  agent = await ed25519();
});

describe("boundaries", () => {
  it("equal to nbf minus skew is allowed, and 1 second earlier is NOT_YET_VALID", async () => {
    const notBefore = new Date(NOW.getTime() + 600_000);
    const token = await issue(principal, agent, { notBefore, durationSec: 1800 });
    const nbf = Math.floor(notBefore.getTime() / 1000);
    const edge = new Date((nbf - 30) * 1000);
    const before = new Date((nbf - 30 - 1) * 1000);
    expect(code(await decide(await signed(token, agent.priv, edge), { now: edge }))).toBe("allow");
    expect(code(await decide(await signed(token, agent.priv, before), { now: before }))).toBe("NOT_YET_VALID");
  });

  it("equal to exp plus skew is EXPIRED, and mandatedFetch does not send from that second", async () => {
    const token = await issue(principal, agent, { durationSec: 1800 });
    const exp = Math.floor(NOW.getTime() / 1000) + 1800;
    const edge = new Date((exp + 30) * 1000);
    const before = new Date((exp + 29) * 1000);
    const after = new Date((exp + 30 + 1) * 1000);
    expect(code(await decide(await signed(token, agent.priv, edge), { now: edge }))).toBe("EXPIRED");
    expect((await signed(token, agent.priv, after)).headers.get("signature")).toBeTruthy();
    const fake = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fake);
    try {
      await expect(mandatedFetch(`${SITE}/reserve`, { method: "POST", body: "{}" }, { mandate: token, agentKey: agent.priv, now: edge })).rejects.toBeInstanceOf(TaskMandateError);
      expect(fake).not.toHaveBeenCalled();
      await mandatedFetch(`${SITE}/reserve`, { method: "POST", body: "{}" }, { mandate: token, agentKey: agent.priv, now: before });
      expect(fake).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is allowed when exp minus nbf equals the maximum lifetime", async () => {
    const token = await issue(principal, agent, { durationSec: 60 });
    expect(code(await decide(await signed(token, agent.priv), { config: { maxLifetimeSec: 60 } }))).toBe("allow");
    expect(code(await decide(await signed(token, agent.priv), { config: { maxLifetimeSec: 59 } }))).toBe("LIFETIME_TOO_LONG");
  });

  it("is SIG_INVALID when the signature window is over 5 minutes, a required component is missing, or nonce is missing", async () => {
    const token = await issue(principal, agent);
    const covered = signatureComponents(true);
    const long = await signComponents(reserveRequest(), { mandate: token, agentKey: agent.priv, created: NOW, expires: new Date(NOW.getTime() + (SIGNATURE_MAX_AGE_SEC + 1) * 1000), components: covered });
    expect(code(await decide(long))).toBe("SIG_INVALID");
    for (const name of covered) {
      const missing = await signComponents(reserveRequest(), { mandate: token, agentKey: agent.priv, created: NOW, expires: new Date(NOW.getTime() + SIGNATURE_MAX_AGE_SEC * 1000), components: covered.filter((item) => item !== name) });
      expect(code(await decide(missing))).toBe("SIG_INVALID");
    }
    const targetOnly = await signComponents(reserveRequest(), { mandate: token, agentKey: agent.priv, created: NOW, expires: new Date(NOW.getTime() + SIGNATURE_MAX_AGE_SEC * 1000), components: ["@target-uri", COMPONENT.mandate] });
    expect(code(await decide(targetOnly))).toBe("SIG_INVALID");
    const noNonce = await signComponents(reserveRequest(), { mandate: token, agentKey: agent.priv, created: NOW, expires: new Date(NOW.getTime() + SIGNATURE_MAX_AGE_SEC * 1000), components: covered, nonce: null });
    expect(code(await decide(noNonce))).toBe("SIG_INVALID");
  });

  it("is SIG_INVALID when a body has no content-digest or the digest does not match the body", async () => {
    const token = await issue(principal, agent);
    const missing = await signComponents(reserveRequest(), { mandate: token, agentKey: agent.priv, created: NOW, expires: new Date(NOW.getTime() + SIGNATURE_MAX_AGE_SEC * 1000), components: signatureComponents(false) });
    expect(missing.headers.get(COMPONENT.contentDigest)).toBeNull();
    expect(code(await decide(missing))).toBe("SIG_INVALID");

    const req = await signed(token, agent.priv);
    expect(req.headers.get(COMPONENT.contentDigest)).toMatch(/^sha-256=:[A-Za-z0-9+/]+=:$/);
    const input = req.headers.get("signature-input") ?? "";
    for (const name of signatureComponents(true)) expect(input).toContain(`"${name}"`);
    const tampered = new Request(req.url, { method: req.method, headers: req.headers, body: JSON.stringify({ facility: "court-3", note: "x" }) });
    expect(code(await decide(tampered))).toBe("SIG_INVALID");
    expect(code(await decide(req))).toBe("allow");
    await expect(req.json()).resolves.toEqual({ facility: "court-3" });
  });

  it("a request with no body is allowed without content-digest", async () => {
    const token = await issue(principal, agent);
    const get = await signRequest(new Request(`${SITE}/slots`), { mandate: token, agentKey: agent.priv, now: NOW });
    expect(get.headers.get(COMPONENT.contentDigest)).toBeNull();
    expect(code(await decide(get, { route: {} }))).toBe("allow");
  });

  it("the request URL is the test site", () => {
    expect(SITE).toBe("https://court.example");
  });
});
