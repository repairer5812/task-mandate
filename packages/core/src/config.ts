import { TaskMandateError, type TaskMandateErrorCode } from "./error.js";
import type { VerifierConfig } from "./types.js";

export const DEFAULT_MAX_LIFETIME_SEC = 86_400;
/** Default clock skew, in seconds. */
export const DEFAULT_CLOCK_SKEW_SEC = 30;
export const DEFAULT_MAX_TASK_SEC = 2_592_000;
export const DEFAULT_MIN_SWITCH_SEC = 600;
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

// RFC 6454 serialization: lowercase scheme and host, default port omitted, no path or trailing slash.
export function isSerializedOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
}

export function assertOrigin(value: string, code: TaskMandateErrorCode = "CONFIG_INVALID"): void {
  if (!isSerializedOrigin(value)) throw new TaskMandateError(code, "origin must be an RFC 6454 serialized origin");
}

function assertIntegerRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TaskMandateError("CONFIG_INVALID", `${name} must be an integer from ${min} to ${max}`);
  }
}

/** Reject a verifier config that would make checks disagree with the spec. */
export function assertVerifierConfig(config: VerifierConfig): void {
  assertOrigin(config.origin);
  assertIntegerRange("clockSkewSec", config.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC, 0, 300);
  assertIntegerRange("maxLifetimeSec", config.maxLifetimeSec ?? DEFAULT_MAX_LIFETIME_SEC, 1, 2_592_000);
  assertIntegerRange("maxTaskSec", config.maxTaskSec ?? DEFAULT_MAX_TASK_SEC, 1, 2_592_000);
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TaskMandateError("CONFIG_INVALID", "maxBodyBytes must be an integer greater than or equal to 1");
  }
  const minSwitchSec = config.minSwitchSec ?? DEFAULT_MIN_SWITCH_SEC;
  if (typeof minSwitchSec !== "number" || !Number.isFinite(minSwitchSec) || minSwitchSec < 1) {
    throw new TaskMandateError("CONFIG_INVALID", "minSwitchSec must be a finite number greater than or equal to 1");
  }
  const requirePerson = config.requirePerson === true;
  const onePerPerson = config.onePerPerson === true;
  const issuers = config.personIssuers ?? [];
  if (requirePerson && issuers.length === 0) {
    throw new TaskMandateError("CONFIG_INVALID", "requirePerson is set but personIssuers is empty");
  }
  if (onePerPerson && !requirePerson) throw new TaskMandateError("CONFIG_INVALID", "onePerPerson requires requirePerson");
  if (onePerPerson && new Set(issuers.map((issuer) => issuer.iss)).size > 1) {
    throw new TaskMandateError("CONFIG_INVALID", "onePerPerson allows only one person issuer");
  }
}
