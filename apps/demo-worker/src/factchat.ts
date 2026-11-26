import { CIVIL_SERVICES } from "@task-mandate/demo-site";

export const FACTCHAT_URL = "https://factchat.mindlogic-kr-api.com/v1/gateway/chat/completions/";
export const FACTCHAT_MODEL = "claude-opus-5-5";
export const FACTCHAT_TIMEOUT_MS = 15_000;

const SYSTEM = `민원 세 가지(${CIVIL_SERVICES.map((service) => service.id).join(", ")}) 중 무엇인지, 기간(초), 횟수를 JSON 한 개로만 답하라. 키는 service, durationSec, maxActions.`;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    const record = asRecord(part);
    if (record && typeof record.text === "string") parts.push(record.text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function modelText(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const record = asRecord(parsed);
  if (!record) return body;
  if (Array.isArray(record.choices)) {
    const message = asRecord(asRecord(record.choices[0])?.message);
    const text = message ? textFromContent(message.content) : undefined;
    if (text === undefined) throw new Error("FactChat response has no JSON");
    return text;
  }
  return textFromContent(record.content) ?? body;
}

export function readFactChatBody(body: string): unknown {
  const text = modelText(body);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("FactChat response has no JSON");
  const value: unknown = JSON.parse(text.slice(start, end + 1));
  if (!asRecord(value)) throw new Error("FactChat response has no JSON");
  return value;
}

export async function interpretWithFactChat(text: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const response = await fetchImpl(FACTCHAT_URL, {
    method: "POST",
    // Workers does not support redirect "error". Use manual, and treat 3xx as failure.
    redirect: "manual",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: FACTCHAT_MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
    }),
    signal: AbortSignal.timeout(FACTCHAT_TIMEOUT_MS),
  });
  if (response.status >= 300 || !response.ok) throw new Error(`FactChat response failed (${response.status})`);
  return readFactChatBody(await response.text());
}
