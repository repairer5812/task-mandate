import type { LeasePlan } from "@task-mandate/core";
import { Renewer } from "@task-mandate/node";
import { describe, expect, it } from "vitest";

const T0 = new Date("2026-12-01T00:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const plan: LeasePlan = { taskId: "task-1", start: T0, end: at(60), chunkSec: 600 };

function harness(now: () => Date, initial?: { mandate: string; nbf: Date; exp: Date }) {
  const written: string[] = [];
  let failWrite = false;
  let failIssue = false;
  const renewer = new Renewer({
    plan,
    now,
    ...(initial ? { initial } : {}),
    issue: async ({ nbf, exp }) => {
      if (failIssue) throw new Error("issue-failed");
      return `${nbf.toISOString()}|${exp.toISOString()}`;
    },
    write: async (mandate) => {
      if (failWrite) throw new Error("write-failed");
      written.push(mandate);
    },
  });
  return {
    renewer,
    written,
    setFailWrite(value: boolean) {
      failWrite = value;
    },
    setFailIssue(value: boolean) {
      failIssue = value;
    },
  };
}

describe("Renewer", () => {
  it("waits until half the time has passed, then issues", async () => {
    let now = T0;
    const { renewer, written } = harness(() => now);
    expect(await renewer.tick()).toBe("issued");
    expect(written).toEqual([`${T0.toISOString()}|${at(10).toISOString()}`]);
    now = at(4);
    expect(await renewer.tick()).toBe("waiting");
    expect(written).toHaveLength(1);
    now = at(5);
    expect(await renewer.tick()).toBe("issued");
    expect(renewer.current()).toBe(written[1]);
  });

  it("does not issue again when the existing chunk is still enough", async () => {
    const { renewer, written } = harness(() => T0, { mandate: "old", nbf: T0, exp: at(10) });
    expect(await renewer.tick()).toBe("waiting");
    expect(written).toEqual([]);
    expect(renewer.current()).toBe("old");
  });

  it("does not issue after stop", async () => {
    const { renewer, written } = harness(() => at(5), { mandate: "old", nbf: T0, exp: at(10) });
    renewer.stop();
    expect(await renewer.tick()).toBe("stopped");
    expect(written).toEqual([]);
    expect(renewer.current()).toBe("old");
  });

  it("does not write when issuance fails", async () => {
    const failed = harness(() => T0);
    failed.setFailIssue(true);
    await expect(failed.renewer.tick()).rejects.toThrow("issue-failed");
    expect(failed.written).toEqual([]);
    expect(failed.renewer.current()).toBeUndefined();
  });

  it("does not start the next issuance before the previous tick finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const renewer = new Renewer({
      plan,
      now: () => T0,
      issue: async () => {
        calls += 1;
        started();
        await gate;
        return "mandate";
      },
      write: async () => {},
    });
    const first = renewer.tick();
    await ready;
    const second = renewer.tick();
    const third = renewer.tick();
    expect(calls).toBe(1);
    release();
    expect(await Promise.all([first, second, third])).toEqual(["issued", "waiting", "waiting"]);
    expect(calls).toBe(1);
  });

  it("does not write a new mandate if stop happens while issuance is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const written: string[] = [];
    const renewer = new Renewer({
      plan,
      now: () => T0,
      issue: async () => {
        await gate;
        return "mandate";
      },
      write: async (mandate) => {
        written.push(mandate);
      },
    });
    const pending = renewer.tick();
    renewer.stop();
    release();
    expect(await pending).toBe("stopped");
    expect(written).toEqual([]);
    expect(renewer.current()).toBeUndefined();
  });

  it("keeps the last written mandate when the write fails", async () => {
    let now = T0;
    const { renewer, written, setFailWrite } = harness(() => now);
    expect(await renewer.tick()).toBe("issued");
    const kept = renewer.current();
    now = at(5);
    setFailWrite(true);
    await expect(renewer.tick()).rejects.toThrow("write-failed");
    expect(written).toHaveLength(1);
    expect(renewer.current()).toBe(kept);
    setFailWrite(false);
    expect(await renewer.tick()).toBe("issued");
    expect(renewer.current()).toBe(written[1]);
  });
});
