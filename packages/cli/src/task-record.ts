import type { LeasePlan } from "@task-mandate/core";
import { isRecord } from "@task-mandate/core/internal";

export const DEFAULT_CHUNK = "10m";
export const TICK_MS = 30_000;

export interface TaskRecord {
  taskId: string;
  site: string;
  task: { type: string; resource?: string };
  maxActions?: number;
  start: string;
  end: string;
  chunkSec: number;
  outPath: string;
  current?: { nbf: string; exp: string };
  personAttestationPath?: string;
}

export type TaskPhase = "running" | "stopped" | "finished";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isTaskId(value: string): boolean {
  return TASK_ID.test(value);
}

export function assertTaskId(value: string): void {
  if (!isTaskId(value)) throw new Error("task id format is invalid");
}

export function requireOrigin(site: string): string {
  let url: URL;
  try {
    url = new URL(site);
  } catch {
    throw new Error("site must be an origin");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("site must be an http or https origin");
  if (url.origin !== site) throw new Error("site must be an origin with no path");
  return site;
}

export function durationSec(nbf: Date, exp: Date): number {
  const seconds = Math.floor(exp.getTime() / 1000) - Math.floor(nbf.getTime() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("chunk length is invalid");
  return seconds;
}

export function toPlan(record: TaskRecord): LeasePlan {
  return { taskId: record.taskId, start: new Date(record.start), end: new Date(record.end), chunkSec: record.chunkSec };
}

export function taskPhase(record: TaskRecord, stopped: boolean, now: Date): TaskPhase {
  const end = Date.parse(record.end);
  if (Number.isNaN(end)) throw new Error("task end is missing");
  if (now.getTime() >= end) return "finished";
  if (stopped) return "stopped";
  return "running";
}

export function formatTask(record: TaskRecord): string {
  return record.task.resource ? `${record.task.type} ${record.task.resource}` : record.task.type;
}

export function formatList(entries: { record: TaskRecord; stopped: boolean }[], now: Date): string {
  if (entries.length === 0) return "No tasks\n";
  return `${entries.map(({ record, stopped }) => [record.taskId, `Site: ${record.site}`, `Task: ${formatTask(record)}`, `Status: ${taskPhase(record, stopped, now)}`, `Task end: ${record.end}`, `Current chunk expiry: ${record.current?.exp ?? "-"}`].join("\n")).join("\n\n")}\n`;
}

export function formatStop(expIso: string | undefined): string {
  if (!expIso) return "No chunk has been issued\n";
  const exp = new Date(expIso);
  if (Number.isNaN(exp.getTime())) return "No chunk has been issued\n";
  return `Last chunk expires at ${exp.toISOString()}\n`;
}

export function parseTaskRecord(value: unknown): TaskRecord {
  if (!isRecord(value)) throw new Error("task state is invalid");
  const { taskId, site, task, start, end, chunkSec, outPath } = value;
  if (typeof taskId !== "string" || !isTaskId(taskId)) throw new Error("task state is invalid");
  if (typeof site !== "string" || site === "") throw new Error("task state is invalid");
  if (!isRecord(task) || typeof task.type !== "string" || task.type === "") throw new Error("task state is invalid");
  if (task.resource !== undefined && typeof task.resource !== "string") throw new Error("task state is invalid");
  if (typeof start !== "string" || start === "" || Number.isNaN(Date.parse(start))) {
    throw new Error("start time is missing. Create a new task with tm delegate.");
  }
  if (typeof end !== "string" || Number.isNaN(Date.parse(end))) throw new Error("task state is invalid");
  if (typeof chunkSec !== "number" || !Number.isFinite(chunkSec) || chunkSec < 1) throw new Error("task state is invalid");
  if (typeof outPath !== "string" || outPath === "") throw new Error("task state is invalid");
  let maxActions: number | undefined;
  if (value.maxActions !== undefined) {
    if (typeof value.maxActions !== "number" || !Number.isInteger(value.maxActions) || value.maxActions < 1) {
      throw new Error("task state is invalid");
    }
    maxActions = value.maxActions;
  }
  let personAttestationPath: string | undefined;
  if (value.personAttestationPath !== undefined) {
    if (typeof value.personAttestationPath !== "string" || value.personAttestationPath === "") throw new Error("task state is invalid");
    personAttestationPath = value.personAttestationPath;
  }
  let current: { nbf: string; exp: string } | undefined;
  if (value.current !== undefined) {
    if (!isRecord(value.current) || typeof value.current.nbf !== "string" || typeof value.current.exp !== "string") {
      throw new Error("task state is invalid");
    }
    if (Number.isNaN(Date.parse(value.current.nbf)) || Number.isNaN(Date.parse(value.current.exp))) {
      throw new Error("task state is invalid");
    }
    current = { nbf: value.current.nbf, exp: value.current.exp };
  }
  return { taskId, site, task: typeof task.resource === "string" ? { type: task.type, resource: task.resource } : { type: task.type }, start, end, chunkSec, outPath, ...(maxActions !== undefined ? { maxActions } : {}), ...(current ? { current } : {}), ...(personAttestationPath ? { personAttestationPath } : {}) };
}
