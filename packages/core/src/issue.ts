import { uint8ArrayToBase64Url } from "@sd-jwt/core";
import { SdJwtVcInstance, type SdJwtVcPayload } from "@sd-jwt/sd-jwt-vc";
import { assertOrigin } from "./config.js";
import { TaskMandateError } from "./error.js";
import { importPrivateKey, normalizePublicJwk, randomId, thumbprint } from "./jwk.js";
import { readAttestationClaims } from "./person.js";
import { CLAIM, ISSUER_PREFIX, JOSE, PROFILE } from "./profile.js";
import type { Limits, Task } from "./types.js";
import { ED25519, unixSeconds } from "./util.js";

/** Fields for a new mandate. Omitted task claims are left out of the token. */
export interface IssueInput {
  principalKey: JsonWebKey;
  agentPublicKey: JsonWebKey;
  audience: string;
  task: Task;
  limits?: Limits;
  /** Shared task id for every chunk of one task. */
  taskId?: string;
  /** Task end. Issuance fails when this is earlier than the chunk expiry. */
  taskEnd?: Date;
  /** Shared task start for every chunk of one task. */
  taskBegin?: Date;
  /** Person attestation. Issuance fails when it expires before the chunk. */
  personAttestation?: string;
  notBefore?: Date;
  durationSec: number;
  now?: Date;
}

function compactTask(task: Task): Task {
  const out: Task = { type: task.type };
  if (task.resource !== undefined) out.resource = task.resource;
  if (task.params !== undefined) out.params = task.params;
  return out;
}

async function sha256(data: string | ArrayBuffer, alg: string): Promise<Uint8Array> {
  if (alg !== "sha-256" && alg !== "sha256") throw new TaskMandateError("INPUT_INVALID", `unsupported hash: ${alg}`);
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

const MAX_ISSUE_SEC = 2_592_000;

/** Issue an SD-JWT VC mandate. */
export async function issueMandate(input: IssueInput): Promise<string> {
  assertOrigin(input.audience, "INPUT_INVALID");
  if (!Number.isInteger(input.durationSec) || input.durationSec < 1 || input.durationSec > MAX_ISSUE_SEC) {
    throw new TaskMandateError("INPUT_INVALID", "durationSec must be an integer from 1 to 2592000");
  }
  if (input.limits !== undefined) {
    const maxActions = input.limits.maxActions;
    if (!Number.isInteger(maxActions) || maxActions < 1) {
      throw new TaskMandateError("INPUT_INVALID", "maxActions must be an integer greater than or equal to 1");
    }
  }
  if (input.notBefore !== undefined && (!(input.notBefore instanceof Date) || Number.isNaN(input.notBefore.getTime()))) {
    throw new TaskMandateError("INPUT_INVALID", "notBefore must be a valid Date");
  }
  const issuedAt = input.now ?? new Date();
  const starts = input.notBefore ?? issuedAt;
  const exp = unixSeconds(starts) + input.durationSec;
  let tend: number | undefined;
  if (input.taskEnd !== undefined) {
    if (!(input.taskEnd instanceof Date) || Number.isNaN(input.taskEnd.getTime())) {
      throw new TaskMandateError("INPUT_INVALID", "taskEnd must be a Date");
    }
    tend = unixSeconds(input.taskEnd);
    if (tend < exp) throw new TaskMandateError("INPUT_INVALID", "taskEnd is earlier than chunk expiry");
  }
  let tbeg: number | undefined;
  if (input.taskBegin !== undefined) {
    if (!(input.taskBegin instanceof Date) || Number.isNaN(input.taskBegin.getTime())) {
      throw new TaskMandateError("INPUT_INVALID", "taskBegin must be a Date");
    }
    tbeg = unixSeconds(input.taskBegin);
  }
  let subjectOverride: string | undefined;
  let personAttestation: string | undefined;
  if (input.personAttestation !== undefined) {
    personAttestation = input.personAttestation.trim();
    const attestation = readAttestationClaims(personAttestation);
    if (attestation.exp < exp) throw new TaskMandateError("INPUT_INVALID", "person attestation expires before the chunk");
    subjectOverride = attestation.sub;
  }
  const principalKey = await importPrivateKey(input.principalKey);
  const principalPublic = normalizePublicJwk(input.principalKey);
  const agentPublic = normalizePublicJwk(input.agentPublicKey);
  const iss = `${ISSUER_PREFIX}${await thumbprint(principalPublic)}`;
  const claims: Record<string, unknown> = {
    [CLAIM.vct]: PROFILE.vct,
    [CLAIM.iss]: iss,
    [CLAIM.sub]: subjectOverride ?? iss,
    [CLAIM.aud]: input.audience,
    [CLAIM.cnf]: { [CLAIM.jwk]: agentPublic },
    [CLAIM.task]: compactTask(input.task),
    [CLAIM.iat]: unixSeconds(issuedAt),
    [CLAIM.nbf]: unixSeconds(starts),
    [CLAIM.exp]: exp,
    [CLAIM.jti]: randomId(),
  };
  if (input.taskId !== undefined) {
    if (typeof input.taskId !== "string" || input.taskId === "") throw new TaskMandateError("INPUT_INVALID", "taskId must be a non-empty string");
    claims[CLAIM.tid] = input.taskId;
  }
  if (tend !== undefined) claims[CLAIM.tend] = tend;
  if (tbeg !== undefined) claims[CLAIM.tbeg] = tbeg;
  if (personAttestation !== undefined) claims[CLAIM.pa] = personAttestation;
  if (input.limits) claims[CLAIM.limits] = { [CLAIM.maxActions]: input.limits.maxActions };

  const vc = new SdJwtVcInstance({
    signAlg: JOSE.algValue,
    hasher: sha256,
    saltGenerator: (length) => {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      return uint8ArrayToBase64Url(bytes);
    },
    signer: async (data) => {
      const signature = await crypto.subtle.sign(ED25519, principalKey, new TextEncoder().encode(data));
      return uint8ArrayToBase64Url(new Uint8Array(signature));
    },
  });
  return vc.issue(claims as SdJwtVcPayload, undefined, { header: { [JOSE.jwk]: principalPublic } });
}
