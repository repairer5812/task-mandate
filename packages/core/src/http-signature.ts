import { parseDictionary } from "structured-headers";
import { validateNonce, verify } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";
import { readChunksWithin } from "./body-read.js";
import { contentDigest, signatureComponents } from "./digest.js";
import { normalizePublicJwk } from "./jwk.js";
import { COMPONENT, SIGNATURE_MAX_AGE_SEC, SIGNATURE_TAG } from "./profile.js";
import type { ReasonCode } from "./types.js";

export type SignatureCheck = { ok: true; nonce: string; expiresSec: number } | { ok: false; code: Extract<ReasonCode, "SIG_MISSING" | "KEY_MISMATCH" | "SIG_INVALID" | "BODY_TOO_LARGE"> };

function invalid(): SignatureCheck {
  return { ok: false, code: "SIG_INVALID" };
}

function bareString(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "object" && value !== null && "toString" in value) {
    const text = value.toString();
    if (text && !text.startsWith("[object ")) return text;
  }
  return undefined;
}

// Library verify checks expiry and components before keyid. Read keyid first so a mismatch stays KEY_MISMATCH.
function readKeyId(signatureInput: string): string | undefined {
  const dictionary = parseDictionary(signatureInput);
  if (dictionary.size !== 1) return undefined;
  const member = dictionary.values().next().value;
  if (!member || !Array.isArray(member[0]) || !(member[1] instanceof Map)) return undefined;
  return bareString(member[1].get("keyid"));
}

function coversBare(components: readonly { name: string; parameters: object }[], name: string): boolean {
  return components.some((component) => component.name === name && Object.keys(component.parameters).length === 0);
}

export function declaredBodyLength(request: Request): number | undefined {
  const header = request.headers.get("content-length");
  if (header === null) return undefined;
  const text = header.trim();
  if (!/^\d+$/.test(text)) return Number.POSITIVE_INFINITY;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY;
}

// Skip the body when Content-Length is over the cap. Otherwise stop at the cap.
async function readBodyWithin(request: Request, maxBodyBytes: number): Promise<Uint8Array | undefined> {
  const declared = declaredBodyLength(request);
  if (declared !== undefined && declared > maxBodyBytes) return undefined;
  const stream = request.clone().body;
  if (!stream) return new Uint8Array();
  return readChunksWithin(stream.getReader(), maxBodyBytes);
}

export async function checkHttpSignature(request: Request, agentPublic: JsonWebKey, agentKeyId: string, now: Date, clockSkewSec: number, maxBodyBytes: number): Promise<SignatureCheck> {
  const signature = request.headers.get("signature");
  const signatureInput = request.headers.get("signature-input");
  if (signature === null && signatureInput === null) return { ok: false, code: "SIG_MISSING" };
  if (signature === null || signatureInput === null) return invalid();

  let keyid: string | undefined;
  try {
    keyid = readKeyId(signatureInput);
  } catch {
    return invalid();
  }
  if (!keyid) return invalid();
  if (keyid !== agentKeyId) return { ok: false, code: "KEY_MISMATCH" };

  try {
    const verifier = await verifierFromJWK(normalizePublicJwk(agentPublic));
    const verified = await verify(request, { resolver: () => verifier, now, maxAge: SIGNATURE_MAX_AGE_SEC, clockSkew: clockSkewSec });
    if (verified.tag !== SIGNATURE_TAG) return invalid();
    const hasBody = request.body !== null;
    const required = signatureComponents(hasBody);
    if (!required.every((name) => coversBare(verified.components, name))) return invalid();
    if (hasBody) {
      const body = await readBodyWithin(request, maxBodyBytes);
      if (!body) return { ok: false, code: "BODY_TOO_LARGE" };
      const actual = request.headers.get(COMPONENT.contentDigest);
      const expected = await contentDigest(body);
      if (actual !== expected) return invalid();
    }
    const windowSec = (verified.expires.getTime() - verified.created.getTime()) / 1000;
    if (!Number.isFinite(windowSec) || windowSec > SIGNATURE_MAX_AGE_SEC) return invalid();
    const nonce = verified.nonce;
    if (!validateNonce(nonce)) return invalid();
    return { ok: true, nonce, expiresSec: Math.floor(verified.expires.getTime() / 1000) };
  } catch {
    return invalid();
  }
}
