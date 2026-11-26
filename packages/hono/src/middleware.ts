import { assertVerifierConfig, type Decision, type RoutePolicy, type Store, TaskMandateError, type VerifierConfig } from "@task-mandate/core";
import { verifyRequest } from "@task-mandate/core/internal";
import type { MiddlewareHandler } from "hono";

/** Middleware settings. `store` is required. `now` supplies the verifier clock. */
export interface MandateMiddlewareConfig extends VerifierConfig {
  store: Store;
  now?: () => Date;
}

type AllowedMandate = Extract<Decision, { decision: "allow" }>;

/** Hono variables set after an allow decision. */
export interface MandateEnv {
  Variables: { mandate: AllowedMandate };
}

/** Challenge is 401 and deny is 403. Refunds the action when the handler throws or returns a non-2xx status. */
export function taskMandate(config: MandateMiddlewareConfig): (route?: RoutePolicy) => MiddlewareHandler<MandateEnv> {
  assertVerifierConfig(config);
  const store = (config as { store?: Store }).store;
  if (store === undefined) throw new TaskMandateError("STORE_REQUIRED", "store is required");
  const now = config.now ?? (() => new Date());
  return (route) => {
    const handler: MiddlewareHandler<MandateEnv> = async (c, next) => {
      const outcome = await verifyRequest(c.req.raw, config, route ?? {}, store, now());
      if (outcome.decision !== "allow") return c.json(outcome, outcome.decision === "challenge" ? 401 : 403);
      const { actionConsumed: _actionConsumed, ...decision } = outcome;
      c.set("mandate", decision);
      try {
        await next();
      } catch (error) {
        await decision.refund();
        throw error;
      }
      if (c.res.status < 200 || c.res.status >= 300) await decision.refund();
    };
    return handler;
  };
}
