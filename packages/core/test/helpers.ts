import { type Decision, issueMandate, memoryStore, type RoutePolicy, SIGNATURE_MAX_AGE_SEC, type Store, type VerifierConfig } from "@task-mandate/core";
import { signatureComponents, type VerifyResult, verifyRequest } from "@task-mandate/core/internal";
import { signRequest } from "@task-mandate/node";
import { signComponents } from "../../agent/src/sign.js";

export const SITE = "https://court.example";
export const NOW = new Date("2026-12-01T00:00:00Z");

export interface KeyPair {
  priv: JsonWebKey;
  pub: JsonWebKey;
}

export async function ed25519(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as { privateKey: CryptoKey; publicKey: CryptoKey };
  return { priv: await crypto.subtle.exportKey("jwk", pair.privateKey), pub: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

export async function issue(principal: KeyPair, agent: KeyPair, over: Partial<Parameters<typeof issueMandate>[0]> = {}): Promise<string> {
  return issueMandate({ principalKey: principal.priv, agentPublicKey: agent.pub, audience: SITE, task: { type: "reserve", resource: "court-3" }, limits: { maxActions: 1 }, durationSec: 1800, now: NOW, ...over });
}

export function reserveRequest(): Request {
  return new Request(`${SITE}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility: "court-3" }) });
}

export async function signed(token: string, key: JsonWebKey, at = NOW): Promise<Request> {
  return signRequest(reserveRequest(), { mandate: token, agentKey: key, now: at });
}

// Used to see how the server rejects a broken mandate. Like signRequest, it does not check the mandate.
export async function signedUnchecked(token: string, key: JsonWebKey, at = NOW, url = `${SITE}/reserve`): Promise<Request> {
  return signComponents(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility: "court-3" }) }), { mandate: token, agentKey: key, created: at, expires: new Date(at.getTime() + SIGNATURE_MAX_AGE_SEC * 1000), components: signatureComponents(true) });
}

export async function decide(request: Request, options: { config?: Partial<VerifierConfig>; route?: RoutePolicy; store?: Store; now?: Date } = {}): Promise<VerifyResult> {
  return verifyRequest(request, { origin: SITE, ...options.config }, options.route ?? { requireTask: { type: "reserve" } }, options.store ?? memoryStore(), options.now ?? NOW);
}

export function code(decision: Decision): string {
  return decision.decision === "allow" ? "allow" : decision.code;
}
