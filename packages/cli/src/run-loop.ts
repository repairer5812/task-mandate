import { readFile } from "node:fs/promises";
import { Renewer, type TickResult } from "@task-mandate/agent";
import { issueChunk, mandateWindow } from "./chunk.js";
import { isStopped, loadTask, saveIssued, withTaskLock } from "./task-files.js";
import { type TaskRecord, TICK_MS, toPlan } from "./task-record.js";

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

async function readPersonAttestation(file: string | undefined): Promise<string | undefined> {
  if (!file) return undefined;
  let text: string;
  try {
    text = (await readFile(file, "utf8")).trim();
  } catch (error) {
    if (missing(error)) throw new Error("person attestation file not found. Check the path.");
    throw error;
  }
  if (text === "") throw new Error("person attestation is empty");
  return text;
}

async function resumeFrom(record: TaskRecord): Promise<{ mandate: string; nbf: Date; exp: Date } | undefined> {
  let text: string;
  try {
    text = (await readFile(record.outPath, "utf8")).trim();
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (text === "") return undefined;
  const window = mandateWindow(text);
  return { mandate: text, nbf: window.nbf, exp: window.exp };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runLoop(options: { home: string; taskId: string; now?: () => Date; intervalMs?: number; sleep?: (ms: number) => Promise<void>; maxTicks?: number; onTick?: (result: TickResult) => void }): Promise<TickResult> {
  const now = options.now ?? (() => new Date());
  const wait = options.sleep ?? sleep;
  const intervalMs = options.intervalMs ?? TICK_MS;
  const loaded = await loadTask(options.home, options.taskId);
  const plan = toPlan(loaded.record);
  const handle: { renewer?: Renewer } = {};
  const renewer = new Renewer({
    plan,
    now,
    initial: await resumeFrom(loaded.record),
    issue: async ({ nbf, exp }) => {
      const personAttestation = await readPersonAttestation(loaded.record.personAttestationPath);
      const mandate = await issueChunk({ principalKey: loaded.principalKey, agentPublicKey: loaded.agentPublicKey, record: loaded.record, nbf, exp, now: now(), taskEnd: plan.end, taskBegin: plan.start, ...(personAttestation ? { personAttestation } : {}) });
      if (await isStopped(options.home, options.taskId)) handle.renewer?.stop();
      return mandate;
    },
    write: async (mandate) => {
      const window = mandateWindow(mandate);
      await saveIssued(options.home, options.taskId, window, loaded.record.outPath, `${mandate.trim()}\n`);
    },
  });
  handle.renewer = renewer;
  if (loaded.stopped) renewer.stop();

  let ticks = 0;
  let last: TickResult = "waiting";
  for (;;) {
    last = await withTaskLock(options.home, options.taskId, async () => {
      if (await isStopped(options.home, options.taskId)) renewer.stop();
      return renewer.tick();
    });
    options.onTick?.(last);
    ticks += 1;
    if (last === "stopped" || last === "finished") return last;
    if (options.maxTicks !== undefined && ticks >= options.maxTicks) return last;
    await wait(intervalMs);
  }
}
