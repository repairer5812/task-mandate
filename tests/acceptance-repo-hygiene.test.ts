// Acceptance tests for repository hygiene. Do not edit to make a change pass.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLISHED = ["core", "agent", "hono", "cli", "store-conformance"];
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (p: string) => relative(ROOT, p);
const read = (p: string) => readFileSync(p, "utf8");
const srcFiles = () => PUBLISHED.flatMap((n) => walk(join(ROOT, "packages", n, "src")));

describe("no Korean in published packages", () => {
  it("src, README, package.json description", () => {
    const hits: string[] = [];
    for (const f of srcFiles()) read(f).split("\n").forEach((l, i) => { if (HANGUL.test(l)) hits.push(`${rel(f)}:${i + 1}`); });
    for (const n of PUBLISHED) {
      const readme = join(ROOT, "packages", n, "README.md");
      if (HANGUL.test(read(readme))) hits.push(rel(readme));
      const desc = JSON.parse(read(join(ROOT, "packages", n, "package.json"))).description ?? "";
      if (HANGUL.test(desc)) hits.push(`packages/${n}/package.json description`);
    }
    expect(hits).toEqual([]);
  });
});

describe("no tutorial comments", () => {
  it("no narrating comments", () => {
    const bad = /(\/\/|\*)\s*(Step \d|Now,? we|Here,? we|This (function|method|code) |First,|Next,|Then,|Finally,|We (now|then) )/i;
    const hits: string[] = [];
    for (const f of srcFiles()) read(f).split("\n").forEach((l, i) => { if (bad.test(l)) hits.push(`${rel(f)}:${i + 1}: ${l.trim()}`); });
    expect(hits).toEqual([]);
  });
});

describe("banned phrases in English docs", () => {
  const words = ["seamless", "robust", "leverage", "comprehensive", "cutting-edge", "powerful", "simply", "effortless", "note that", "it's important to", "in conclusion", "delve", "elevate", "empower", "game-changer", "unlock", "supercharge", "blazing"];
  const files = ["README.md", "SECURITY.md", "CHANGELOG.md", ...PUBLISHED.map((n) => `packages/${n}/README.md`)];
  it("docs avoid marketing words", () => {
    const hits: string[] = [];
    for (const f of files) {
      const text = read(join(ROOT, f));
      const lower = text.toLowerCase();
      for (const w of words) if (lower.includes(w)) hits.push(`${f}: ${w}`);
      if (/\p{Extended_Pictographic}/u.test(text)) hits.push(`${f}: emoji`);
    }
    expect(hits).toEqual([]);
  });

  it("length cap", () => {
    expect(read(join(ROOT, "README.md")).split("\n").length).toBeLessThanOrEqual(250);
    for (const n of PUBLISHED) expect(read(join(ROOT, "packages", n, "README.md")).split("\n").length, n).toBeLessThanOrEqual(80);
  });
});

describe("static checks and duplication", () => {
  const pkg = JSON.parse(read(join(ROOT, "package.json")));
  it("Biome and jscpd are pinned to exact versions", () => {
    expect(pkg.devDependencies["@biomejs/biome"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies["jscpd"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(join(ROOT, "biome.json"))).toBe(true);
  });
  it("pnpm lint passes", () => {
    execFileSync("pnpm", ["lint"], { cwd: ROOT, stdio: "pipe" });
  }, 120_000);
  it("published packages are at most 1% duplicated", () => {
    const out = execFileSync("pnpm", ["-s", "dup"], { cwd: ROOT, encoding: "utf8" });
    const m = out.match(/"percentage"\s*:\s*([\d.]+)/);
    expect(m, out.slice(0, 300)).toBeTruthy();
    expect(Number(m![1])).toBeLessThanOrEqual(1);
  }, 120_000);
});

describe("repository layout", () => {
  it("no files outside the REPO_LAYOUT allow list, and no work products", () => {
    const doc = read(join(ROOT, "docs/REPO_LAYOUT.md"));
    const block = doc.match(/```[a-z]*\n([\s\S]*?)```/);
    expect(block).toBeTruthy();
    const globs = block![1].split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    const toRe = (g: string) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
    const res = globs.map(toRe);
    const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    const outside = files.filter((f) => !res.some((r) => r.test(f)));
    expect(outside).toEqual([]);
  });
});
