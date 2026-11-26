import { base64UrlToUint8Array } from "@sd-jwt/core";

/** WebCrypto algorithm name for Ed25519. */
export const ED25519: Algorithm = { name: "Ed25519" };

/** Plain object, not an array or null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unix time in whole seconds. */
export function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** Verifier callback for the SD-JWT library. Ed25519 checks go through this function only. */
export function verifyEd25519(key: CryptoKey): (data: string, signature: string) => Promise<boolean> {
  return (data, signature) => crypto.subtle.verify(ED25519, key, Uint8Array.from(base64UrlToUint8Array(signature)), new TextEncoder().encode(data));
}
