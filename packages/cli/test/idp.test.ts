import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMandateUnverified, issuePersonAttestation } from "@task-mandate/core";
import { CLAIM } from "@task-mandate/core/internal";
import { afterEach, describe, expect, it } from "vitest";
import { runLoop } from "../src/run-loop.js";
import { readRecord } from "../src/task-files.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bin = path.join(root, "packages/cli/dist/cli.js");
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tm-idp-"));
  dirs.push(dir);
  return dir;
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

describe("mock identity attestation", () => {
  it("creates the issuer key as 600, rereads the attestation file on each renewal, and puts tbeg on the chunk", async () => {
    const home = await tempDir();
    const idpFile = path.join(home, "idp.json");
    const me = path.join(home, "me.json");
    const agent = path.join(home, "agent.json");
    const paFile = path.join(home, "pa.txt");
    const out = path.join(home, "mandate.txt");
    await tm(home, ["idp", "keygen", "--out", idpFile]);
    expect((await stat(idpFile)).mode & 0o777).toBe(0o600);
    const idp = JSON.parse(await readFile(idpFile, "utf8")) as { iss: string; secret: string; jwk: JsonWebKey };
    expect(idp.iss).toBe("https://idp.example");
    expect(typeof idp.secret).toBe("string");
    expect(typeof idp.jwk.d).toBe("string");
    await tm(home, ["keygen", "--out", me]);
    await tm(home, ["keygen", "--out", agent]);
    await tm(home, ["idp", "attest", "--idp", idpFile, "--person", "person-1", "--site", "https://court.example", "--principal-pub", path.join(home, "me.pub.json"), "--duration", "30d", "--out", paFile]);
    const issued = await tm(home, ["issue", "--principal-key", me, "--agent-pub", path.join(home, "agent.pub.json"), "--site", "https://court.example", "--task", "reserve", "--duration", "10m", "--person-attestation", paFile]);
    expect(decodeMandateUnverified(issued.stdout)?.payload[CLAIM.pa]).toBe((await readFile(paFile, "utf8")).trim());
    const delegated = await tm(home, ["delegate", "--principal-key", me, "--agent-pub", path.join(home, "agent.pub.json"), "--site", "https://court.example", "--task", "reserve", "--for", "1h", "--chunk", "1m", "--person-attestation", paFile, "--out", out]);
    const taskId = delegated.stdout.trim();
    const record = await readRecord(home, taskId);
    const first = decodeMandateUnverified(await readFile(out, "utf8"));
    expect(first?.payload[CLAIM.pa]).toBe((await readFile(paFile, "utf8")).trim());
    expect(first?.payload[CLAIM.tbeg]).toBe(Math.floor(Date.parse(record.start) / 1000));

    const replacement = await issuePersonAttestation({
      idpKey: idp.jwk,
      idpIssuer: idp.iss,
      secret: idp.secret,
      personId: "person-1",
      audience: "https://court.example",
      principalPublicKey: JSON.parse(await readFile(path.join(home, "me.pub.json"), "utf8")) as JsonWebKey,
      durationSec: 20 * 86_400,
      now: new Date(Date.parse(record.current!.exp) - 20_000),
    });
    await writeFile(paFile, `${replacement}\n`, { mode: 0o600 });
    const exp = new Date(record.current!.exp).getTime();
    expect(
      await runLoop({
        home,
        taskId,
        now: () => new Date(exp - 20_000),
        maxTicks: 1,
        sleep: async () => {
          throw new Error("waited");
        },
      }),
    ).toBe("issued");
    expect(decodeMandateUnverified(await readFile(out, "utf8"))?.payload[CLAIM.pa]).toBe(replacement);
    expect(decodeMandateUnverified(await readFile(out, "utf8"))?.payload[CLAIM.tbeg]).toBe(Math.floor(Date.parse(record.start) / 1000));
  }, 30_000);

  it("a state file with no start time says to create a new task and then stops", async () => {
    const home = await tempDir();
    const me = path.join(home, "me.json");
    const agent = path.join(home, "agent.json");
    await tm(home, ["keygen", "--out", me]);
    await tm(home, ["keygen", "--out", agent]);
    const delegated = await tm(home, ["delegate", "--principal-key", me, "--agent-pub", path.join(home, "agent.pub.json"), "--site", "https://court.example", "--task", "reserve", "--for", "1h", "--chunk", "1m"]);
    const taskId = delegated.stdout.trim();
    const taskFile = path.join(home, taskId, "task.json");
    const saved = JSON.parse(await readFile(taskFile, "utf8")) as Record<string, unknown>;
    delete saved.start;
    await writeFile(taskFile, JSON.stringify(saved));
    await expect(tm(home, ["run", taskId])).rejects.toThrow(/tm delegate/);
  }, 30_000);
});
