import type { RoutePolicy } from "@task-mandate/core";
import type { MandateEnv } from "@task-mandate/node";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { readBodyWithin } from "./body-limit.js";
import { CIVIL_SERVICES, findCivilService } from "./civil-data.js";
import type { CivilLimiter } from "./civil-limiter.js";
import type { CivilLog, CivilLogEntry } from "./civil-log.js";
import { newReceiptNo } from "./receipt.js";

const SERVICE_NAME_LIMIT = 64;
const TASK_LABEL_LIMIT = 64;

type MandateFor = (route?: RoutePolicy) => MiddlewareHandler<MandateEnv>;

function serviceName(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const service = (body as { service?: unknown }).service;
  if (typeof service !== "string" || service.length > SERVICE_NAME_LIMIT) return null;
  return service;
}

function serviceFromBytes(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return null;
  try {
    return serviceName(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

function clientKey(header: string | null): string {
  return header === null ? "unknown" : header;
}

function taskLabel(c: Context<MandateEnv>): string | null {
  const decision = c.get("mandate");
  if (!decision) return null;
  const resource = decision.task.resource;
  const label = resource === undefined ? decision.task.type : `${decision.task.type}:${resource}`;
  return label.slice(0, TASK_LABEL_LIMIT);
}

async function responseCode(response: Response): Promise<string | null> {
  if (response.status >= 200 && response.status < 300) return null;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as { code?: unknown; error?: unknown };
  if (typeof record.code === "string") return record.code;
  if (typeof record.error === "string") return record.error;
  return null;
}

export function mountCivil(app: Hono<MandateEnv>, opts: { mandate: MandateFor; civilLog: CivilLog; civilLimiter?: CivilLimiter; now: () => Date }): void {
  const peeked = new WeakMap<object, string | null>();

  app.get("/civil/services", (c) => c.json({ services: CIVIL_SERVICES.map((service) => ({ id: service.id, title: service.title })) }));
  app.get("/civil/log", async (c) => c.json({ entries: await opts.civilLog.recent() }, 200, { "cache-control": "no-store" }));

  // Leave the body for the digest check. The log uses only a clone read up to the cap.
  const writeLog = async (entry: CivilLogEntry): Promise<void> => {
    try {
      await opts.civilLog.append(entry);
    } catch (error) {
      console.error(error);
    }
  };
  app.post(
    "/civil/apply",
    async (c, next) => {
      // The rate limit runs before the body cap. Over the limit, do not log and stop here.
      if (opts.civilLimiter) {
        const allowed = await opts.civilLimiter.hit(clientKey(c.req.raw.headers.get("cf-connecting-ip")), opts.now());
        if (!allowed) return c.json({ error: "rate-limited" }, 429);
      }
      const bytes = await readBodyWithin(c.req.raw);
      const tooLarge = bytes === undefined;
      if (bytes !== undefined) peeked.set(c.req.raw, serviceFromBytes(bytes));
      let status = 500;
      let code: string | null = null;
      try {
        if (tooLarge) {
          status = 413;
          code = "too-large";
          return c.json({ error: "too-large" }, 413);
        }
        await next();
        status = c.res.status;
        code = await responseCode(c.res);
      } finally {
        await writeLog({ at: opts.now().toISOString(), status, code, service: tooLarge ? null : (peeked.get(c.req.raw) ?? null), task: tooLarge ? null : taskLabel(c) });
      }
    },
    // A name of at most 64 UTF-16 code units is passed as requireTask.resource so a different service is rejected before the count.
    async (c, next) => {
      const service = peeked.get(c.req.raw);
      const route: RoutePolicy = typeof service === "string" ? { requireTask: { type: "apply", resource: service } } : { requireTask: { type: "apply" } };
      return opts.mandate(route)(c, next);
    },
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "bad-request" }, 400);
      }
      const service = serviceName(body);
      if (service === null) return c.json({ error: "bad-request" }, 400);
      // This comparison is a second check of the requireTask.resource passed to the middleware.
      if (c.get("mandate").task.resource !== service) return c.json({ decision: "deny", code: "TASK_NOT_ALLOWED" }, 403);
      const found = findCivilService(service);
      if (!found) return c.json({ error: "not-found" }, 404);
      return c.json({ ok: true, service, title: found.title, receiptNo: newReceiptNo() });
    },
  );
}
