import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { writeSecret } from "./cli-basic.js";
import { assertTaskId, isTaskId, parseTaskRecord, type TaskRecord } from "./task-record.js";

const TASK_FILE = "task.json";
const PRINCIPAL_FILE = "principal.jwk";
const AGENT_FILE = "agent.pub.jwk";
const STOPPED_FILE = "stopped";
const LOCK_DIR = "lock";
const LOCK_PID = "pid";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_STALE_MS = 30_000;
const PID_GRACE_MS = 1_000;

export interface LoadedTask {
  record: TaskRecord;
  stopped: boolean;
  principalKey: JsonWebKey;
  agentPublicKey: JsonWebKey;
}

export function taskHome(env: NodeJS.ProcessEnv = process.env): string {
  const given = env.TM_HOME;
  if (typeof given === "string" && given !== "") return path.resolve(given);
  return path.join(homedir(), ".task-mandate");
}

function taskDir(home: string, taskId: string): string {
  assertTaskId(taskId);
  return path.join(path.resolve(home), taskId);
}

// The lock path is one path segment. Acceptance tests use short ids, not only UUIDs.
function lockHome(home: string, taskId: string): string {
  if (taskId === "" || taskId === "." || taskId === ".." || taskId.includes("/") || taskId.includes("\\")) {
    throw new Error("task id format is invalid");
  }
  return path.join(path.resolve(home), taskId);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await chmod(dir, DIR_MODE);
}

export async function atomicWrite(file: string, data: string, mode: number = FILE_MODE): Promise<void> {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(tmp, data, { encoding: "utf8", mode });
    await chmod(tmp, mode);
    await rename(tmp, target);
    await chmod(target, mode);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function parseJwk(text: string, label: string): JsonWebKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`could not read ${label}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`could not read ${label}`);
  return parsed as JsonWebKey;
}

export async function createTask(home: string, record: TaskRecord, keys: { principal: JsonWebKey; agent: JsonWebKey }, mandate: string): Promise<void> {
  const root = path.resolve(home);
  const dir = taskDir(home, record.taskId);
  await ensureDir(root);
  await ensureDir(dir);
  await writeSecret(path.join(dir, PRINCIPAL_FILE), json(keys.principal));
  await atomicWrite(path.join(dir, AGENT_FILE), json(keys.agent));
  await mkdir(path.dirname(path.resolve(record.outPath)), { recursive: true });
  await writeSecret(record.outPath, `${mandate.trim()}\n`);
  await atomicWrite(path.join(dir, TASK_FILE), json(record));
}

export async function readRecord(home: string, taskId: string): Promise<TaskRecord> {
  try {
    const text = await readFile(path.join(taskDir(home, taskId), TASK_FILE), "utf8");
    const record = parseTaskRecord(JSON.parse(text) as unknown);
    if (record.taskId !== taskId) throw new Error("task id does not match");
    return record;
  } catch (error) {
    if (isEnoent(error)) throw new Error(`task not found: ${taskId}`);
    throw error;
  }
}

export async function loadTask(home: string, taskId: string): Promise<LoadedTask> {
  const record = await readRecord(home, taskId);
  const dir = taskDir(home, taskId);
  return { record, stopped: await fileExists(path.join(dir, STOPPED_FILE)), principalKey: parseJwk(await readFile(path.join(dir, PRINCIPAL_FILE), "utf8"), "principal key"), agentPublicKey: parseJwk(await readFile(path.join(dir, AGENT_FILE), "utf8"), "agent key") };
}

export async function readTasks(home: string): Promise<{ record: TaskRecord; stopped: boolean }[]> {
  let names: string[];
  try {
    names = await readdir(home);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const found: { record: TaskRecord; stopped: boolean }[] = [];
  for (const name of names.sort()) {
    if (!isTaskId(name)) continue;
    const dir = path.join(path.resolve(home), name);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      const record = parseTaskRecord(JSON.parse(await readFile(path.join(dir, TASK_FILE), "utf8")) as unknown);
      if (record.taskId !== name) continue;
      found.push({ record, stopped: await fileExists(path.join(dir, STOPPED_FILE)) });
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
  }
  return found;
}

export async function markStopped(home: string, taskId: string): Promise<TaskRecord> {
  const record = await readRecord(home, taskId);
  await atomicWrite(path.join(taskDir(home, taskId), STOPPED_FILE), "");
  return record;
}

export async function isStopped(home: string, taskId: string): Promise<boolean> {
  assertTaskId(taskId);
  return fileExists(path.join(taskDir(home, taskId), STOPPED_FILE));
}

export async function saveCurrent(home: string, taskId: string, window: { nbf: Date; exp: Date }): Promise<void> {
  const record = await readRecord(home, taskId);
  const next: TaskRecord = { ...record, current: { nbf: window.nbf.toISOString(), exp: window.exp.toISOString() } };
  await atomicWrite(path.join(taskDir(home, taskId), TASK_FILE), json(next));
}

// Replace the output file first, then the state file. A failed output write leaves state unchanged.
export async function saveIssued(home: string, taskId: string, window: { nbf: Date; exp: Date }, outPath: string, mandate: string): Promise<void> {
  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await writeSecret(outPath, mandate);
  await saveCurrent(home, taskId, window);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

async function readLockPid(lockDir: string): Promise<number | undefined> {
  try {
    const text = (await readFile(path.join(lockDir, LOCK_PID), "utf8")).trim();
    if (!/^\d+$/.test(text)) return undefined;
    const pid = Number(text);
    return Number.isSafeInteger(pid) ? pid : undefined;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

async function lockIsStale(lockDir: string, staleMs: number): Promise<boolean> {
  let age: number;
  try {
    const info = await stat(lockDir);
    if (!info.isDirectory()) return true;
    age = Date.now() - info.mtimeMs;
  } catch (error) {
    if (isEnoent(error)) return true;
    throw error;
  }
  const pid = await readLockPid(lockDir);
  if (pid !== undefined) return !pidAlive(pid);
  return age >= Math.max(staleMs, PID_GRACE_MS);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Lock with mkdir. Remove a lock left by a dead process or an old timestamp.
export async function withTaskLock<T>(home: string, taskId: string, body: () => Promise<T>, opts?: { staleMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<T> {
  const dir = lockHome(home, taskId);
  const lockDir = path.join(dir, LOCK_DIR);
  const wait = opts?.sleep ?? sleep;
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  for (;;) {
    let created = false;
    try {
      await mkdir(lockDir);
      created = true;
      await chmod(lockDir, DIR_MODE);
      const pidPath = path.join(lockDir, LOCK_PID);
      await writeFile(pidPath, `${process.pid}\n`, { encoding: "utf8", mode: FILE_MODE });
      await chmod(pidPath, FILE_MODE);
      break;
    } catch (error) {
      if (created) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      if (!isErrno(error, "EEXIST")) throw error;
      if (await lockIsStale(lockDir, staleMs)) {
        const grave = path.join(dir, `.${LOCK_DIR}.${process.pid}.${crypto.randomUUID()}.stale`);
        try {
          await rename(lockDir, grave);
        } catch (renameError) {
          if (isEnoent(renameError)) continue;
          throw renameError;
        }
        await rm(grave, { recursive: true, force: true });
        continue;
      }
      await wait(50);
    }
  }
  try {
    return await body();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}
