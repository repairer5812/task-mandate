import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts", "packages/**/test/**/*.test.ts"] },
  resolve: {
    alias: [
      { find: "@task-mandate/core/internal", replacement: fileURLToPath(new URL("./packages/core/src/internal.ts", import.meta.url)) },
      { find: "@task-mandate/core", replacement: fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) },
      { find: "@task-mandate/agent", replacement: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)) },
      { find: "@task-mandate/hono", replacement: fileURLToPath(new URL("./packages/hono/src/index.ts", import.meta.url)) },
      { find: "@task-mandate/store-conformance", replacement: fileURLToPath(new URL("./packages/store-conformance/src/index.ts", import.meta.url)) },
      { find: "@task-mandate/node", replacement: fileURLToPath(new URL("./packages/node/src/index.ts", import.meta.url)) },
    ],
  },
});
