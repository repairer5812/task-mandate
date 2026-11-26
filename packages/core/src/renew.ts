import { TaskMandateError } from "./error.js";

/** Whole-task window and chunk length used by renewal. */
export interface LeasePlan {
  taskId: string;
  start: Date;
  end: Date;
  chunkSec: number;
}

/** Whether to issue a chunk now, or the reason not to. */
export type RenewStep = { issue: true; nbf: Date; exp: Date } | { issue: false; reason: "not-started" | "waiting" | "finished" | "stopped" };

function time(date: Date, label: string): number {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TaskMandateError("INPUT_INVALID", `${label} must be a Date`);
  return date.getTime();
}

/** Next chunk window. Renewal applies the first matching rule. */
export function nextRenewal(plan: LeasePlan, now: Date, current: { nbf: Date; exp: Date } | undefined, stopped: boolean): RenewStep {
  if (!Number.isFinite(plan.chunkSec) || plan.chunkSec < 1) {
    throw new TaskMandateError("INPUT_INVALID", "chunkSec must be a finite number greater than or equal to 1");
  }
  const start = time(plan.start, "start");
  const end = time(plan.end, "end");
  const at = time(now, "now");
  if (end <= start) throw new TaskMandateError("INPUT_INVALID", "end must be after start");
  if (current) {
    time(current.nbf, "current.nbf");
    time(current.exp, "current.exp");
  }

  if (stopped) return { issue: false, reason: "stopped" };
  if (at >= end) return { issue: false, reason: "finished" };
  if (at < start) return { issue: false, reason: "not-started" };

  const halfMs = (plan.chunkSec * 1000) / 2;
  const remainingMs = current ? current.exp.getTime() - at : 0;
  if (current && remainingMs > halfMs) return { issue: false, reason: "waiting" };

  return { issue: true, nbf: new Date(at), exp: new Date(Math.min(at + plan.chunkSec * 1000, end)) };
}
