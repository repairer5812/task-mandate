/** Stored action count. `expiresAt` is seconds. */
export interface ActionRow {
  count: number;
  expiresAt: number;
}

/** Count one action. `expiresAt <= nowSec` drops the row. `ttlSec < 1` does not consume. Expiry may move later, not earlier. */
export function advanceAction(row: ActionRow | undefined, nowSec: number, max: number, ttlSec: number): { row: ActionRow; allowed: boolean } {
  const live = row !== undefined && row.expiresAt > nowSec ? row : undefined;
  if (!(ttlSec >= 1)) return { row: live ?? { count: 0, expiresAt: nowSec }, allowed: false };
  const count = live ? live.count : 0;
  const expiresAt = Math.max(live?.expiresAt ?? Number.NEGATIVE_INFINITY, nowSec + ttlSec);
  if (count >= max) return { row: { count, expiresAt }, allowed: false };
  return { row: { count: count + 1, expiresAt }, allowed: true };
}
