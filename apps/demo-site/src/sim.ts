import { issuePersonAttestation } from "@task-mandate/core";
import type { MandateEnv } from "@task-mandate/node";
import type { Hono } from "hono";
import { readBodyWithin } from "./body-limit.js";
import { findCivilService } from "./civil-data.js";
import { type CivilLimiter, memoryCivilLimiter } from "./civil-limiter.js";
import { fixedEqual } from "./fixed-equal.js";
import { type Interpreted, interpretByRule, koreaDayKey, readLlmFields, SIM_ATTEST_LIMIT, SIM_ATTEST_SEC, SIM_ATTEST_WINDOW_SEC, SIM_DAILY_MAX, SIM_LLM_LIMIT, SIM_LLM_WINDOW_SEC, SIM_PRESENTER_DAILY_MAX, SIM_TEXT_MAX } from "./sim-rules.js";

export interface SimBudget {
  take(dayKey: string, max: number): Promise<boolean>;
}

export interface SimIdp {
  key: JsonWebKey;
  issuer: string;
  secret: string;
}

export interface SimOptions {
  interpret?: (text: string) => Promise<unknown>;
  llmLimiter?: CivilLimiter;
  budget?: SimBudget;
  presenterCode?: string;
  idp?: SimIdp;
  attestLimiter?: CivilLimiter;
}

export function memorySimBudget(): SimBudget {
  const counts = new Map<string, number>();
  return {
    async take(dayKey, max) {
      const count = (counts.get(dayKey) ?? 0) + 1;
      counts.set(dayKey, count);
      return count <= max;
    },
  };
}

function clientIp(header: string | undefined): string {
  if (header === undefined || header === "") return "unknown";
  return header;
}

async function presenterBypass(code: string | undefined, header: string | null): Promise<boolean> {
  if (code === undefined || code === "") return false;
  return fixedEqual(header ?? "", code);
}

async function readLimitedJson(request: Request): Promise<{ tooLarge: true } | { tooLarge: false; value: unknown }> {
  const bytes = await readBodyWithin(request);
  if (bytes === undefined) return { tooLarge: true };
  if (bytes.byteLength === 0) return { tooLarge: false, value: undefined };
  try {
    return { tooLarge: false, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { tooLarge: false, value: undefined };
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function utteranceOf(value: unknown): string | undefined {
  const text = recordOf(value)?.text;
  if (typeof text !== "string" || text.length === 0 || text.length > SIM_TEXT_MAX) return undefined;
  return text;
}

function isPublicEd25519(value: unknown): value is JsonWebKey {
  const jwk = recordOf(value) as JsonWebKey | undefined;
  if (!jwk) return false;
  if (Object.hasOwn(jwk, "d")) return false;
  return jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string" && jwk.x !== "";
}

export function mountSim(app: Hono<MandateEnv>, opts: { origin: string; now: () => Date; sim: SimOptions }): void {
  const sim = opts.sim;
  const llmLimiter = sim.llmLimiter ?? memoryCivilLimiter({ limit: SIM_LLM_LIMIT, windowSec: SIM_LLM_WINDOW_SEC });
  const budget = sim.budget ?? memorySimBudget();
  const attestLimiter = sim.attestLimiter ?? memoryCivilLimiter({ limit: SIM_ATTEST_LIMIT, windowSec: SIM_ATTEST_WINDOW_SEC });

  const pick = async (text: string, ip: string, presenter: string | null, now: Date): Promise<{ source: "llm" | "rule"; fields: Interpreted }> => {
    const ruled = () => ({ source: "rule" as const, fields: interpretByRule(text) });
    if (!sim.interpret) return ruled();
    const day = koreaDayKey(now);
    if (await presenterBypass(sim.presenterCode, presenter)) {
      if (!(await budget.take(`presenter:${day}`, SIM_PRESENTER_DAILY_MAX))) return ruled();
    } else {
      if (!(await llmLimiter.hit(ip, now))) return ruled();
      if (!(await budget.take(day, SIM_DAILY_MAX))) return ruled();
    }
    try {
      return { source: "llm", fields: readLlmFields(await sim.interpret(text)) };
    } catch {
      return ruled();
    }
  };

  app.post("/sim/interpret", async (c) => {
    const parsed = await readLimitedJson(c.req.raw);
    if (parsed.tooLarge) return c.json({ error: "too-large" }, 413);
    const text = utteranceOf(parsed.value);
    if (text === undefined) return c.json({ error: "bad-request" }, 400);
    const now = opts.now();
    const picked = await pick(text, clientIp(c.req.header("cf-connecting-ip")), c.req.header("x-presenter-code") ?? null, now);
    const found = picked.fields.service ? findCivilService(picked.fields.service) : undefined;
    return c.json({ source: picked.source, service: picked.fields.service, title: found?.title ?? null, durationSec: picked.fields.durationSec, maxActions: picked.fields.maxActions });
  });

  app.post("/sim/attest", async (c) => {
    if (!(await attestLimiter.hit(clientIp(c.req.header("cf-connecting-ip")), opts.now()))) {
      return c.json({ error: "rate-limited" }, 429);
    }
    const parsed = await readLimitedJson(c.req.raw);
    if (parsed.tooLarge) return c.json({ error: "too-large" }, 413);
    const key = recordOf(parsed.value)?.principalPublicKey;
    if (!isPublicEd25519(key)) return c.json({ error: "bad-request" }, 400);
    if (!sim.idp) return c.json({ error: "unavailable" }, 503);
    const attestation = await issuePersonAttestation({ idpKey: sim.idp.key, idpIssuer: sim.idp.issuer, secret: sim.idp.secret, personId: `sim-${crypto.randomUUID()}`, audience: opts.origin, principalPublicKey: key, durationSec: SIM_ATTEST_SEC, now: opts.now() });
    return c.json({ attestation, issuer: sim.idp.issuer });
  });
}
