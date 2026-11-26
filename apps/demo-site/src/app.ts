import { assertVerifierConfig, type RoutePolicy, type Store, type VerifierConfig } from "@task-mandate/core";
import { type MandateEnv, taskMandate } from "@task-mandate/node";
import { Hono } from "hono";
import { DEMO_BODY_LIMIT, readBodyWithin } from "./body-limit.js";
import { mountCivil } from "./civil.js";
import { CIVIL_LIMIT, CIVIL_WINDOW_SEC, type CivilLimiter, memoryCivilLimiter } from "./civil-limiter.js";
import { type CivilLog, memoryCivilLog } from "./civil-log.js";
import { memorySeatBook, type SeatBook } from "./seats.js";
import { mountSim, type SimOptions } from "./sim.js";

export { CIVIL_SERVICES } from "./civil-data.js";
export type { CivilLimiter, CivilWindowRow } from "./civil-limiter.js";
export { advanceCivilWindow, CIVIL_LIMIT, CIVIL_WINDOW_SEC, civilWindowCutoff, memoryCivilLimiter } from "./civil-limiter.js";
export type { CivilLog, CivilLogEntry } from "./civil-log.js";
export { memoryCivilLog } from "./civil-log.js";
export { fixedEqual } from "./fixed-equal.js";
export type { SeatBook, SeatResult } from "./seats.js";
export { memorySeatBook } from "./seats.js";
export type { SimBudget, SimIdp, SimOptions } from "./sim.js";
export { memorySimBudget } from "./sim.js";
export {
  SIM_ATTEST_LIMIT,
  SIM_ATTEST_WINDOW_SEC,
  SIM_DAILY_MAX,
  SIM_LLM_LIMIT,
  SIM_LLM_WINDOW_SEC,
} from "./sim-rules.js";

interface DemoBase {
  origin: string;
  store: Store;
  now?: () => Date;
  maxTaskSec?: number;
  maxLifetimeSec?: number;
  personIssuers?: VerifierConfig["personIssuers"];
  requirePerson?: boolean;
  onePerPerson?: boolean;
  minSwitchSec?: number;
}

export type DemoOptions = DemoBase & { seats?: Record<string, number>; seatBook?: SeatBook; civilLog?: CivilLog; civilLimiter?: CivilLimiter; reserveLimiter?: CivilLimiter; reserveBodyLimit?: number; sim?: SimOptions };

function verifierConfig(options: DemoOptions): VerifierConfig {
  return {
    origin: options.origin,
    ...(options.maxLifetimeSec !== undefined ? { maxLifetimeSec: options.maxLifetimeSec } : {}),
    ...(options.maxTaskSec !== undefined ? { maxTaskSec: options.maxTaskSec } : {}),
    ...(options.personIssuers !== undefined ? { personIssuers: options.personIssuers } : {}),
    ...(options.requirePerson !== undefined ? { requirePerson: options.requirePerson } : {}),
    ...(options.onePerPerson !== undefined ? { onePerPerson: options.onePerPerson } : {}),
    ...(options.minSwitchSec !== undefined ? { minSwitchSec: options.minSwitchSec } : {}),
  };
}

function facilityOf(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const facility = (body as { facility?: unknown }).facility;
  return typeof facility === "string" && facility !== "" ? facility : undefined;
}

function facilityFromBytes(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength === 0) return undefined;
  try {
    return facilityOf(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

export function createApp(options: DemoOptions): Hono<MandateEnv> {
  if (!options.seatBook && !options.seats) throw new Error("seats are missing");
  const config = verifierConfig(options);
  assertVerifierConfig(config);
  const book = options.seatBook ?? memorySeatBook(options.seats ?? {});
  const now = options.now ?? (() => new Date());
  const reserveLimiter = options.reserveLimiter ?? memoryCivilLimiter({ limit: CIVIL_LIMIT, windowSec: CIVIL_WINDOW_SEC });
  const reserveBodyLimit = options.reserveBodyLimit ?? DEMO_BODY_LIMIT;
  const app = new Hono<MandateEnv>();
  const mandate = taskMandate({ ...config, store: options.store, now });
  const peekedFacility = new WeakMap<object, string | undefined>();

  app.get("/slots", async (c) => c.json(await book.list()));
  app.post(
    "/reserve",
    async (c, next) => {
      const ip = c.req.header("cf-connecting-ip");
      const allowed = await reserveLimiter.hit(`reserve:${ip === undefined || ip === "" ? "unknown" : ip}`, now());
      if (!allowed) return c.json({ error: "rate-limited" }, 429);
      await next();
    },
    async (c, next) => {
      const bytes = await readBodyWithin(c.req.raw, reserveBodyLimit);
      if (bytes === undefined) return c.json({ error: "too-large" }, 413);
      // Pass the facility as requireTask.resource so a mismatch is rejected before the count and the person slot.
      peekedFacility.set(c.req.raw, facilityFromBytes(bytes));
      await next();
    },
    async (c, next) => {
      const facility = peekedFacility.get(c.req.raw);
      const route: RoutePolicy = typeof facility === "string" ? { requireTask: { type: "reserve", resource: facility } } : { requireTask: { type: "reserve" } };
      return mandate(route)(c, next);
    },
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "bad-request" }, 400);
      }
      const facility = facilityOf(body);
      if (!facility) return c.json({ error: "bad-request" }, 400);
      const decision = c.get("mandate");
      // Second check of the requireTask.resource passed to the middleware.
      if (decision.task.resource !== facility) return c.json({ decision: "deny", code: "TASK_NOT_ALLOWED" }, 403);
      const taken = await book.take(facility);
      if (taken.status === "not-found") return c.json({ error: "not-found" }, 404);
      if (taken.status === "full") return c.json({ error: "full" }, 409);
      try {
        return c.json({ ok: true, facility, remaining: taken.remaining });
      } catch (error) {
        await book.release(facility);
        throw error;
      }
    },
  );
  // Rate limiting is opt-in. Tests send more applications than the public limit allows.
  mountCivil(app, { mandate, civilLog: options.civilLog ?? memoryCivilLog(), ...(options.civilLimiter ? { civilLimiter: options.civilLimiter } : {}), now });
  mountSim(app, { origin: options.origin, now, sim: options.sim ?? {} });
  return app;
}
