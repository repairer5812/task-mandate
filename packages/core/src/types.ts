/** Reason code on a challenge or deny decision. */
export type ReasonCode =
  | "NO_MANDATE"
  | "MANDATE_MALFORMED"
  | "MANDATE_SIG_INVALID"
  | "ISSUER_NOT_TRUSTED"
  | "AUD_MISMATCH"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "LIFETIME_TOO_LONG"
  | "SIG_MISSING"
  | "KEY_MISMATCH"
  | "SIG_INVALID"
  | "BODY_TOO_LARGE"
  | "REPLAY"
  | "TASK_NOT_ALLOWED"
  | "LIMIT_EXCEEDED"
  | "PERSON_REQUIRED"
  | "PERSON_INVALID"
  | "SUPERSEDED";

/** Work the mandate allows. */
export interface Task {
  type: string;
  resource?: string;
  params?: Record<string, unknown>;
}

/** Optional cap on how many times a mandate may act. */
export interface Limits {
  maxActions: number;
}

/** Allow, challenge, or deny result from the public verifier. */
export type Decision =
  | {
      decision: "allow";
      principal: string;
      agentKeyId: string;
      mandateId: string;
      /** Task id claim, or the mandate id when that claim is absent. */
      taskId: string;
      task: Task;
      person?: { iss: string; sub: string };
      /** Undo one consumed action from this allow. No-op when none was consumed, or on a second call. */
      refund: () => Promise<void>;
    }
  | { decision: "challenge" | "deny"; code: ReasonCode };

/** Internal allow result. `actionConsumed` is omitted from the public `Decision`. */
export type VerifyResult = (Extract<Decision, { decision: "allow" }> & { actionConsumed: boolean }) | Extract<Decision, { decision: "challenge" | "deny" }>;

/** Issuer keys accepted for person attestations. */
export interface PersonIssuer {
  iss: string;
  jwks: readonly JsonWebKey[];
}

/** One attempt to hold the person slot. Times are seconds. */
export interface PersonSlotClaim {
  personKey: string;
  taskKey: string;
  agentKeyId: string;
  taskBegin: number;
  expiresAt: number;
  now: number;
  minSwitchSec: number;
}

/** Nonce, action-count, and person-slot store. Each method must be atomic. */
export interface Store {
  /**
   * Atomically record a new nonce and return true. Return false while it is still live.
   * The entry may be dropped ttlSec seconds after it is stored, measured on the store clock.
   */
  claimNonce(nonce: string, ttlSec: number): Promise<boolean>;
  /**
   * Atomically increment the counter when it is below max, and return true. Otherwise return false.
   * Do not move an existing expiry earlier. ttlSec is the lifetime in seconds on the store clock.
   * Return false without writing when ttlSec < 1. Treat expiresAt <= now as expired.
   */
  consumeAction(key: string, max: number, ttlSec: number): Promise<boolean>;
  /**
   * Atomically undo one consumeAction. The count never goes below zero.
   * Expiry is judged on the store clock.
   */
  refundAction(key: string): Promise<void>;
  /**
   * Atomically apply the person-slot rules. Return "ok" or "superseded".
   * On each call, drop this person's slots that have expired at input.now (verifier clock).
   * taskBegin, expiresAt, now, and minSwitchSec are seconds.
   */
  claimPersonSlot(input: PersonSlotClaim): Promise<"ok" | "superseded">;
}

/** Verifier settings for one site origin. */
export interface VerifierConfig {
  origin: string;
  maxLifetimeSec?: number;
  clockSkewSec?: number;
  /** Empty accepts any issuer whose signature is valid. Set this or `requirePerson` to bind a person. */
  trustedIssuers?: readonly string[];
  onNoMandate?: "challenge" | "deny";
  maxTaskSec?: number;
  personIssuers?: readonly PersonIssuer[];
  requirePerson?: boolean;
  onePerPerson?: boolean;
  minSwitchSec?: number;
  /** Body cap in bytes. Default 1048576. A non-integer or a value below 1 is a config error. */
  maxBodyBytes?: number;
}

/** Optional task constraint for one route. */
export interface RoutePolicy {
  requireTask?: { type: string; resource?: string };
}
