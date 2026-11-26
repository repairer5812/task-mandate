import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", include: ["lab/**/*.test.ts"], fileParallelism: false } });
