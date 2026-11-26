import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PACKAGES = ["core", "agent", "hono", "cli", "store-conformance"] as const;

function run(command: string, args: string[], cwd: string): { code: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 });
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function visible(text: string): string {
  return text
    .replace(new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g"), "")
    .split("\n")
    .filter((line) => !line.includes("NO_COLOR") && !line.includes("trace-warnings") && !/^\(node:\d+\)/.test(line))
    .join("\n")
    .trim();
}

function quickStart(readme: string): string {
  const start = readme.indexOf("## Quick start");
  const end = readme.indexOf("## Packages");
  if (start < 0 || end < start) throw new Error("README quick start section was not found");
  const section = readme.slice(start, end);
  const blocks: string[] = [];
  const fence = /```ts\n([\s\S]*?)```/g;
  for (const match of section.matchAll(fence)) blocks.push(match[1] ?? "");
  if (blocks.length < 4) throw new Error(`quick start has ${blocks.length} blocks`);
  return `${blocks.join("\n")}\n`;
}

export async function runPackExample(root: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tm-pack-"));
  try {
    const built = run("pnpm", ["build"], root);
    if (built.code !== 0) return `build failed\n${visible(built.out).slice(-500)}`;
    const tarballs: string[] = [];
    for (const name of PACKAGES) {
      // pnpm pack rewrites workspace:* to a published version. npm pack leaves the protocol in place.
      const packed = run("pnpm", ["--filter", `@task-mandate/${name}`, "pack", "--pack-destination", dir], root);
      if (packed.code !== 0) return `${name} pack failed\n${visible(packed.out).slice(-400)}`;
      const line = visible(packed.out)
        .split("\n")
        .map((row) => row.trim())
        .filter((row) => row.endsWith(".tgz"))
        .at(-1);
      if (!line) return `${name} tarball name is missing`;
      tarballs.push(path.isAbsolute(line) ? line : path.join(dir, line));
    }
    const app = path.join(dir, "app");
    run("mkdir", ["-p", app], dir);
    const init = run("npm", ["init", "-y"], app);
    if (init.code !== 0) return `npm init failed\n${visible(init.out).slice(-300)}`;
    const installed = run("npm", ["install", "--silent", "hono@4.13.21", ...tarballs], app);
    if (installed.code !== 0) return `install failed\n${visible(installed.out).slice(-800)}`;
    const source = quickStart(await readFile(path.join(root, "README.md"), "utf8"));
    const file = path.join(app, "quickstart.mts");
    await writeFile(file, source);
    const node = run("node", ["--experimental-strip-types", file], app);
    if (node.code !== 0) return `example failed\n${visible(node.out).slice(-800)}`;
    return `installed ${tarballs.length}, example exit 0`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
