import { type LeasePlan, nextRenewal } from "@task-mandate/core";
import { describe, expect, it } from "vitest";

const T0 = new Date("2026-12-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const plan = (over: Partial<LeasePlan> = {}): LeasePlan => ({ taskId: "task-1", start: T0, end: at(60 * 60_000), chunkSec: 600, ...over });

describe("nextRenewal boundaries", () => {
  it("issues at the same time as start, and is done at the same time as end", () => {
    expect(nextRenewal(plan({ start: at(10 * 60_000) }), at(10 * 60_000), undefined, false)).toEqual({ issue: true, nbf: at(10 * 60_000), exp: at(20 * 60_000) });
    expect(nextRenewal(plan(), at(60 * 60_000), undefined, false)).toEqual({ issue: false, reason: "finished" });
  });

  it("waits when the time left is 1ms more than half, and issues at half", () => {
    const short = plan({ chunkSec: 10, end: at(60_000) });
    expect(nextRenewal(short, T0, { nbf: T0, exp: at(5_001) }, false)).toEqual({ issue: false, reason: "waiting" });
    expect(nextRenewal(short, T0, { nbf: T0, exp: at(5_000) }, false)).toEqual({ issue: true, nbf: T0, exp: at(10_000) });
  });

  it("reissues a chunk that has already passed, and cuts a length past the task end down to the end", () => {
    const end = at(1_500);
    expect(nextRenewal(plan({ chunkSec: 10, end: at(60_000) }), at(20_000), { nbf: T0, exp: at(10_000) }, false)).toEqual({ issue: true, nbf: at(20_000), exp: at(30_000) });
    expect(nextRenewal(plan({ end, chunkSec: 10 }), T0, undefined, false)).toEqual({ issue: true, nbf: T0, exp: end });
  });

  it("stop comes before the end and before the start", () => {
    expect(nextRenewal(plan(), at(60 * 60_000), undefined, true)).toEqual({ issue: false, reason: "stopped" });
    expect(nextRenewal(plan({ start: at(10_000) }), T0, undefined, true)).toEqual({ issue: false, reason: "stopped" });
  });

  it("chunkSec of 1 is allowed, and below 1 or an end earlier than start is an error", () => {
    expect(nextRenewal(plan({ chunkSec: 1, end: at(5_000) }), T0, undefined, false).issue).toBe(true);
    expect(() => nextRenewal(plan({ chunkSec: 0.999 }), T0, undefined, false)).toThrow(/chunkSec/);
    expect(() => nextRenewal(plan({ chunkSec: Number.NaN }), T0, undefined, false)).toThrow(/chunkSec/);
    expect(() => nextRenewal(plan({ end: T0 }), T0, undefined, false)).toThrow(/end/);
    expect(() => nextRenewal(plan({ end: at(-1) }), T0, undefined, false)).toThrow(/end/);
    expect(() => nextRenewal(plan({ start: new Date(Number.NaN) }), T0, undefined, false)).toThrow(/start/);
  });
});
