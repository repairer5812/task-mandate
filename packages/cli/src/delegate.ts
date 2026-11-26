import { readFile } from "node:fs/promises";
import path from "node:path";
import { type LeasePlan, nextRenewal, normalizePublicJwk, type Task } from "@task-mandate/core";
import { issueChunk, mandateWindow } from "./chunk.js";
import { type Flags, readJwk, readMaxActions, requireDuration, USAGE } from "./cli-shared.js";
import { createTask, taskHome } from "./task-files.js";
import { requireOrigin, type TaskRecord } from "./task-record.js";

export interface CreatedTask {
  taskId: string;
  outPath: string;
}

export async function createDelegation(values: Flags, home: string): Promise<CreatedTask> {
  const principalFile = values["principal-key"];
  const agentFile = values["agent-pub"];
  const site = values.site;
  const taskType = values.task;
  if (!principalFile || !agentFile || !site || !taskType) throw new Error(USAGE);
  const audience = requireOrigin(site);
  const forSec = requireDuration("--for", values.for);
  const chunkSec = requireDuration("--chunk", values.chunk ?? "10m");
  const maxActions = readMaxActions(values["max-actions"]);
  const task: Task = { type: taskType };
  if (values.resource) task.resource = values.resource;
  const principalKey = await readJwk(principalFile);
  const agentPublicKey = normalizePublicJwk(await readJwk(agentFile));
  const personAttestationPath = values["person-attestation"] ? path.resolve(values["person-attestation"]) : undefined;
  const personAttestation = personAttestationPath ? (await readFile(personAttestationPath, "utf8")).trim() : undefined;
  if (personAttestationPath && !personAttestation) throw new Error("person attestation is empty");
  const now = new Date();
  const taskId = crypto.randomUUID();
  const plan: LeasePlan = { taskId, start: now, end: new Date(now.getTime() + forSec * 1000), chunkSec };
  const step = nextRenewal(plan, now, undefined, false);
  if (!step.issue) throw new Error("could not issue the first chunk");
  const drafted: TaskRecord = {
    taskId,
    site: audience,
    task,
    ...(maxActions !== undefined ? { maxActions } : {}),
    start: plan.start.toISOString(),
    end: plan.end.toISOString(),
    chunkSec,
    outPath: values.out ? path.resolve(values.out) : path.join(path.resolve(home), taskId, "mandate.txt"),
    ...(personAttestationPath ? { personAttestationPath } : {}),
  };
  const token = await issueChunk({ principalKey, agentPublicKey, record: drafted, nbf: step.nbf, exp: step.exp, now, taskBegin: plan.start, ...(personAttestation ? { personAttestation } : {}) });
  const window = mandateWindow(token);
  const record: TaskRecord = { ...drafted, current: { nbf: window.nbf.toISOString(), exp: window.exp.toISOString() } };
  await createTask(home, record, { principal: principalKey, agent: agentPublicKey }, token);
  return { taskId, outPath: record.outPath };
}

/** Create a task directory and print the task id. */
export async function delegate(values: Flags, home = taskHome()): Promise<void> {
  const created = await createDelegation(values, home);
  process.stdout.write(`${created.taskId}\n`);
  process.stderr.write(`${created.outPath}\n`);
}
