import { decodeJwt, Jwt, uint8ArrayToBase64Url } from "@sd-jwt/core";
import { assertOrigin } from "./config.js";
import { TaskMandateError } from "./error.js";
import { importPrivateKey, importPublicKey, normalizePublicJwk, thumbprint } from "./jwk.js";
import { CLAIM, ISSUER_PREFIX, JOSE, PERSON } from "./profile.js";
import type { PersonIssuer } from "./types.js";
import { ED25519, isRecord, unixSeconds, verifyEd25519 } from "./util.js";

export interface PersonSubject {
  iss: string;
  sub: string;
}

export interface AttestInput {
  idpKey: JsonWebKey;
  idpIssuer: string;
  secret: string;
  personId: string;
  audience: string;
  principalPublicKey: JsonWebKey;
  durationSec: number;
  now?: Date;
}

interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function decodePerson(token: string): DecodedJwt | undefined {
  try {
    const decoded = decodeJwt<Record<string, unknown>, Record<string, unknown>>(token);
    if (!isRecord(decoded.header) || !isRecord(decoded.payload)) return undefined;
    return { header: decoded.header, payload: decoded.payload };
  } catch {
    return undefined;
  }
}

/** Pairwise subject id for one person, site, and issuer secret. */
export async function pairwiseId(secret: string, personId: string, audience: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${personId}\u0000${audience}`));
  return uint8ArrayToBase64Url(new Uint8Array(mac));
}

export function readAttestationClaims(token: string): { sub: string; exp: number } {
  const decoded = decodePerson(token.trim());
  const sub = text(decoded?.payload[CLAIM.sub]);
  const exp = decoded?.payload[CLAIM.exp];
  if (!decoded || !sub || typeof exp !== "number" || !Number.isInteger(exp)) {
    throw new TaskMandateError("INPUT_INVALID", "could not read the person attestation");
  }
  return { sub, exp };
}

/** Issue a person-attestation JWT. */
export async function issuePersonAttestation(input: AttestInput): Promise<string> {
  assertOrigin(input.audience, "INPUT_INVALID");
  if (typeof input.idpIssuer !== "string" || input.idpIssuer === "") throw new TaskMandateError("INPUT_INVALID", "idpIssuer is missing");
  if (!Number.isFinite(input.durationSec) || input.durationSec < 0) throw new TaskMandateError("INPUT_INVALID", "durationSec is invalid");
  const now = input.now ?? new Date();
  const iat = unixSeconds(now);
  const privateKey = await importPrivateKey(input.idpKey);
  const kid = await thumbprint(input.idpKey);
  const jwt = new Jwt<Record<string, unknown>, Record<string, unknown>>();
  jwt.setHeader({ [JOSE.typ]: PERSON.typ, [JOSE.alg]: JOSE.algValue, [JOSE.kid]: kid });
  jwt.setPayload({ [CLAIM.iss]: input.idpIssuer, [CLAIM.sub]: await pairwiseId(input.secret, input.personId, input.audience), [CLAIM.aud]: input.audience, [CLAIM.cnf]: { [CLAIM.jwk]: normalizePublicJwk(input.principalPublicKey) }, [CLAIM.iat]: iat, [CLAIM.exp]: iat + Math.floor(input.durationSec) });
  return jwt.sign(async (data) => {
    const signature = await crypto.subtle.sign(ED25519, privateKey, new TextEncoder().encode(data));
    return uint8ArrayToBase64Url(new Uint8Array(signature));
  });
}

function issuerKeys(issuers: readonly PersonIssuer[], iss: string): readonly JsonWebKey[] {
  const keys: JsonWebKey[] = [];
  for (const issuer of issuers) {
    if (issuer.iss === iss && Array.isArray(issuer.jwks)) keys.push(...issuer.jwks);
  }
  return keys;
}

async function keyForKid(keys: readonly JsonWebKey[], kid: string): Promise<JsonWebKey | undefined> {
  for (const jwk of keys) {
    try {
      const pub = normalizePublicJwk(jwk);
      if ((await thumbprint(pub)) === kid) return pub;
    } catch {}
  }
  return undefined;
}

export async function verifyPersonAttestation(token: string, input: { origin: string; nowSec: number; clockSkewSec: number; issuers: readonly PersonIssuer[]; mandateIss: string; mandateSub: string; mandateExp: number }): Promise<{ ok: true; person: PersonSubject } | { ok: false }> {
  const fail = { ok: false } as const;
  const decoded = decodePerson(token);
  if (!decoded) return fail;
  const { header, payload } = decoded;
  if (header[JOSE.typ] !== PERSON.typ || header[JOSE.alg] !== JOSE.algValue) return fail;
  const iss = text(payload[CLAIM.iss]);
  const sub = text(payload[CLAIM.sub]);
  const aud = payload[CLAIM.aud];
  const iat = payload[CLAIM.iat];
  const exp = payload[CLAIM.exp];
  const kid = text(header[JOSE.kid]);
  if (!iss || !sub || typeof aud !== "string" || !Number.isInteger(iat) || !Number.isInteger(exp) || !kid) return fail;
  if ((iat as number) > (exp as number)) return fail;
  const key = await keyForKid(issuerKeys(input.issuers, iss), kid);
  if (!key) return fail;
  try {
    const cryptoKey = await importPublicKey(key);
    await Jwt.fromEncode(token).verify(verifyEd25519(cryptoKey), { skipJwtClaimValidation: true, allowedIssuerAlgorithms: [JOSE.algValue] });
  } catch {
    return fail;
  }
  if (aud !== input.origin) return fail;
  if (input.nowSec > (exp as number) + input.clockSkewSec || input.nowSec < (iat as number) - input.clockSkewSec) return fail;
  const cnf = payload[CLAIM.cnf];
  const jwk = isRecord(cnf) ? cnf[CLAIM.jwk] : undefined;
  if (!isRecord(jwk)) return fail;
  try {
    const bound = `${ISSUER_PREFIX}${await thumbprint(jwk as JsonWebKey)}`;
    if (bound !== input.mandateIss) return fail;
  } catch {
    return fail;
  }
  if (input.mandateSub !== sub) return fail;
  if ((exp as number) < input.mandateExp) return fail;
  return { ok: true, person: { iss, sub } };
}
