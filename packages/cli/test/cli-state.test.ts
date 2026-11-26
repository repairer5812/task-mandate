import { execFile } from "node:child_process";
import { chmod, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMandateUnverified } from "@task-mandate/core";
import { CLAIM } from "@task-mandate/core/internal";
import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "../../core/test/helpers.js";
import { writeSecret } from "../src/cli-basic.js";
import { createDelegation } from "../src/delegate.js";
import { runLoop } from "../src/run-loop.js";
import { markStopped, readRecord } from "../src/task-files.js";
import { formatStop } from "../src/task-record.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bin = path.join(root, "packages/cli/dist/cli.js");
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tm-home-"));
  dirs.push(dir);
  return dir;
}

function modeOf(file: string): Promise<number> {
  return stat(file).then((info) => info.mode & 0o777);
}

function tm(home: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [bin, ...args], { cwd: root, env: { ...process.env, TM_HOME: home }, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

describe("secret file", () => {
  it("overwriting an existing 644 file still leaves 600, and the secret is not written to that file", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "secret.txt");
    await writeFile(file, "old\n", { mode: 0o644 });
    await chmod(file, 0o644);
    const oldHandle = await open(file, "r");
    try {
      const before = await oldHandle.stat();
      expect(before.mode & 0o777).toBe(0o644);
      const secret = "secret-value\n";
      const previous = process.umask(0);
      try {
        await writeSecret(file, secret);
      } finally {
        process.umask(previous);
      }
      const after = await stat(file);
      expect(after.mode & 0o777).toBe(0o600);
      expect(after.ino).not.toBe(before.ino);
      const kept = await oldHandle.stat();
      expect(kept.ino).toBe(before.ino);
      expect(kept.mode & 0o777).toBe(0o644);
      const buf = Buffer.alloc(64);
      const { bytesRead } = await oldHandle.read(buf, 0, buf.length, 0);
      const oldText = buf.subarray(0, bytesRead).toString("utf8");
      expect(oldText).toBe("old\n");
      expect(oldText.includes("secret-value")).toBe(false);
      expect(await readFile(file, "utf8")).toBe(secret);
      expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await oldHandle.close();
    }
  });
});

describe("CLI state file", () => {
  it("delegate stores the private key as 600, and does not renew when enough time remains", async () => {
    const home = await tempDir();
    const principal = await ed25519();
    const agent = await ed25519();
    const principalFile = path.join(home, "me.json");
    const agentFile = path.join(home, "agent.json");
    await writeFile(principalFile, JSON.stringify({ ...principal.priv, d: principal.priv.d }));
    await writeFile(agentFile, JSON.stringify({ ...agent.priv, d: agent.priv.d }));
    const out = path.join(home, "current-mandate.txt");
    const created = await createDelegation({ "principal-key": principalFile, "agent-pub": agentFile, site: "https://court.example", task: "watch-and-reserve", resource: "court-3", for: "1h", chunk: "1m", out }, home);
    const record = await readRecord(home, created.taskId);
    expect(record.chunkSec).toBe(60);
    expect(record.outPath).toBe(out);
    expect(record.task).toEqual({ type: "watch-and-reserve", resource: "court-3" });
    expect(await modeOf(path.join(home, created.taskId, "principal.jwk"))).toBe(0o600);
    expect(await modeOf(out)).toBe(0o600);
    const names = await readdir(path.join(home, created.taskId));
    expect(names.some((name) => name.includes(".tmp"))).toBe(false);
    const taskJson = await readFile(path.join(home, created.taskId, "task.json"), "utf8");
    expect(taskJson).not.toContain('"d"');
    const storedAgent = JSON.parse(await readFile(path.join(home, created.taskId, "agent.pub.jwk"), "utf8")) as JsonWebKey;
    expect(storedAgent.d).toBeUndefined();
    expect(storedAgent.x).toBe(agent.pub.x);
    const token = await readFile(out, "utf8");
    expect(decodeMandateUnverified(token)?.payload[CLAIM.tid]).toBe(created.taskId);
    expect(decodeMandateUnverified(token)?.payload[CLAIM.tend]).toBe(Math.floor(Date.parse(record.end) / 1000));
    expect(decodeMandateUnverified(token)?.payload[CLAIM.tbeg]).toBe(Math.floor(Date.parse(record.start) / 1000));
    expect(
      await runLoop({
        home,
        taskId: created.taskId,
        maxTicks: 1,
        sleep: async () => {
          throw new Error("waited");
        },
      }),
    ).toBe("waiting");

    const exp = new Date(record.current!.exp).getTime();
    const issued = await runLoop({
      home,
      taskId: created.taskId,
      now: () => new Date(exp - record.chunkSec * 500),
      maxTicks: 1,
      sleep: async () => {
        throw new Error("waited");
      },
    });
    expect(issued).toBe("issued");
    const renewed = await readRecord(home, created.taskId);
    expect(renewed.current?.exp).not.toBe(record.current?.exp);
    const renewedToken = await readFile(out, "utf8");
    expect(decodeMandateUnverified(renewedToken)?.payload[CLAIM.tid]).toBe(created.taskId);
    expect(decodeMandateUnverified(renewedToken)?.payload[CLAIM.tend]).toBe(Math.floor(Date.parse(record.end) / 1000));
    expect(decodeMandateUnverified(renewedToken)?.payload[CLAIM.tbeg]).toBe(Math.floor(Date.parse(record.start) / 1000));

    await markStopped(home, created.taskId);
    const before = await readFile(out, "utf8");
    expect(
      await runLoop({
        home,
        taskId: created.taskId,
        maxTicks: 2,
        sleep: async () => {
          throw new Error("waited");
        },
      }),
    ).toBe("stopped");
    expect(await readFile(out, "utf8")).toBe(before);
    await expect(markStopped(home, "../x")).rejects.toThrow(/task id/);
  });

  it("the default chunk is 10 minutes, and omitting the output file writes into the task folder", async () => {
    const home = await tempDir();
    const principal = await ed25519();
    const agent = await ed25519();
    await writeFile(path.join(home, "me.json"), JSON.stringify(principal.priv));
    await writeFile(path.join(home, "agent.json"), JSON.stringify(agent.pub));
    const created = await createDelegation({ "principal-key": path.join(home, "me.json"), "agent-pub": path.join(home, "agent.json"), site: "https://court.example", task: "watch", for: "7d" }, home);
    const record = await readRecord(home, created.taskId);
    expect(record.chunkSec).toBe(600);
    expect(record.outPath).toBe(path.join(path.resolve(home), created.taskId, "mandate.txt"));
    expect(await modeOf(record.outPath)).toBe(0o600);
    const sleeps: number[] = [];
    expect(
      await runLoop({
        home,
        taskId: created.taskId,
        maxTicks: 2,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).toBe("waiting");
    expect(sleeps).toEqual([30_000]);
  });

  it("tm delegate, list, and stop read and write the state file", async () => {
    const rootDir = await tempDir();
    const home = path.join(rootDir, "home");
    const me = path.join(rootDir, "me.json");
    const agent = path.join(rootDir, "agent.json");
    const out = path.join(rootDir, "current-mandate.txt");
    await tm(home, ["keygen", "--out", me]);
    await tm(home, ["keygen", "--out", agent]);
    expect(await modeOf(me)).toBe(0o600);
    const delegated = await tm(home, ["delegate", "--principal-key", me, "--agent-pub", agent, "--site", "https://court.example", "--task", "watch-and-reserve", "--for", "1h", "--chunk", "1m", "--out", out]);
    const taskId = delegated.stdout.trim();
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(delegated.stderr).toContain(out);
    const listed = await tm(home, ["list"]);
    expect(listed.stdout).toContain(taskId);
    expect(listed.stdout).toContain("Status: running");
    expect(listed.stdout).toContain("https://court.example");
    expect(listed.stdout).toContain("watch-and-reserve");
    const record = await readRecord(home, taskId);
    const stopped = await tm(home, ["stop", taskId]);
    expect(stopped.stdout).toBe(formatStop(record.current?.exp));
    const after = await tm(home, ["list"]);
    expect(after.stdout).toContain("Status: stopped");
    expect(after.stdout).not.toContain("Status: running");
  }, 30_000);

  it("with an open umask, folders are 700 and files are 600, and keygen creates a public key file", async () => {
    const previous = process.umask(0);
    try {
      const rootDir = await tempDir();
      const home = path.join(rootDir, "home");
      const me = path.join(rootDir, "me.json");
      const agent = path.join(rootDir, "agent.json");
      const out = path.join(rootDir, "current-mandate.txt");
      await tm(home, ["keygen", "--out", me]);
      await tm(home, ["keygen", "--out", agent]);
      const pub = path.join(rootDir, "agent.pub.json");
      expect(await modeOf(me)).toBe(0o600);
      expect(await modeOf(path.join(rootDir, "me.pub.json"))).toBe(0o600);
      expect(await modeOf(agent)).toBe(0o600);
      expect(await modeOf(pub)).toBe(0o600);
      const privateKey = JSON.parse(await readFile(agent, "utf8")) as JsonWebKey;
      const publicKey = JSON.parse(await readFile(pub, "utf8")) as JsonWebKey;
      expect(typeof privateKey.d).toBe("string");
      expect(publicKey.d).toBeUndefined();
      expect(publicKey.x).toBe(privateKey.x);
      expect(publicKey.kty).toBe("OKP");
      const delegated = await tm(home, ["delegate", "--principal-key", me, "--agent-pub", pub, "--site", "https://court.example", "--task", "watch-and-reserve", "--for", "1h", "--chunk", "1m", "--out", out]);
      const taskId = delegated.stdout.trim();
      expect(await modeOf(home)).toBe(0o700);
      const taskDir = path.join(home, taskId);
      expect(await modeOf(taskDir)).toBe(0o700);
      expect(await modeOf(out)).toBe(0o600);
      const names = await readdir(taskDir);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const info = await stat(path.join(taskDir, name));
        expect(info.mode & 0o777).toBe(info.isDirectory() ? 0o700 : 0o600);
      }
      const stored = JSON.parse(await readFile(path.join(taskDir, "agent.pub.jwk"), "utf8")) as JsonWebKey;
      expect(stored.d).toBeUndefined();
      expect(stored.x).toBe(publicKey.x);
    } finally {
      process.umask(previous);
    }
  }, 30_000);
});
