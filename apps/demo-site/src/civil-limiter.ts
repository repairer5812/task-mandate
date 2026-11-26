import { digestKey } from "@task-mandate/core/internal";

export const CIVIL_LIMIT = 20;
export const CIVIL_WINDOW_SEC = 60;

export interface CivilLimiter {
  hit(key: string, now: Date): Promise<boolean>;
}

export interface CivilWindowRow {
  startMs: number;
  count: number;
}

export function civilWindowCutoff(nowMs: number, windowSec: number): number {
  return nowMs - windowSec * 1000;
}

function assertRate(limit: number, windowSec: number): void {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSec) || windowSec < 1) {
    throw new Error("rate limit config is invalid");
  }
}

export function advanceCivilWindow(row: CivilWindowRow | undefined, nowMs: number, limit: number, windowSec: number): { row: CivilWindowRow; allowed: boolean } {
  assertRate(limit, windowSec);
  if (row === undefined || row.startMs <= civilWindowCutoff(nowMs, windowSec)) {
    return { row: { startMs: nowMs, count: 1 }, allowed: true };
  }
  const count = row.count + 1;
  return { row: { startMs: row.startMs, count }, allowed: count <= limit };
}

export function memoryCivilLimiter(options: { limit: number; windowSec: number }): CivilLimiter {
  assertRate(options.limit, options.windowSec);
  const rows = new Map<string, CivilWindowRow>();
  return {
    async hit(key, now) {
      const stored = await digestKey(key);
      const nowMs = now.getTime();
      const cutoff = civilWindowCutoff(nowMs, options.windowSec);
      for (const [id, row] of rows) {
        if (row.startMs <= cutoff) rows.delete(id);
      }
      const next = advanceCivilWindow(rows.get(stored), nowMs, options.limit, options.windowSec);
      rows.set(stored, next.row);
      return next.allowed;
    },
  };
}
