import { spawnSync } from "node:child_process";

// pako (via @sd-jwt) declares "MIT AND Zlib". Zlib here is the zlib/libpng license.
const ALLOWED = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "BSD", "Zlib"]);

function licenseIds(expression: string): string[] {
  return expression
    .split(/\s+(?:AND|OR|WITH)\s+/i)
    .map((part) => part.replace(/[()]/g, "").trim())
    .filter((part) => part !== "");
}

const PATTERNS: { name: string; source: string }[] = [
  { name: "pem-private-key", source: "-----BEGIN [A-Z ]*PRIVATE KEY-----" },
  { name: "aws-access-key", source: "AKIA[0-9A-Z]{16}" },
  { name: "github-token", source: "ghp_[A-Za-z0-9]{36}" },
  { name: "slack-token", source: "xox[baprs]-[A-Za-z0-9-]{10,}" },
];

function run(command: string, args: string[], cwd: string): { code: number; out: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env, maxBuffer: 32 * 1024 * 1024 });
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function firstJson(text: string): unknown {
  const start = text.search(/[{[]/);
  if (start < 0) throw new Error("no json");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1));
    }
  }
  throw new Error("json did not end");
}

function audit(root: string): string | undefined {
  const result = run("pnpm", ["audit", "--prod", "--json"], root);
  if (result.out.trim() === "") return result.code === 0 ? undefined : "audit produced no output";
  try {
    const body = firstJson(result.out) as { metadata?: { vulnerabilities?: Record<string, number> } };
    const counts = body.metadata?.vulnerabilities ?? {};
    const high = counts.high ?? 0;
    const critical = counts.critical ?? 0;
    if (high === 0 && critical === 0) return undefined;
    return `high ${high}, critical ${critical}`;
  } catch {
    if (result.code === 0) return undefined;
    return `audit exited ${result.code}`;
  }
}

function licenses(root: string): string | undefined {
  const result = run("pnpm", ["licenses", "list", "--prod", "--json"], root);
  if (result.code !== 0) return "licenses list failed";
  try {
    const rows = firstJson(result.out) as Record<string, { name?: string }[] | undefined>;
    const bad: string[] = [];
    for (const [license, packages] of Object.entries(rows)) {
      if (licenseIds(license).every((id) => ALLOWED.has(id))) continue;
      const list = Array.isArray(packages) ? packages : [];
      for (const item of list) bad.push(`${item.name ?? "unknown"} ${license}`);
    }
    return bad.length === 0 ? undefined : bad.slice(0, 8).join(", ");
  } catch {
    return "could not parse licenses JSON";
  }
}

function secrets(root: string): string | undefined {
  const hits: string[] = [];
  for (const pattern of PATTERNS) {
    const result = run("git", ["log", "--all", "--name-only", "--pretty=format:%H", "-G", pattern.source], root);
    const files = result.out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !/^[0-9a-f]{40}$/.test(line));
    const unique = [...new Set(files)];
    if (unique.length > 0) hits.push(`${pattern.name}: ${unique.slice(0, 5).join(", ")}`);
  }
  return hits.length === 0 ? undefined : hits.join(" | ");
}

export function runSupply(root: string): string | undefined {
  const problems = [audit(root), licenses(root), secrets(root)].filter((item): item is string => item !== undefined);
  return problems.length === 0 ? undefined : problems.join(" / ");
}
