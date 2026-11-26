import { advanceAction } from "./action.js";
import { applyPersonClaim, type PersonState, prunePersonState } from "./person-slot.js";
import type { PersonSlotClaim, Store } from "./types.js";

interface Timed {
  count: number;
  expiresAt: number;
}

/** `Store` plus a size snapshot used by the lab. */
export interface MemoryStore extends Store {
  size(): { nonces: number; actions: number; people: number };
}

/** SHA-256 hex of a store key. Callers use this so raw ids are not the map key. */
export async function digestKey(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function slotOf(input: PersonSlotClaim, taskKey: string) {
  return { taskKey, agentKeyId: input.agentKeyId, taskBegin: input.taskBegin, expiresAt: input.expiresAt, now: input.now, minSwitchSec: input.minSwitchSec };
}

/** In-memory store for tests and demos. `now` is the clock used for expiry. */
export function memoryStore(opts?: { now?: () => Date }): MemoryStore {
  const nonces = new Map<string, number>();
  const actions = new Map<string, Timed>();
  const people = new Map<string, PersonState>();
  const clock = opts?.now ?? (() => new Date());

  function purgeNoncesAndActions(nowMs: number): void {
    for (const [key, expiresAt] of nonces) {
      if (expiresAt <= nowMs) nonces.delete(key);
    }
    for (const [key, row] of actions) {
      if (row.expiresAt <= nowMs) actions.delete(key);
    }
  }

  function purgePeople(nowSec: number): void {
    for (const [key, state] of people) {
      const pruned = prunePersonState(state, nowSec);
      if (!pruned) people.delete(key);
      else if (pruned !== state) people.set(key, pruned);
    }
  }

  return {
    async claimNonce(nonce, ttlSec) {
      const stored = await digestKey(nonce);
      const now = clock().getTime();
      purgeNoncesAndActions(now);
      const expiresAt = nonces.get(stored);
      if (expiresAt !== undefined && expiresAt > now) return false;
      nonces.set(stored, now + ttlSec * 1000);
      return true;
    },
    // No await after the digest. A gap between the check and the increment lets concurrent requests pass the cap.
    async consumeAction(key, max, ttlSec) {
      const stored = await digestKey(key);
      const nowMs = clock().getTime();
      purgeNoncesAndActions(nowMs);
      const nowSec = Math.floor(nowMs / 1000);
      const current = actions.get(stored);
      const live = current !== undefined && current.expiresAt > nowMs ? current : undefined;
      const next = advanceAction(live ? { count: live.count, expiresAt: Math.floor(live.expiresAt / 1000) } : undefined, nowSec, max, ttlSec);
      const expiresMs = next.row.expiresAt * 1000;
      if (!next.allowed) {
        if (live && expiresMs > live.expiresAt) actions.set(stored, { count: live.count, expiresAt: expiresMs });
        return false;
      }
      actions.set(stored, { count: next.row.count, expiresAt: expiresMs });
      return true;
    },
    async refundAction(key) {
      const stored = await digestKey(key);
      const now = clock().getTime();
      purgeNoncesAndActions(now);
      const row = actions.get(stored);
      if (!row || row.expiresAt <= now || row.count <= 0) return;
      if (row.count === 1) actions.delete(stored);
      else actions.set(stored, { count: row.count - 1, expiresAt: row.expiresAt });
    },
    // No await after the digest. A gap between the read and the write lets one person open two tasks.
    async claimPersonSlot(input) {
      const personKey = await digestKey(input.personKey);
      const taskKey = await digestKey(input.taskKey);
      const existing = people.get(personKey);
      const pruned = existing ? prunePersonState(existing, input.now) : undefined;
      if (existing && !pruned) people.delete(personKey);
      else if (pruned && pruned !== existing) people.set(personKey, pruned);
      const next = applyPersonClaim(pruned, slotOf(input, taskKey));
      people.set(personKey, next.state);
      return next.result;
    },
    size() {
      const nowMs = clock().getTime();
      purgeNoncesAndActions(nowMs);
      purgePeople(Math.floor(nowMs / 1000));
      return { nonces: nonces.size, actions: actions.size, people: people.size };
    },
  };
}
