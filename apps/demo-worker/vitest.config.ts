import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({ plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml", environment: "test" } })], server: { fs: { allow: [repoRoot] } }, test: { include: ["test/**/*.test.ts"] } });
