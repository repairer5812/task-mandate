import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePublicJwk } from "@task-mandate/core";
import type { KeyPair } from "../../bench/keys";
import { IDP_ISS, IDP_SECRET } from "../config";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = "/tmp/task-mandate-lab-worker";
const STATE = "/tmp/task-mandate-lab-wrangler-state";

export interface DevServer {
  origin: string;
  token: string;
  minSwitchSec: number;
  stop(): Promise<void>;
  reset(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to obtain a port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export async function startWorker(idp: KeyPair, minSwitchSec: number, seats: Record<string, number> = { "court-3": 100000 }): Promise<DevServer> {
  const port = await freePort();
  const inspector = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const token = randomBytes(24).toString("hex");
  const issuers = JSON.stringify([{ iss: IDP_ISS, jwks: [normalizePublicJwk(idp.pub)] }]);
  await rm(STATE, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  const main = path.join(ROOT, "apps/demo-worker/src/index.ts");
  const assets = path.join(ROOT, "apps/demo-worker/public");
  const toml = [
    'name = "task-mandate-lab-local"',
    `main = ${JSON.stringify(main)}`,
    'compatibility_date = "2026-11-25"',
    'compatibility_flags = ["nodejs_compat"]',
    "",
    "[assets]",
    `directory = ${JSON.stringify(assets)}`,
    'binding = "ASSETS"',
    "run_worker_first = true",
    "",
    "[vars]",
    `ORIGIN = ${JSON.stringify(origin)}`,
    `SEATS = ${JSON.stringify(JSON.stringify(seats))}`,
    `PERSON_ISSUERS = '${issuers}'`,
    `SIM_IDP_JWK = '${JSON.stringify({ jwk: idp.priv, iss: IDP_ISS, secret: IDP_SECRET })}'`,
    'REQUIRE_PERSON = "true"',
    'ONE_PER_PERSON = "true"',
    `MIN_SWITCH_SEC = ${JSON.stringify(String(minSwitchSec))}`,
    'MAX_LIFETIME_SEC = "86400"',
    'MAX_TASK_SEC = "2592000"',
    'SEAT_RESET_SEC = "3600"',
    `RESET_TOKEN = ${JSON.stringify(token)}`,
    "",
    "[[durable_objects.bindings]]",
    'name = "MANDATE_STORE"',
    'class_name = "MandateStore"',
    "",
    "[[migrations]]",
    'tag = "v1"',
    'new_sqlite_classes = ["MandateStore"]',
    "",
  ].join("\n");
  const config = path.join(DIR, "wrangler.toml");
  await writeFile(config, toml);
  await writeFile(path.join(DIR, ".dev.vars"), `RESET_TOKEN=${token}\n`);
  const args = [
    "--filter",
    "@task-mandate/demo-worker",
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    String(inspector),
    "--inspector-ip",
    "127.0.0.1",
    "--persist-to",
    STATE,
    "--config",
    config,
    "--cwd",
    path.join(ROOT, "apps/demo-worker"),
    "--env-file",
    path.join(DIR, ".dev.vars"),
    "--infer-origin-from-routes=false",
    "--show-interactive-dev-session=false",
    "--no-latest",
    "--log-level",
    "info",
  ];
  if (args.includes("--remote") || args.includes("-r")) throw new Error("remote execution is not allowed");
  const child = spawn("pnpm", args, { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0" } });
  let log = "";
  const take = (chunk: Buffer) => {
    log += chunk.toString();
    if (log.length > 80_000) log = log.slice(-40_000);
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 120_000);
    const watch = () => {
      if (log.includes("Ready on")) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (!ready) {
    await stopChild(child);
    throw new Error(`worker did not start\n${log.slice(-2000)}`);
  }
  return {
    origin,
    token,
    minSwitchSec,
    stop: () => stopChild(child),
    async reset() {
      const response = await fetch(`${origin}/reset`, { method: "POST", headers: { "x-reset-token": token }, redirect: "manual" });
      const text = await response.text();
      if (!response.ok) throw new Error(`reset failed ${response.status} ${text.slice(0, 200)}`);
    },
  };
}
