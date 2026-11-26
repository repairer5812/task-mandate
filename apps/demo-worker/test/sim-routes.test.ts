import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function call(input: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(input, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function publicKey(): Promise<JsonWebKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return crypto.subtle.exportKey("jwk", pair.publicKey);
}

describe("sim routes", () => {
  it("interprets with rules when the key is missing", async () => {
    const response = await call("http://127.0.0.1:8787/sim/interpret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "기초연금 신청해 줘" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await response.json()).toMatchObject({ source: "rule", service: "basic-pension", title: "기초연금 신청(모의)", durationSec: 3600, maxActions: 1 });
  });

  it("mock identity check is 503 when the issuer key is missing", async () => {
    const response = await call("http://127.0.0.1:8787/sim/attest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ principalPublicKey: await publicKey() }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });

  it("GET and HEAD /sim return the simulation page with 200", async () => {
    const page = await call("http://127.0.0.1:8787/sim");
    expect(page.status).toBe(200);
    expect(page.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await page.text()).toContain("음성 위임 시뮬레이션");
    const head = await call("http://127.0.0.1:8787/sim", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
});
