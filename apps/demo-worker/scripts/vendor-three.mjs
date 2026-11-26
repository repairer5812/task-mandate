// three 0.187.0 does not ship build/three.module.min.js. Minify the module build and save it under that name.

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const EXPECTED = "0.187.0";
const require = createRequire(import.meta.url);
const bundled = require.resolve("three");
const root = dirname(dirname(bundled));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (pkg.version !== EXPECTED) throw new Error(`three version is not ${EXPECTED}: ${pkg.version}`);
if (!bundled.endsWith(`${join("build", "three.cjs")}`)) {
  throw new Error(`three entry point is not build/three.cjs: ${bundled}`);
}

const destDir = "public/vendor";
await mkdir(destDir, { recursive: true });
await esbuild.build({ entryPoints: [join(root, "build", "three.module.js")], outfile: join(destDir, "three.module.min.js"), bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "none", logLevel: "info" });
await copyFile(join(root, "LICENSE"), join(destDir, "three.LICENSE"));
