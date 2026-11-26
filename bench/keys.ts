export interface KeyPair {
  priv: JsonWebKey;
  pub: JsonWebKey;
}

export async function ed25519(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", pair.privateKey), pub: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

export function pubOnly(key: JsonWebKey): JsonWebKey {
  return { kty: key.kty, crv: key.crv, x: key.x };
}
