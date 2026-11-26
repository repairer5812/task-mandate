import { assertVerifierConfig, DEFAULT_CLOCK_SKEW_SEC, DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_LIFETIME_SEC, DEFAULT_MAX_TASK_SEC, DEFAULT_MIN_SWITCH_SEC } from "./config.js";
import { checkHttpSignature, declaredBodyLength } from "./http-signature.js";
import { LIMIT, utf8Size } from "./limits.js";
import { openMandate } from "./mandate.js";
import { type PersonSubject, verifyPersonAttestation } from "./person.js";
import { PROFILE } from "./profile.js";
import type { ReasonCode, RoutePolicy, Store, VerifierConfig, VerifyResult } from "./types.js";
import { unixSeconds } from "./util.js";

/** Action-count key. Separates the same task id used by another issuer or site. */
export function actionCountKey(iss: string, aud: string, taskId: string): string {
  return `${iss}\u0000${aud}\u0000${taskId}`;
}

function deny(code: ReasonCode): VerifyResult {
  return { decision: "deny", code };
}

/** Full verifier. The allow result includes `actionConsumed`, which the public wrapper omits. */
export async function verifyRequest(request: Request, config: VerifierConfig, route: RoutePolicy, store: Store, now: Date = new Date()): Promise<VerifyResult> {
  assertVerifierConfig(config);
  const maxLifetimeSec = config.maxLifetimeSec ?? DEFAULT_MAX_LIFETIME_SEC;
  const clockSkewSec = config.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC;
  const maxTaskSec = config.maxTaskSec ?? DEFAULT_MAX_TASK_SEC;
  const trustedIssuers = config.trustedIssuers ?? [];
  const onNoMandate = config.onNoMandate ?? "challenge";
  const requirePerson = config.requirePerson === true;
  const onePerPerson = config.onePerPerson === true;
  const nowSec = unixSeconds(now);

  const token = request.headers.get(PROFILE.header);
  if (token === null) return { decision: onNoMandate, code: "NO_MANDATE" };
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const declared = declaredBodyLength(request);
  if (declared !== undefined && declared > maxBodyBytes) return deny("BODY_TOO_LARGE");
  if (utf8Size(token) > LIMIT.headerBytes) return deny("MANDATE_MALFORMED");

  const opened = await openMandate(token, { onePerPerson });
  if (!opened.ok) return deny(opened.code);
  const mandate = opened.mandate;

  if (trustedIssuers.length > 0 && !trustedIssuers.includes(mandate.iss)) return deny("ISSUER_NOT_TRUSTED");

  let person: PersonSubject | undefined;
  if (mandate.pa === undefined) {
    if (requirePerson) return deny("PERSON_REQUIRED");
  } else {
    const checked = await verifyPersonAttestation(mandate.pa, { origin: config.origin, nowSec, clockSkewSec, issuers: config.personIssuers ?? [], mandateIss: mandate.iss, mandateSub: mandate.sub, mandateExp: mandate.exp });
    if (!checked.ok) return deny("PERSON_INVALID");
    person = checked.person;
  }

  const requestOrigin = new URL(request.url).origin;
  if (mandate.aud !== config.origin || requestOrigin !== config.origin) return deny("AUD_MISMATCH");
  if (nowSec < mandate.nbf - clockSkewSec || mandate.iat > nowSec + clockSkewSec) return deny("NOT_YET_VALID");
  const taskEnd = mandate.tend ?? mandate.exp;
  if (nowSec >= mandate.exp + clockSkewSec || nowSec >= taskEnd + clockSkewSec) return deny("EXPIRED");
  const taskSpan = (mandate.tend ?? mandate.exp) - (mandate.tbeg ?? mandate.iat);
  if (mandate.exp - mandate.nbf > maxLifetimeSec || taskSpan > maxTaskSec) return deny("LIFETIME_TOO_LONG");

  const signature = await checkHttpSignature(request, mandate.agentPublic, mandate.agentKeyId, now, clockSkewSec, maxBodyBytes);
  if (!signature.ok) return deny(signature.code);

  const nonceTtl = Math.max(signature.expiresSec - nowSec + clockSkewSec, 1);
  if (!(await store.claimNonce(signature.nonce, nonceTtl))) return deny("REPLAY");

  const required = route.requireTask;
  if (required) {
    if (mandate.task.type !== required.type) return deny("TASK_NOT_ALLOWED");
    if (required.resource !== undefined && mandate.task.resource !== required.resource) return deny("TASK_NOT_ALLOWED");
  }

  const taskId = mandate.tid ?? mandate.jti;

  // Count the action before the person slot. A limit denial must not change the slot. Refund the action if the slot denies.
  let actionConsumed = false;
  let countKey: string | undefined;
  const refund = async (): Promise<void> => {
    if (!actionConsumed || countKey === undefined) return;
    actionConsumed = false;
    await store.refundAction(countKey);
  };
  if (required && mandate.limits) {
    countKey = actionCountKey(mandate.iss, mandate.aud, taskId);
    const actionTtl = taskEnd + clockSkewSec - nowSec;
    if (actionTtl < 1) return deny("EXPIRED");
    if (!(await store.consumeAction(countKey, mandate.limits.maxActions, actionTtl))) return deny("LIMIT_EXCEEDED");
    actionConsumed = true;
  }

  if (onePerPerson && person) {
    const slot = await store.claimPersonSlot({
      personKey: `${person.iss}\u0000${person.sub}`,
      taskKey: actionCountKey(mandate.iss, mandate.aud, taskId),
      agentKeyId: mandate.agentKeyId,
      taskBegin: mandate.tbeg ?? mandate.iat,
      expiresAt: taskEnd + clockSkewSec,
      now: nowSec,
      minSwitchSec: config.minSwitchSec ?? DEFAULT_MIN_SWITCH_SEC,
    });
    if (slot === "superseded") {
      await refund();
      return deny("SUPERSEDED");
    }
  }

  return { decision: "allow", principal: mandate.sub, agentKeyId: mandate.agentKeyId, mandateId: mandate.jti, taskId, task: mandate.task, ...(person ? { person } : {}), actionConsumed, refund };
}
