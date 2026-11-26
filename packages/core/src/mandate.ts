import { decodeJwt, Jwt, splitSdJwt } from "@sd-jwt/core";
import { importPublicKey, normalizePublicJwk, thumbprint } from "./jwk.js";
import { LIMIT, utf8Size } from "./limits.js";
import { CLAIM, ISSUER_PREFIX, JOSE, PROFILE } from "./profile.js";
import type { Limits, ReasonCode, Task } from "./types.js";
import { isRecord, verifyEd25519 } from "./util.js";

/** Mandate fields after the signature and shape checks. */
export interface OpenedMandate {
  iss: string;
  sub: string;
  aud: string;
  agentPublic: JsonWebKey;
  agentKeyId: string;
  task: Task;
  limits?: Limits;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  tid?: string;
  tend?: number;
  tbeg?: number;
  pa?: string;
}

/** Opened mandate, or a malformed or bad-signature code. */
export type OpenResult = { ok: true; mandate: OpenedMandate } | { ok: false; code: Extract<ReasonCode, "MANDATE_MALFORMED" | "MANDATE_SIG_INVALID"> };

interface Decoded {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  jwt: string;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function decodeToken(token: string): Decoded | undefined {
  try {
    const parts = splitSdJwt(token);
    const decoded = decodeJwt<Record<string, unknown>, Record<string, unknown>>(parts.jwt);
    if (!isRecord(decoded.header) || !isRecord(decoded.payload)) return undefined;
    return { header: decoded.header, payload: decoded.payload, jwt: parts.jwt };
  } catch {
    return undefined;
  }
}

/** Read the header and payload. Does not check the signature. */
export function decodeMandateUnverified(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } | undefined {
  const decoded = decodeToken(token.trim());
  if (!decoded) return undefined;
  return { header: decoded.header, payload: decoded.payload };
}

function readTask(value: unknown): Task | undefined {
  if (!isRecord(value)) return undefined;
  const type = requiredString(value[CLAIM.type]);
  if (!type) return undefined;
  const task: Task = { type };
  const resource = value[CLAIM.resource];
  if (resource !== undefined) {
    if (typeof resource !== "string") return undefined;
    task.resource = resource;
  }
  const params = value[CLAIM.params];
  if (params !== undefined) {
    if (!isRecord(params)) return undefined;
    task.params = params;
  }
  return task;
}

function readLimits(value: unknown): Limits | undefined {
  if (!isRecord(value)) return undefined;
  const maxActions = value[CLAIM.maxActions];
  if (!isInteger(maxActions) || maxActions < 1) return undefined;
  return { maxActions };
}

function malformed(): OpenResult {
  return { ok: false, code: "MANDATE_MALFORMED" };
}

function sigInvalid(): OpenResult {
  return { ok: false, code: "MANDATE_SIG_INVALID" };
}

/** Check the mandate signature and shape. Does not check time, audience, or the HTTP signature. */
export async function openMandate(token: string, options?: { onePerPerson?: boolean }): Promise<OpenResult> {
  const decoded = decodeToken(token);
  if (!decoded) return malformed();
  const { header, payload, jwt } = decoded;
  if (header[JOSE.typ] !== JOSE.typValue) return malformed();
  if (payload[CLAIM.vct] !== PROFILE.vct) return malformed();
  const iss = requiredString(payload[CLAIM.iss]);
  const sub = requiredString(payload[CLAIM.sub]);
  const aud = requiredString(payload[CLAIM.aud]);
  const jti = requiredString(payload[CLAIM.jti]);
  const task = readTask(payload[CLAIM.task]);
  const iat = payload[CLAIM.iat];
  const nbf = payload[CLAIM.nbf];
  const exp = payload[CLAIM.exp];
  if (!iss || !sub || !aud || !jti || !task) return malformed();
  let tid: string | undefined;
  if (payload[CLAIM.tid] !== undefined) {
    tid = requiredString(payload[CLAIM.tid]);
    if (!tid) return malformed();
  }
  if (!isInteger(iat) || !isInteger(nbf) || !isInteger(exp)) return malformed();
  let tend: number | undefined;
  if (payload[CLAIM.tend] !== undefined) {
    const rawTend = payload[CLAIM.tend];
    if (!isInteger(rawTend)) return malformed();
    tend = rawTend;
  }
  let tbeg: number | undefined;
  if (payload[CLAIM.tbeg] !== undefined) {
    const rawBegin = payload[CLAIM.tbeg];
    if (!isInteger(rawBegin)) return malformed();
    tbeg = rawBegin;
  }
  let pa: string | undefined;
  const rawPa = payload[CLAIM.pa];
  if (rawPa !== undefined) {
    if (typeof rawPa !== "string") return malformed();
    pa = rawPa;
  }
  if (iss.length > LIMIT.nameChars || sub.length > LIMIT.nameChars || jti.length > LIMIT.idChars) return malformed();
  if (tid !== undefined && tid.length > LIMIT.idChars) return malformed();
  if (pa !== undefined && utf8Size(pa) > LIMIT.attestationBytes) return malformed();
  if (pa === undefined && sub !== iss) return malformed();
  if (nbf > exp || iat > exp) return malformed();
  if (tend !== undefined && tend < exp) return malformed();
  if (tbeg !== undefined && tbeg > nbf) return malformed();
  let limits: Limits | undefined;
  if (payload[CLAIM.limits] !== undefined) {
    limits = readLimits(payload[CLAIM.limits]);
    if (!limits) return malformed();
  }
  const cnf = payload[CLAIM.cnf];
  const agentJwk = isRecord(cnf) ? cnf[CLAIM.jwk] : undefined;
  if (!isRecord(agentJwk)) return malformed();
  let agentPublic: JsonWebKey;
  let agentKeyId: string;
  try {
    agentPublic = normalizePublicJwk(agentJwk as JsonWebKey);
    agentKeyId = await thumbprint(agentPublic);
  } catch {
    return malformed();
  }
  if (options?.onePerPerson === true && tid !== undefined && tbeg === undefined) return malformed();

  const headerJwk = header[JOSE.jwk];
  if (!isRecord(headerJwk)) return sigInvalid();
  let headerPublic: JsonWebKey;
  let headerThumb: string;
  try {
    headerPublic = normalizePublicJwk(headerJwk as JsonWebKey);
    headerThumb = await thumbprint(headerPublic);
  } catch {
    return sigInvalid();
  }
  if (iss !== `${ISSUER_PREFIX}${headerThumb}`) return sigInvalid();
  if (header[JOSE.alg] !== JOSE.algValue) return sigInvalid();
  try {
    const key = await importPublicKey(headerPublic);
    await Jwt.fromEncode(jwt).verify(verifyEd25519(key), { skipJwtClaimValidation: true, allowedIssuerAlgorithms: [JOSE.algValue] });
  } catch {
    return sigInvalid();
  }

  return { ok: true, mandate: { iss, sub, aud, agentPublic, agentKeyId, task, ...(limits ? { limits } : {}), iat, nbf, exp, jti, ...(tid ? { tid } : {}), ...(tend !== undefined ? { tend } : {}), ...(tbeg !== undefined ? { tbeg } : {}), ...(pa !== undefined ? { pa } : {}) } };
}
