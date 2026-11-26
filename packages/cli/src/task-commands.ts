import { readFile } from "node:fs/promises";
import { decodeMandateUnverified } from "@task-mandate/core";
import { CLAIM } from "@task-mandate/core/internal";
import { USAGE } from "./cli-shared.js";
import { runLoop } from "./run-loop.js";
import { markStopped, readRecord, readTasks, taskHome, withTaskLock } from "./task-files.js";
import { formatList, formatStop } from "./task-record.js";

async function outputExpIso(outPath: string): Promise<string | undefined> {
  try {
    const decoded = decodeMandateUnverified(await readFile(outPath, "utf8"));
    const exp = decoded?.payload[CLAIM.exp];
    if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
    return new Date(exp * 1000).toISOString();
  } catch {
    return undefined;
  }
}

/** Print tasks under the task home. */
export async function listTasks(home = taskHome()): Promise<void> {
  process.stdout.write(formatList(await readTasks(home), new Date()));
}

/** Mark a task stopped and print the current chunk `exp` as ISO 8601. */
export async function stopTask(taskId: string | undefined, home = taskHome()): Promise<void> {
  if (!taskId) throw new Error(USAGE);
  await markStopped(home, taskId);
  const record = await withTaskLock(home, taskId, () => readRecord(home, taskId));
  process.stdout.write(formatStop(await outputExpIso(record.outPath)));
}

/** Renew the task until it ends or is stopped. */
export async function runTask(taskId: string | undefined, home = taskHome()): Promise<void> {
  if (!taskId) throw new Error(USAGE);
  process.stderr.write(`renewal started ${taskId}\n`);
  const result = await runLoop({
    home,
    taskId,
    onTick: (step) => {
      if (step === "issued") process.stderr.write("issued a chunk\n");
    },
  });
  if (result === "finished") {
    process.stderr.write("finished\n");
    return;
  }
  if (result === "stopped") {
    const record = await readRecord(home, taskId);
    process.stderr.write(formatStop(record.current?.exp));
  }
}
