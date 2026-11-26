import { mkdir } from "node:fs/promises";
import * as esbuild from "esbuild";

const tsExtension = {
  name: "ts-js-extension",
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, async (args) => {
      if (args.pluginData?.fromTsExtension) return null;
      if (!args.importer || !args.path.startsWith(".")) return null;
      const swapped = `${args.path.slice(0, -3)}.ts`;
      const resolved = await build.resolve(swapped, { importer: args.importer, resolveDir: args.resolveDir, kind: args.kind, pluginData: { fromTsExtension: true } });
      if (resolved.errors.length > 0 || !resolved.path) return null;
      return { path: resolved.path };
    });
  },
};

await mkdir("public/js", { recursive: true });
await esbuild.build({ entryPoints: ["src/browser.ts"], outfile: "public/js/task-mandate.js", bundle: true, format: "esm", platform: "browser", target: "es2022", plugins: [tsExtension], minify: true, legalComments: "eof", logLevel: "info" });
