import { decodeMandateUnverified, issueMandate, type Task } from "@task-mandate/core";
import { CLAIM } from "@task-mandate/core/internal";
import { durationSec, type TaskRecord } from "./task-record.js";

export async function issueChunk(input: { principalKey: JsonWebKey; agentPublicKey: JsonWebKey; record: Pick<TaskRecord, "taskId" | "site" | "task" | "maxActions" | "end">; nbf: Date; exp: Date; now: Date; taskEnd?: Date; taskBegin?: Date; personAttestation?: string }): Promise<string> {
  const task: Task = input.record.task.resource !== undefined ? { type: input.record.task.type, resource: input.record.task.resource } : { type: input.record.task.type };
  return issueMandate({
    principalKey: input.principalKey,
    agentPublicKey: input.agentPublicKey,
    audience: input.record.site,
    task,
    ...(input.record.maxActions !== undefined ? { limits: { maxActions: input.record.maxActions } } : {}),
    taskId: input.record.taskId,
    taskEnd: input.taskEnd ?? new Date(input.record.end),
    ...(input.taskBegin !== undefined ? { taskBegin: input.taskBegin } : {}),
    ...(input.personAttestation !== undefined ? { personAttestation: input.personAttestation } : {}),
    notBefore: input.nbf,
    durationSec: durationSec(input.nbf, input.exp),
    now: input.now,
  });
}

export function mandateWindow(token: string): { nbf: Date; exp: Date } {
  const payload = decodeMandateUnverified(token)?.payload;
  const nbf = payload?.[CLAIM.nbf];
  const exp = payload?.[CLAIM.exp];
  if (typeof nbf !== "number" || typeof exp !== "number") throw new Error("could not read the issued mandate");
  return { nbf: new Date(nbf * 1000), exp: new Date(exp * 1000) };
}
