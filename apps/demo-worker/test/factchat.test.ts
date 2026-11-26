import { describe, expect, it } from "vitest";
import { FACTCHAT_MODEL, FACTCHAT_TIMEOUT_MS, FACTCHAT_URL, interpretWithFactChat, readFactChatBody } from "../src/factchat";

describe("FactChat response", () => {
  it("extracts only the JSON object from the response body", () => {
    const body = JSON.stringify({ choices: [{ message: { content: '앞말 {"service":"basic-pension","durationSec":600,"maxActions":2} 뒷말' } }] });
    expect(readFactChatBody(body)).toEqual({ service: "basic-pension", durationSec: 600, maxActions: 2 });
  });

  it("throws when there is no object", () => {
    expect(() => readFactChatBody("안녕")).toThrow(/JSON/);
  });

  it("checks the model, key, and time limit with a fake fetch", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"service":"resident-copy","durationSec":60,"maxActions":1}' } }] }), { status: 200 });
    }) as typeof fetch;
    const result = await interpretWithFactChat("등본", "test-key", fetchImpl);
    expect(result).toEqual({ service: "resident-copy", durationSec: 60, maxActions: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(FACTCHAT_URL);
    expect(FACTCHAT_TIMEOUT_MS).toBe(15000);
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    const payload = JSON.parse(String(calls[0]?.init.body)) as { model: string; messages: { role: string; content: string }[] };
    expect(payload.model).toBe(FACTCHAT_MODEL);
    expect(payload.messages[0]?.content).toContain("basic-pension");
    expect(payload.messages[0]?.content).toContain("resident-copy");
    expect(payload.messages[0]?.content).toContain("disability-taxi");
    expect(payload.messages[1]?.content).toBe("등본");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("Workers compatibility", () => {
  it("fetch redirect is the value Workers accepts (manual), and a 3xx is a failure", async () => {
    let seen: RequestInit | undefined;
    const ok = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"service":"basic-pension"}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await interpretWithFactChat("기초연금", "k", ok);
    expect(seen?.redirect).toBe("manual");
    const moved = (async () => new Response(null, { status: 302, headers: { location: "https://example.com" } })) as unknown as typeof fetch;
    await expect(interpretWithFactChat("기초연금", "k", moved)).rejects.toThrow();
  });
});
