import { TaskMandateError } from "@task-mandate/core";
import { COMPONENT, signatureComponents } from "@task-mandate/core/internal";
import { describe, expect, it } from "vitest";
import { signComponents } from "../../agent/src/sign.js";
import { code, decide, ed25519, issue, type KeyPair, NOW, reserveRequest, SITE, signed, signedUnchecked } from "./helpers.js";

async function pair(): Promise<{ principal: KeyPair; agent: KeyPair; token: string }> {
  const principal = await ed25519();
  const agent = await ed25519();
  const token = await issue(principal, agent);
  return { principal, agent, token };
}

describe("check order", () => {
  it("returns only the first failing reason", async () => {
    const { agent, token } = await pair();
    const route = { requireTask: { type: "reserve", resource: "court-3" } };

    expect(code(await decide(new Request(`${SITE}/reserve`, { method: "POST" })))).toBe("NO_MANDATE");

    const early = new Request(`${SITE}/reserve`, { method: "POST", headers: { "agent-mandate": "garbage", "content-length": "99999" }, body: "{}" });
    expect(code(await decide(early, { config: { maxBodyBytes: 1024 } }))).toBe("BODY_TOO_LARGE");

    const garbage = new Request(`${SITE}/reserve`, { method: "POST", headers: { "agent-mandate": "not-a-mandate" } });
    expect(code(await decide(garbage))).toBe("MANDATE_MALFORMED");

    const jwtEnd = token.endsWith("~") ? token.length - 1 : token.length;
    const parts = token.slice(0, jwtEnd).split(".");
    const signature = parts[2] ?? "";
    // The last character is leftover base64url bits, so changing it can still let the signature pass.
    const flipAt = 0;
    const current = signature[flipAt] ?? "A";
    parts[2] = `${signature.slice(0, flipAt)}${current === "A" ? "B" : "A"}${signature.slice(flipAt + 1)}`;
    const broken = new Request(`${SITE}/reserve`, { method: "POST", headers: { "agent-mandate": `${parts.join(".")}${token.slice(jwtEnd)}` } });
    expect(code(await decide(broken))).toBe("MANDATE_SIG_INVALID");

    const trusted = await decide(await signed(token, agent.priv), { config: { trustedIssuers: ["https://other.example"] } });
    expect(code(trusted)).toBe("ISSUER_NOT_TRUSTED");

    const other = await issue(await ed25519(), agent, { audience: "https://other.example" });
    const abroad = await signedUnchecked(other, agent.priv);
    expect(code(await decide(abroad))).toBe("AUD_MISMATCH");

    const http = await signed(token, agent.priv);
    const switched = new Request(http.url.replace("https:", "http:"), http);
    expect(code(await decide(switched))).toBe("AUD_MISMATCH");

    const later = await issue(await ed25519(), agent, { notBefore: new Date(NOW.getTime() + 600_000) });
    expect(code(await decide(await signed(later, agent.priv)))).toBe("NOT_YET_VALID");

    const exp = Math.floor(NOW.getTime() / 1000) + 1800;
    const edge = new Date((exp + 30) * 1000);
    expect(code(await decide(await signed(token, agent.priv, edge), { now: edge }))).toBe("EXPIRED");

    const long = await issue(await ed25519(), agent, { durationSec: 120 });
    expect(code(await decide(await signed(long, agent.priv), { config: { maxLifetimeSec: 60 } }))).toBe("LIFETIME_TOO_LONG");

    const bare = new Request(`${SITE}/reserve`, { method: "POST", headers: { "agent-mandate": token } });
    expect(code(await decide(bare))).toBe("SIG_MISSING");

    const stranger = await ed25519();
    expect(code(await decide(await signed(token, stranger.priv)))).toBe("KEY_MISMATCH");

    const signedReq = await signed(token, agent.priv);
    const headers = new Headers(signedReq.headers);
    headers.delete("content-length");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(2048)));
        controller.close();
      },
    });
    const fat = new Request(signedReq.url, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
    expect(code(await decide(fat, { config: { maxBodyBytes: 1024 }, route }))).toBe("BODY_TOO_LARGE");

    const badSig = await signed(token, agent.priv);
    const sig = badSig.headers.get("signature") ?? "";
    const sigAt = Math.max(0, sig.indexOf("=:") + 2);
    const sigChar = sig[sigAt] ?? "A";
    badSig.headers.set("signature", `${sig.slice(0, sigAt)}${sigChar === "A" ? "B" : "A"}${sig.slice(sigAt + 1)}`);
    expect(code(await decide(badSig))).toBe("SIG_INVALID");

    const replay = await signed(token, agent.priv);
    const store = (await import("@task-mandate/core")).memoryStore({ now: () => NOW });
    expect(code(await decide(replay.clone(), { store, route }))).toBe("allow");
    expect(code(await decide(replay, { store, route }))).toBe("REPLAY");

    const wrong = await issue(await ed25519(), agent, { task: { type: "lookup" } });
    expect(code(await decide(await signed(wrong, agent.priv), { route }))).toBe("TASK_NOT_ALLOWED");

    const limited = await issue(await ed25519(), agent, { limits: { maxActions: 1 } });
    const limitedStore = (await import("@task-mandate/core")).memoryStore({ now: () => NOW });
    expect(code(await decide(await signed(limited, agent.priv), { store: limitedStore, route }))).toBe("allow");
    expect(code(await decide(await signed(limited, agent.priv), { store: limitedStore, route }))).toBe("LIMIT_EXCEEDED");
  });

  it("a signature for test vectors does not check the mandate", async () => {
    const { agent } = await pair();
    await expect(signComponents(reserveRequest(), { mandate: "not-a-mandate", agentKey: agent.priv, created: NOW, expires: new Date(NOW.getTime() + 60_000), components: signatureComponents(true).filter((name) => name !== COMPONENT.contentDigest) })).resolves.toBeInstanceOf(Request);
    expect(TaskMandateError).toBeTruthy();
  });
});
