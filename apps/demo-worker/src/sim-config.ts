import { SIM_ATTEST_LIMIT, SIM_ATTEST_WINDOW_SEC, SIM_LLM_LIMIT, SIM_LLM_WINDOW_SEC, type SimOptions } from "@task-mandate/demo-site";
import type { Env } from "./env.js";
import { interpretWithFactChat } from "./factchat.js";
import type { MandateStore } from "./store.js";

function readIdp(raw: string | undefined): SimOptions["idp"] {
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const jwk = record.jwk;
    if (typeof record.iss !== "string" || record.iss === "") return undefined;
    if (typeof record.secret !== "string" || record.secret === "") return undefined;
    if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) return undefined;
    return { key: jwk as JsonWebKey, issuer: record.iss, secret: record.secret };
  } catch {
    return undefined;
  }
}

export function simOptions(env: Env, civil: DurableObjectStub<MandateStore>): SimOptions {
  const options: SimOptions = {
    llmLimiter: { hit: (key, now) => civil.hitSimLlm(key, now.getTime(), SIM_LLM_LIMIT, SIM_LLM_WINDOW_SEC) },
    budget: { take: (dayKey, max) => civil.takeSimBudget(dayKey, max) },
    attestLimiter: { hit: (key, now) => civil.hitSimAttest(key, now.getTime(), SIM_ATTEST_LIMIT, SIM_ATTEST_WINDOW_SEC) },
  };
  const idp = readIdp(env.SIM_IDP_JWK);
  if (idp) options.idp = idp;
  if (env.SIM_PRESENTER_CODE) options.presenterCode = env.SIM_PRESENTER_CODE;
  const apiKey = env.FACTCHAT_API_KEY;
  if (apiKey) {
    options.interpret = async (text) => {
      try {
        return await interpretWithFactChat(text, apiKey);
      } catch (error) {
        // Do not log the key or the body. Keep only the failure kind so the fallback to rule interpretation stays visible.
        console.error("factchat failed:", error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
        throw error;
      }
    };
  }
  return options;
}
