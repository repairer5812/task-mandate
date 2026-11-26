import { uint8ArrayToBase64Url } from "@sd-jwt/core";
import { verifierFromJWK } from "web-bot-auth/crypto";
import { TaskMandateError } from "./error.js";
import { ED25519 } from "./util.js";

function isEd25519(jwk: JsonWebKey): boolean {
  return jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string" && jwk.x !== "";
}

/** Public Ed25519 fields only. `alg` is omitted: Node sets `Ed25519`, and web-bot-auth accepts only `EdDSA` when `alg` is set. */
export function normalizePublicJwk(jwk: JsonWebKey): JsonWebKey {
  if (!isEd25519(jwk)) throw new TaskMandateError("KEY_INVALID", "public key must be an Ed25519 JWK");
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

/** Public fields plus `d`. `alg` is `EdDSA` because web-bot-auth rejects Node's `Ed25519` alg. */
export function normalizePrivateJwk(jwk: JsonWebKey): JsonWebKey {
  const pub = normalizePublicJwk(jwk);
  if (typeof jwk.d !== "string" || jwk.d === "") throw new TaskMandateError("KEY_INVALID", "private key must be an Ed25519 JWK");
  return { ...pub, d: jwk.d, alg: "EdDSA" };
}

/** SHA-256 JWK thumbprint. This is the agent key id. */
export async function thumbprint(jwk: JsonWebKey): Promise<string> {
  const verifier = await verifierFromJWK(normalizePublicJwk(jwk));
  return verifier.keyid;
}

export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return uint8ArrayToBase64Url(bytes);
}

export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", normalizePrivateJwk(jwk), ED25519, false, ["sign"]);
}

export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", normalizePublicJwk(jwk), ED25519, false, ["verify"]);
}
