import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "../../core/test/helpers.js";
import { createDelegation } from "../src/delegate.js";
import { runLoop } from "../src/run-loop.js";
import { stopTask } from "../src/task-commands.js";
import { saveIssued, withTaskLock } from "../src/task-files.js";
import { formatStop, type TaskRecord } from "../src/task-record.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tm-lock-"));
  dirs.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function deadPid(): number {
  for (let pid = 1_000_000; pid < 1_010_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : "";
      if (code === "ESRCH") return pid;
    }
  }
  throw new Error("could not find an unused process id");
}

async function delegated(): Promise<{ home: string; taskId: string; out: string }> {
  const home = await tempDir();
  const principal = await ed25519();
  const agent = await ed25519();
  await writeFile(path.join(home, "me.json"), JSON.stringify(principal.priv));
  await writeFile(path.join(home, "agent.json"), JSON.stringify(agent.pub));
  const out = path.join(home, "current-mandate.txt");
  const created = await createDelegation({ "principal-key": path.join(home, "me.json"), "agent-pub": path.join(home, "agent.json"), site: "https://court.example", task: "watch", for: "1h", chunk: "1m", out }, home);
  return { home, taskId: created.taskId, out };
}

async function holdLock(home: string, taskId: string): Promise<string> {
  const lock = path.join(home, taskId, "lock");
  await mkdir(lock);
  await writeFile(path.join(lock, "pid"), `${process.pid}\n`);
  return lock;
}

describe("task lock", () => {
  it("does not steal a live lock even when it is old, and only takes a dead lock", async () => {
    const { home, taskId } = await delegated();
    const lock = await holdLock(home, taskId);
    let entered = false;
    const pending = withTaskLock(home, taskId, async () => {
      entered = true;
    });
    await delay(120);
    expect(entered).toBe(false);
    await rm(lock, { recursive: true, force: true });
    await pending;
    expect(entered).toBe(true);

    await mkdir(lock);
    await writeFile(path.join(lock, "pid"), `${deadPid()}\n`);
    let tookDead = false;
    await withTaskLock(home, taskId, async () => {
      tookDead = true;
    });
    expect(tookDead).toBe(true);

    await mkdir(lock);
    await writeFile(path.join(lock, "pid"), `${process.pid}\n`);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    let tookOld = false;
    await expect(
      withTaskLock(
        home,
        taskId,
        async () => {
          tookOld = true;
        },
        {
          staleMs: 30_000,
          sleep: async () => {
            throw new Error("waiting");
          },
        },
      ),
    ).rejects.toThrow("waiting");
    expect(tookOld).toBe(false);
    expect((await readFile(path.join(lock, "pid"), "utf8")).trim()).toBe(String(process.pid));
  });

  it("tm run ticks under the lock, and does not leave the lock behind on failure", async () => {
    const { home, taskId } = await delegated();
    const lock = await holdLock(home, taskId);
    let finished = false;
    const pending = runLoop({
      home,
      taskId,
      maxTicks: 1,
      sleep: async () => {
        throw new Error("waited");
      },
    }).then((result) => {
      finished = true;
      return result;
    });
    await delay(120);
    expect(finished).toBe(false);
    await rm(lock, { recursive: true, force: true });
    expect(await pending).toBe("waiting");

    const record = JSON.parse(await readFile(path.join(home, taskId, "task.json"), "utf8")) as TaskRecord;
    const exp = Date.parse(record.current!.exp);
    await writeFile(path.join(home, taskId, "principal.jwk"), "{}\n");
    await expect(
      runLoop({
        home,
        taskId,
        now: () => new Date(exp - 1_000),
        maxTicks: 1,
        sleep: async () => {
          throw new Error("waited");
        },
      }),
    ).rejects.toThrow();
    await expect(stat(path.join(home, taskId, "lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stop takes the lock after the stop mark, and prints the chunk expiry at that time", async () => {
    const { home, taskId } = await delegated();
    const before = JSON.parse(await readFile(path.join(home, taskId, "task.json"), "utf8")) as TaskRecord;
    const lock = await holdLock(home, taskId);
    const issuedExp = before.current!.exp;
    const newer = new Date(Date.parse(issuedExp) + 60_000).toISOString();
    const chunks: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    let done = false;
    const pending = stopTask(taskId, home).then(() => {
      done = true;
    });
    await delay(120);
    expect(done).toBe(false);
    expect(await readFile(path.join(home, taskId, "stopped"), "utf8")).toBe("");
    const updated: TaskRecord = { ...before, current: { nbf: before.current!.nbf, exp: newer } };
    await writeFile(path.join(home, taskId, "task.json"), `${JSON.stringify(updated, null, 2)}\n`);
    await rm(lock, { recursive: true, force: true });
    try {
      await pending;
    } finally {
      process.stdout.write = original;
    }
    expect(done).toBe(true);
    expect(chunks.join("")).toBe(formatStop(issuedExp));
    expect(chunks.join("")).not.toBe(formatStop(newer));
  });

  it("a failed output write does not change the state file", async () => {
    const { home, taskId, out } = await delegated();
    const before = JSON.parse(await readFile(path.join(home, taskId, "task.json"), "utf8")) as TaskRecord;
    const previous = await readFile(out, "utf8");
    const blocker = path.join(home, "not-a-directory");
    await writeFile(blocker, "x");
    const window = { nbf: new Date(before.current!.nbf), exp: new Date(Date.parse(before.current!.exp) + 60_000) };
    await expect(saveIssued(home, taskId, window, path.join(blocker, "mandate.txt"), "next-mandate\n")).rejects.toThrow();
    const after = JSON.parse(await readFile(path.join(home, taskId, "task.json"), "utf8")) as TaskRecord;
    expect(after.current?.exp).toBe(before.current?.exp);
    expect(await readFile(out, "utf8")).toBe(previous);
    expect((await stat(path.join(home, taskId, "task.json"))).mode & 0o777).toBe(0o600);
  });
});
