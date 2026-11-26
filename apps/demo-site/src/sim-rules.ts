import { findCivilService } from "./civil-data.js";

export const SIM_TEXT_MAX = 200;
export const SIM_LLM_LIMIT = 3;
export const SIM_LLM_WINDOW_SEC = 600;
export const SIM_DAILY_MAX = 30;
export const SIM_PRESENTER_DAILY_MAX = 100;
export const SIM_ATTEST_LIMIT = 10;
export const SIM_ATTEST_WINDOW_SEC = 600;
export const SIM_ATTEST_SEC = 600;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface Interpreted {
  service: string | null;
  durationSec: number;
  maxActions: number;
}

export function koreaDayKey(now: Date): string {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function serviceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return findCivilService(value)?.id ?? null;
}

function earliest(text: string, marks: readonly { phrase: string; value: number }[], fallback: number): number {
  let found: { at: number; value: number } | undefined;
  for (const mark of marks) {
    const at = text.indexOf(mark.phrase);
    if (at < 0) continue;
    if (!found || at < found.at) found = { at, value: mark.value };
  }
  return found?.value ?? fallback;
}

export function interpretByRule(text: string): Interpreted {
  let service: string | null = null;
  if (text.includes("기초연금")) service = "basic-pension";
  else if (text.includes("등본")) service = "resident-copy";
  else if (text.includes("콜택시") || text.includes("택시")) service = "disability-taxi";
  return {
    service,
    durationSec: earliest(
      text,
      [
        { phrase: "오늘", value: 86400 },
        { phrase: "하루", value: 86400 },
        { phrase: "10분", value: 600 },
        { phrase: "한 시간", value: 3600 },
      ],
      3600,
    ),
    maxActions: earliest(
      text,
      [
        { phrase: "한 번", value: 1 },
        { phrase: "두 번", value: 2 },
        { phrase: "세 번", value: 3 },
      ],
      1,
    ),
  };
}

export function readLlmFields(value: unknown): Interpreted {
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return { service: serviceId(record.service), durationSec: clampInt(record.durationSec, 3600, 60, 86400), maxActions: clampInt(record.maxActions, 1, 1, 3) };
}
