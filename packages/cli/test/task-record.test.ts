import { describe, expect, it } from "vitest";
import { formatList, formatStop, isTaskId, parseTaskRecord, requireOrigin, type TaskRecord, taskPhase } from "../src/task-record.js";

const record: TaskRecord = {
  taskId: "00000000-0000-4000-8000-000000000001",
  site: "https://court.example",
  task: { type: "watch-and-reserve", resource: "court-3" },
  start: "2026-12-01T00:00:00.000Z",
  end: "2026-12-01T01:00:00.000Z",
  chunkSec: 60,
  outPath: "/tmp/mandate.txt",
  current: { nbf: "2026-12-01T00:00:00.000Z", exp: "2026-12-01T00:01:00.000Z" },
};

describe("task status", () => {
  it("picks the status in the order ended, stopped, running", () => {
    expect(taskPhase(record, false, new Date("2026-12-01T00:30:00.000Z"))).toBe("running");
    expect(taskPhase(record, true, new Date("2026-12-01T00:30:00.000Z"))).toBe("stopped");
    expect(taskPhase(record, false, new Date("2026-12-01T01:00:00.000Z"))).toBe("finished");
    expect(taskPhase(record, true, new Date("2026-12-01T01:00:00.000Z"))).toBe("finished");
  });

  it("says there is none when the list is empty, and the stop line is ISO 8601", () => {
    expect(formatList([], new Date("2026-12-01T00:00:00.000Z"))).toBe("No tasks\n");
    expect(formatStop(record.current?.exp)).toBe("Last chunk expires at 2026-12-01T00:01:00.000Z\n");
    expect(formatStop(undefined)).toBe("No chunk has been issued\n");
  });

  it("checks the task id, origin, and status file", () => {
    expect(isTaskId(crypto.randomUUID())).toBe(true);
    expect(isTaskId("../x")).toBe(false);
    expect(isTaskId("task-1")).toBe(false);
    expect(requireOrigin("https://court.example")).toBe("https://court.example");
    expect(() => requireOrigin("https://court.example/reserve")).toThrow(/origin/);
    expect(() => parseTaskRecord({ ...record, chunkSec: 0 })).toThrow(/invalid/);
    expect(() => parseTaskRecord({ ...record, maxActions: 0 })).toThrow(/invalid/);
    expect(() => parseTaskRecord({ ...record, start: undefined })).toThrow(/tm delegate/);
    const text = formatList([{ record, stopped: false }], new Date("2026-12-01T00:30:00.000Z"));
    expect(text).toContain("Status: running");
    expect(text).toContain("watch-and-reserve court-3");
    expect(text).toContain("https://court.example");
  });
});
