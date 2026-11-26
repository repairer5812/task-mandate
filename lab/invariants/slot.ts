// Re-apply the person-slot rules to allow records only. Does not call a store.
interface Slot {
  taskKey: string;
  agentKeyId: string;
  taskBegin: number;
  claimedAt: number;
  expiresAt: number;
}

interface Displaced {
  taskKey: string;
  agentKeyId: string;
  expiresAt: number;
}

interface State {
  current?: Slot;
  displaced: Displaced[];
}

export interface SlotInput {
  personKey: string;
  taskKey: string;
  agentKeyId: string;
  taskBegin: number;
  expiresAt: number;
  now: number;
  minSwitchSec: number;
}

export function createSlotBook() {
  const people = new Map<string, State>();
  return {
    allow(input: SlotInput): string | undefined {
      const state = people.get(input.personKey) ?? { displaced: [] };
      const displaced = state.displaced.filter((row) => row.expiresAt > input.now);
      const current = state.current && state.current.expiresAt > input.now ? state.current : undefined;
      if (displaced.some((row) => row.taskKey === input.taskKey && row.agentKeyId === input.agentKeyId)) {
        people.set(input.personKey, { current, displaced });
        return "a displaced task was allowed again";
      }
      if (!current) {
        people.set(input.personKey, { current: open(input), displaced });
        return undefined;
      }
      if (current.taskKey === input.taskKey && current.agentKeyId === input.agentKeyId && current.taskBegin === input.taskBegin) {
        people.set(input.personKey, { current: { ...current, expiresAt: Math.max(current.expiresAt, input.expiresAt) }, displaced });
        return undefined;
      }
      const switched = (current.taskKey !== input.taskKey || current.agentKeyId !== input.agentKeyId) && input.taskBegin > current.taskBegin && input.now - current.claimedAt >= input.minSwitchSec;
      if (switched) {
        displaced.push({ taskKey: current.taskKey, agentKeyId: current.agentKeyId, expiresAt: current.expiresAt });
        people.set(input.personKey, { current: { ...open(input), expiresAt: Math.max(current.expiresAt, input.expiresAt) }, displaced });
        return undefined;
      }
      people.set(input.personKey, { current, displaced });
      return "overlapping tasks for one person at one site";
    },
  };
}

function open(input: SlotInput): Slot {
  return { taskKey: input.taskKey, agentKeyId: input.agentKeyId, taskBegin: input.taskBegin, claimedAt: input.now, expiresAt: input.expiresAt };
}
