// Acceptance tests for package metadata, build output, and top-level documents. Do not edit to make a change pass.
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLISHED = ["core", "agent", "hono", "cli", "store-conformance"];
const pkg = (name: string) => JSON.parse(readFileSync(join(ROOT, "packages", name, "package.json"), "utf8"));

beforeAll(() => {
  execFileSync("pnpm", ["build"], { cwd: ROOT, stdio: "pipe" });
}, 240_000);

describe("published package metadata", () => {
  for (const name of PUBLISHED) {
    it(`@task-mandate/${name}`, () => {
      const p = pkg(name);
      expect(p.name).toBe(`@task-mandate/${name}`);
      expect(p.version).toBe("0.1.0");
      expect(p.license).toBe("Apache-2.0");
      expect(p.private).toBeUndefined();
      expect(p.type).toBe("module");
      expect(p.files).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE"]));
      expect(JSON.stringify(p.exports)).toContain("./dist/");
      expect(JSON.stringify(p.exports)).not.toContain("/src/");
      expect(existsSync(join(ROOT, "packages", name, "LICENSE"))).toBe(true);
      expect(existsSync(join(ROOT, "packages", name, "README.md"))).toBe(true);
    });
  }

  it("the node package is a private compatibility package", () => {
    expect(pkg("node").private).toBe(true);
  });

  it("hono is a peerDependency, and store-conformance peers vitest", () => {
    expect(pkg("hono").peerDependencies?.hono).toBeTruthy();
    expect(pkg("hono").dependencies?.hono).toBeUndefined();
    expect(pkg("store-conformance").peerDependencies?.vitest).toBeTruthy();
  });

  it("agent and core do not depend on hono", () => {
    for (const name of ["core", "agent"]) {
      const p = pkg(name);
      expect({ ...p.dependencies, ...p.peerDependencies }.hono).toBeUndefined();
    }
  });
});

describe("Node loads the build output directly", () => {
  const load = (name: string, file = "index.js") => import(pathToFileURL(join(ROOT, "packages", name, "dist", file)).href);

  it("core, agent, hono", async () => {
    const core = await load("core");
    const agent = await load("agent");
    const hono = await load("hono");
    expect(typeof core.verifyRequest).toBe("function");
    expect(typeof core.TaskMandateError).toBe("function");
    expect(typeof agent.signRequest).toBe("function");
    expect(typeof agent.mandatedFetch).toBe("function");
    expect(typeof agent.Renewer).toBe("function");
    expect(typeof hono.taskMandate).toBe("function");
    for (const name of ["core", "agent", "hono", "store-conformance"]) {
      expect(existsSync(join(ROOT, "packages", name, "dist", "index.d.ts")), name).toBe(true);
    }
  });

  it("the cli runs from built JS without tsx, and the usage text is English", () => {
    const p = pkg("cli");
    const bin = typeof p.bin === "string" ? p.bin : p.bin?.tm;
    expect(bin).toMatch(/dist/);
    const out = execFileSync("node", [join(ROOT, "packages", "cli", bin), "--help"], { cwd: ROOT, encoding: "utf8" });
    expect(out).toMatch(/Usage/i);
    expect(out).not.toMatch(/[가-힣]/);
    expect(readFileSync(join(ROOT, "packages", "cli", bin), "utf8")).not.toContain("tsx");
  });

  it("the agent build has no file or process APIs", () => {
    const code = readFileSync(join(ROOT, "packages", "agent", "dist", "index.js"), "utf8");
    expect(code).not.toMatch(/from ["']node:fs|from ["']node:child_process|from ["']node:path/);
  });
});

describe("errors", () => {
  it("TaskMandateError has a code and an English message", async () => {
    const core = await import("@task-mandate/core");
    const { taskMandate } = await import("@task-mandate/node");
    const ascii = (m: string) => !/[가-힣]/.test(m);
    const config = (() => { try { core.assertVerifierConfig({ origin: "not a url" }); } catch (e) { return e; } })() as InstanceType<typeof core.TaskMandateError>;
    expect(config).toBeInstanceOf(core.TaskMandateError);
    expect(config.code).toBe("CONFIG_INVALID");
    expect(ascii(config.message)).toBe(true);
    const input = await core.issueMandate({ principalKey: {}, agentPublicKey: {}, audience: "https://a.example", task: { type: "x" }, durationSec: 60 }).catch((e) => e);
    expect(input).toBeInstanceOf(core.TaskMandateError);
    expect(["INPUT_INVALID", "KEY_INVALID"]).toContain(input.code);
    expect(ascii(input.message)).toBe(true);
    const store = (() => { try { taskMandate({ origin: "https://a.example" } as Parameters<typeof taskMandate>[0]); } catch (e) { return e; } })() as InstanceType<typeof core.TaskMandateError>;
    expect(store).toBeInstanceOf(core.TaskMandateError);
    expect(store.code).toBe("STORE_REQUIRED");
  });
});

describe("top-level documents", () => {
  const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
  it("LICENSE, NOTICE, README, SECURITY, CI", () => {
    expect(read("LICENSE")).toMatch(/Apache License\s+Version 2\.0/);
    expect(read("NOTICE")).toMatch(/three\.js/);
    expect(read("NOTICE")).toMatch(/Pretendard/);
    const readme = read("README.md");
    expect(readme).toMatch(/## Install/);
    expect(readme).toMatch(/## Quick start/);
    expect(readme).toMatch(/Apache-2\.0/);
    expect(readme).toMatch(/not for production/i);
    expect(existsSync(join(ROOT, "README.ko.md"))).toBe(true);
    expect(read("SECURITY.md")).toMatch(/0\.1/);
    expect(read(".github/workflows/ci.yml")).toMatch(/pnpm build/);
  });
});
