import { readFile } from "node:fs/promises";
import { issuePersonAttestation, normalizePublicJwk, type PersonIssuer } from "@task-mandate/core";

export interface IdpFile {
  iss: string;
  secret: string;
  jwk: JsonWebKey;
}

function parseIdp(value: unknown): IdpFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an issuer key file");
  const record = value as Record<string, unknown>;
  const jwk = record.jwk;
  if (typeof record.iss !== "string" || record.iss === "") throw new Error("issuer key file has no iss");
  if (typeof record.secret !== "string" || record.secret === "") throw new Error("issuer key file has no secret");
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) throw new Error("not an issuer key file");
  return { iss: record.iss, secret: record.secret, jwk: jwk as JsonWebKey };
}

export async function readIdp(file: string): Promise<IdpFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(`${file} is not in the expected format`);
  }
  return parseIdp(parsed);
}

export function issuerOf(idp: IdpFile): PersonIssuer {
  return { iss: idp.iss, jwks: [normalizePublicJwk(idp.jwk)] };
}

export function attestFor(idp: IdpFile, input: { personId: string; audience: string; principalPublicKey: JsonWebKey; durationSec: number; now?: Date }): Promise<string> {
  return issuePersonAttestation({ idpKey: idp.jwk, idpIssuer: idp.iss, secret: idp.secret, personId: input.personId, audience: input.audience, principalPublicKey: input.principalPublicKey, durationSec: input.durationSec, now: input.now });
}
