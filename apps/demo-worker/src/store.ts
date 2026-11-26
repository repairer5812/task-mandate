import { DurableObject } from "cloudflare:workers";
import type { PersonSlotClaim } from "@task-mandate/core";
import { digestKey } from "@task-mandate/core/internal";
import type { CivilLogEntry, SeatResult } from "@task-mandate/demo-site";
import { seatResetSec } from "./config";
import type { Env } from "./env";
import { hitSimWindow, takeSimBudget as writeSimBudget } from "./sim-sql";
import { appendCivilLog, armSeatReset, claimNonce, claimPersonSlot, clearRecords, clearSeatReset, consumeAction, ensureSchema, hitCivilLimit, listSeats, nextAlarmAt, purgeExpired, recentCivilLog, refundAction, restoreSeatsIfDue, type Sql, seedSeats, takeSeat, releaseSeat as undoSeat } from "./sql-store";

export class MandateStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ensureSchema(this.sql);
      seedSeats(this.sql, env.SEATS, false);
      await this.syncAlarm(Date.now());
    });
  }

  private get sql(): Sql {
    return this.ctx.storage.sql as unknown as Sql;
  }

  // blockConcurrencyWhile keeps the read and the write one unit even if the request awaits.
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(() => run());
  }

  private async syncAlarm(nowMs: number): Promise<void> {
    const next = nextAlarmAt(this.sql, nowMs);
    if (next === undefined) {
      if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(next);
  }

  claimNonce(nonce: string, ttlSec: number): Promise<boolean> {
    return this.exclusive(async () => {
      const ok = claimNonce(this.sql, await digestKey(nonce), ttlSec, Date.now());
      await this.syncAlarm(Date.now());
      return ok;
    });
  }

  consumeAction(key: string, max: number, ttlSec: number): Promise<boolean> {
    return this.exclusive(async () => {
      const stored = await digestKey(key);
      const ok = consumeAction(this.sql, stored, max, ttlSec, Date.now());
      try {
        await this.syncAlarm(Date.now());
      } catch (error) {
        if (ok) refundAction(this.sql, stored, Date.now());
        throw error;
      }
      return ok;
    });
  }

  refundAction(key: string): Promise<void> {
    return this.exclusive(async () => {
      refundAction(this.sql, await digestKey(key), Date.now());
      await this.syncAlarm(Date.now());
    });
  }

  claimPersonSlot(input: PersonSlotClaim): Promise<"ok" | "superseded"> {
    return this.exclusive(async () => {
      const stored = { ...input, personKey: await digestKey(input.personKey), taskKey: await digestKey(input.taskKey) };
      const result = claimPersonSlot(this.sql, stored);
      await this.syncAlarm(Date.now());
      return result;
    });
  }

  listSeats(): Promise<Record<string, number>> {
    return this.exclusive(async () => listSeats(this.sql));
  }

  takeSeat(facility: string): Promise<SeatResult> {
    return this.exclusive(async () => {
      const result = takeSeat(this.sql, facility);
      if (result.status !== "ok") return result;
      try {
        armSeatReset(this.sql, Date.now(), seatResetSec(this.env.SEAT_RESET_SEC));
        await this.syncAlarm(Date.now());
        return result;
      } catch (error) {
        undoSeat(this.sql, facility);
        throw error;
      }
    });
  }

  releaseSeat(facility: string): Promise<void> {
    return this.exclusive(async () => {
      undoSeat(this.sql, facility);
    });
  }

  reset(): Promise<void> {
    return this.exclusive(async () => {
      clearRecords(this.sql);
      clearSeatReset(this.sql);
      seedSeats(this.sql, this.env.SEATS, true);
      await this.syncAlarm(Date.now());
    });
  }

  // Finish the hash outside the storage transaction. Window deletion and the count increment are synchronous SQL with no await,
  // so they apply as one unit without blockConcurrencyWhile. Do not set an alarm.
  async hitCivil(key: string, nowMs: number, limit: number, windowSec: number): Promise<boolean> {
    const stored = await digestKey(key);
    return this.ctx.storage.transactionSync(() => hitCivilLimit(this.sql, stored, nowMs, limit, windowSec));
  }

  // Sim quotas use the same pattern. Finish the hash outside the transaction. The table update is synchronous SQL with no await.
  async hitSimLlm(key: string, nowMs: number, limit: number, windowSec: number): Promise<boolean> {
    const stored = await digestKey(key);
    return this.ctx.storage.transactionSync(() => hitSimWindow(this.sql, "sim_llm_limit", stored, nowMs, limit, windowSec));
  }

  async hitSimAttest(key: string, nowMs: number, limit: number, windowSec: number): Promise<boolean> {
    const stored = await digestKey(key);
    return this.ctx.storage.transactionSync(() => hitSimWindow(this.sql, "sim_attest_limit", stored, nowMs, limit, windowSec));
  }

  takeSimBudget(dayKey: string, max: number): Promise<boolean> {
    return Promise.resolve(this.ctx.storage.transactionSync(() => writeSimBudget(this.sql, dayKey, max)));
  }

  // Log reads and writes do not take the exclusive lock. Do not set an alarm.
  appendCivil(entry: CivilLogEntry): Promise<void> {
    appendCivilLog(this.sql, entry);
    return Promise.resolve();
  }

  recentCivil(): Promise<CivilLogEntry[]> {
    return Promise.resolve(recentCivilLog(this.sql));
  }

  async alarm(): Promise<void> {
    // Alarm events already run one at a time. Locking again here would nest.
    const nowMs = Date.now();
    purgeExpired(this.sql, nowMs);
    restoreSeatsIfDue(this.sql, this.env.SEATS, nowMs);
    await this.syncAlarm(nowMs);
  }
}
