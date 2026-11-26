import { mandatedFetch } from "@task-mandate/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519, issue, type KeyPair, NOW, SITE } from "../../core/test/helpers.js";

let principal: KeyPair;
let agent: KeyPair;

beforeEach(async () => {
  principal = await ed25519();
  agent = await ed25519();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mandatedFetch", () => {
  it("does not call fetch for a site with a different aud", async () => {
    const token = await issue(principal, agent);
    const fake = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fake);
    await expect(mandatedFetch("https://evil.example/reserve", { method: "POST" }, { mandate: token, agentKey: agent.priv, now: NOW })).rejects.toThrow();
    expect(fake).not.toHaveBeenCalled();
  });

  it("sends the same site with redirect manual and keeps the body", async () => {
    const token = await issue(principal, agent);
    const body = JSON.stringify({ facility: "court-3" });
    const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return new Response(await request.text());
    });
    vi.stubGlobal("fetch", fake);
    const res = await mandatedFetch(`${SITE}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body }, { mandate: token, agentKey: agent.priv, now: NOW });
    expect(fake).toHaveBeenCalledTimes(1);
    const sent = fake.mock.calls[0] as unknown[];
    const redirect = sent[0] instanceof Request ? sent[0].redirect : (sent[1] as RequestInit | undefined)?.redirect;
    expect(redirect).toBe("manual");
    expect(await res.text()).toBe(body);
  });

  it("calls the mandate supplier once per request", async () => {
    const token = await issue(principal, agent);
    const provider = vi.fn(async () => token);
    const fake = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fake);
    await mandatedFetch(`${SITE}/slots`, undefined, { mandate: provider, agentKey: agent.priv, now: NOW });
    expect(provider).toHaveBeenCalledTimes(1);
    const sent = (fake.mock.calls[0] as unknown[])[0] as Request;
    expect(sent.headers.get("agent-mandate")).toBe(token);
  });
});
