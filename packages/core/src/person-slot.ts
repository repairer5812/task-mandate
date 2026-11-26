// Person slot: the first matching rule wins. A slot is expired when expiresAt <= now.

/** A task displaced by a later one. Kept until expiry so its requests stay superseded. */
export interface DisplacedTask {
  taskKey: string;
  agentKeyId: string;
  expiresAt: number;
}

/** The one open task for this person. */
export interface OpenSlot {
  taskKey: string;
  agentKeyId: string;
  taskBegin: number;
  claimedAt: number;
  expiresAt: number;
}

/** Stored person slot. `displaced` is kept so a repeat of the same task stays superseded. */
export interface PersonState {
  current?: OpenSlot;
  displaced: DisplacedTask[];
}

/** Input for one person-slot claim. Times are seconds. */
export interface SlotClaim {
  taskKey: string;
  agentKeyId: string;
  taskBegin: number;
  expiresAt: number;
  now: number;
  minSwitchSec: number;
}

function alive<T extends { expiresAt: number }>(item: T, now: number): boolean {
  return item.expiresAt > now;
}

/** Drop expired slots. Returns the same object when nothing changed, so a timer does not rewrite a live row. */
export function prunePersonState(state: PersonState, now: number): PersonState | undefined {
  const displaced = state.displaced.filter((item) => alive(item, now));
  const current = state.current && alive(state.current, now) ? state.current : undefined;
  if (!current && displaced.length === 0) return undefined;
  const displacedSame = displaced.length === state.displaced.length && displaced.every((item, index) => item === state.displaced[index]);
  if (displacedSame && current === state.current) return state;
  return current ? { current, displaced } : { displaced };
}

function samePair(left: { taskKey: string; agentKeyId: string }, right: { taskKey: string; agentKeyId: string }): boolean {
  return left.taskKey === right.taskKey && left.agentKeyId === right.agentKeyId;
}

/** Apply one claim. `superseded` means this person already has another live task. */
export function applyPersonClaim(state: PersonState | undefined, input: SlotClaim): { state: PersonState; result: "ok" | "superseded" } {
  const displaced = (state?.displaced ?? []).filter((item) => alive(item, input.now));
  const current = state?.current && alive(state.current, input.now) ? state.current : undefined;
  const kept = (slot?: OpenSlot): PersonState => (slot ? { current: slot, displaced } : { displaced });

  if (displaced.some((item) => samePair(item, input))) return { state: kept(current), result: "superseded" };
  if (!current) {
    return { state: { displaced, current: { taskKey: input.taskKey, agentKeyId: input.agentKeyId, taskBegin: input.taskBegin, claimedAt: input.now, expiresAt: input.expiresAt } }, result: "ok" };
  }
  if (samePair(current, input) && current.taskBegin === input.taskBegin) {
    return { state: { displaced, current: { ...current, expiresAt: Math.max(current.expiresAt, input.expiresAt) } }, result: "ok" };
  }
  const pairDiffers = !samePair(current, input);
  if (pairDiffers && input.taskBegin > current.taskBegin && input.now - current.claimedAt >= input.minSwitchSec) {
    return {
      state: { displaced: [...displaced, { taskKey: current.taskKey, agentKeyId: current.agentKeyId, expiresAt: current.expiresAt }], current: { taskKey: input.taskKey, agentKeyId: input.agentKeyId, taskBegin: input.taskBegin, claimedAt: input.now, expiresAt: Math.max(current.expiresAt, input.expiresAt) } },
      result: "ok",
    };
  }
  return { state: kept(current), result: "superseded" };
}
