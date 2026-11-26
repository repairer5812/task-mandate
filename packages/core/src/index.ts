import type { Decision, RoutePolicy, Store, VerifierConfig } from "./types.js";
import { verifyRequest as verifyRequestFull } from "./verify.js";

export { assertVerifierConfig, DEFAULT_CLOCK_SKEW_SEC } from "./config.js";
export { TaskMandateError, type TaskMandateErrorCode } from "./error.js";
export { type IssueInput, issueMandate } from "./issue.js";
export { normalizePublicJwk, thumbprint } from "./jwk.js";
export { decodeMandateUnverified } from "./mandate.js";
export { issuePersonAttestation, pairwiseId } from "./person.js";
export { ISSUER_PREFIX, PROFILE, SIGNATURE_MAX_AGE_SEC } from "./profile.js";
export type { LeasePlan, RenewStep } from "./renew.js";
export { nextRenewal } from "./renew.js";
export { memoryStore } from "./store.js";
export type {
  Decision,
  Limits,
  PersonIssuer,
  PersonSlotClaim,
  ReasonCode,
  RoutePolicy,
  Store,
  Task,
  VerifierConfig,
} from "./types.js";

/** Verify a signed request. An allow decision leaves out the internal action-consumed flag. */
export async function verifyRequest(request: Request, config: VerifierConfig, route: RoutePolicy, store: Store, now?: Date): Promise<Decision> {
  const outcome = await verifyRequestFull(request, config, route, store, now);
  if (outcome.decision !== "allow") return outcome;
  const { actionConsumed: _actionConsumed, ...decision } = outcome;
  return decision;
}
