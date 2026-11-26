import { memoryStore } from "@task-mandate/core";
import { applyPersonClaim, type PersonState, prunePersonState, type SlotClaim } from "@task-mandate/core/internal";
import { describe, expect, it } from "vitest";

function claim(over: Partial<SlotClaim> = {}): SlotClaim {
  return { taskKey: "task-a", agentKeyId: "agent-a", taskBegin: 1000, expiresAt: 5000, now: 1000, minSwitchSec: 600, ...over };
}

describe("claimPersonSlot rules", () => {
  it("an empty slot and an expired slot are taken by a new task", async () => {
    const store = memoryStore({ now: () => new Date(0) });
    expect(await store.claimPersonSlot({ personKey: "p", ...claim() })).toBe("ok");
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ now: 5000, taskKey: "task-b", taskBegin: 500 }) })).toBe("ok");
  });

  it("the same task only pushes expiry later and keeps the claimed time", async () => {
    const store = memoryStore({ now: () => new Date(0) });
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ expiresAt: 2000 }) })).toBe("ok");
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ now: 1500, expiresAt: 9000 }) })).toBe("ok");
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ now: 1600, taskKey: "task-b", taskBegin: 1600 }) })).toBe("ok");
    const fresh = memoryStore({ now: () => new Date(0) });
    expect(await fresh.claimPersonSlot({ personKey: "p", ...claim({ expiresAt: 9000 }) })).toBe("ok");
    expect(await fresh.claimPersonSlot({ personKey: "p", ...claim({ now: 1500, expiresAt: 9000 }) })).toBe("ok");
    expect(await fresh.claimPersonSlot({ personKey: "p", ...claim({ now: 1599, taskKey: "task-b", taskBegin: 2000 }) })).toBe("superseded");
  });

  it("a later task past the switch interval takes the slot, and a shorter expiry does not shrink it", async () => {
    const store = memoryStore({ now: () => new Date(0) });
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ expiresAt: 5000 }) })).toBe("ok");
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ now: 1600, taskKey: "task-b", agentKeyId: "agent-b", taskBegin: 1600, expiresAt: 1700 }) })).toBe("ok");
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ now: 1800, taskKey: "task-a" }) })).toBe("superseded");
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ now: 1800, taskKey: "task-c", taskBegin: 1000 }) })).toBe("superseded");
  });

  it("a new task with the same start, a different agent, and before the interval is blocked", async () => {
    const store = memoryStore({ now: () => new Date(0) });
    expect(await store.claimPersonSlot({ personKey: "p", ...claim() })).toBe("ok");
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ agentKeyId: "agent-b" }) })).toBe("superseded");
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ now: 2000, taskKey: "task-b", taskBegin: 1000 }) })).toBe("superseded");
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ now: 2000, taskBegin: 2000 }) })).toBe("superseded");
    expect(await store.claimPersonSlot({ personKey: "p", ...claim() })).toBe("ok");
  });

  it("only one slot opens when two tasks arrive at the same time", async () => {
    const store = memoryStore({ now: () => new Date(0) });
    const results = await Promise.all([store.claimPersonSlot({ personKey: "p", ...claim({ taskKey: "task-a" }) }), store.claimPersonSlot({ personKey: "p", ...claim({ taskKey: "task-b", taskBegin: 1001 }) })]);
    expect(results).toEqual(["ok", "superseded"]);
  });

  it("deletes a displaced task when it expires, and accepts that task again once the slot itself expires", async () => {
    const store = memoryStore({ now: () => new Date(0) });
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ expiresAt: 1500, minSwitchSec: 100 }) })).toBe("ok");
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ now: 1200, taskKey: "task-b", taskBegin: 1200, expiresAt: 1400, minSwitchSec: 100 }) })).toBe("ok");
    expect(await store.claimPersonSlot({ personKey: "p", ...claim({ now: 1500, expiresAt: 4000, minSwitchSec: 100 }) })).toBe("ok");
  });
});

describe("displaced task cleanup", () => {
  it("an expired displaced task is absent from the next call's list, and before expiry rule 1 comes before rule 2", () => {
    const first = applyPersonClaim(undefined, claim({ expiresAt: 1500 }));
    const switched = applyPersonClaim(first.state, claim({ now: 1200, taskKey: "task-b", taskBegin: 1200, expiresAt: 5000, minSwitchSec: 100 }));
    expect(switched.state.displaced.map((item) => item.taskKey)).toEqual(["task-a"]);
    const later = applyPersonClaim(switched.state, claim({ now: 1600, taskKey: "task-a", taskBegin: 1000, expiresAt: 9000 }));
    expect(later.result).toBe("superseded");
    expect(later.state.displaced).toEqual([]);
    expect(later.state.current?.taskKey).toBe("task-b");

    const crafted: PersonState = { current: { taskKey: "task-b", agentKeyId: "agent-a", taskBegin: 2, claimedAt: 1000, expiresAt: 1100 }, displaced: [{ taskKey: "task-a", agentKeyId: "agent-a", expiresAt: 2000 }] };
    const blocked = applyPersonClaim(crafted, claim({ now: 1500, taskBegin: 1, expiresAt: 3000 }));
    expect(blocked.result).toBe("superseded");
    expect(blocked.state.current).toBeUndefined();
    expect(blocked.state.displaced.map((item) => item.taskKey)).toEqual(["task-a"]);
  });
});

describe("prunePersonState", () => {
  it("deletes an expired slot and displaced tasks, and returns undefined when nothing is left", () => {
    const state: PersonState = { current: { taskKey: "task-b", agentKeyId: "agent-a", taskBegin: 2, claimedAt: 1000, expiresAt: 1500 }, displaced: [{ taskKey: "task-a", agentKeyId: "agent-a", expiresAt: 1400 }] };
    expect(prunePersonState(state, 1400)?.displaced).toEqual([]);
    expect(prunePersonState(state, 1400)?.current?.taskKey).toBe("task-b");
    expect(prunePersonState(state, 1500)).toBeUndefined();
  });
});
