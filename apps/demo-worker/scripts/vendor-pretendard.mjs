import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const EXPECTED = "1.3.9";
const require = createRequire(import.meta.url);
const pkgPath = require.resolve("pretendard/package.json");
const root = dirname(pkgPath);
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
if (pkg.version !== EXPECTED) {
  throw new Error(`pretendard version is not ${EXPECTED}: ${pkg.version}`);
}

const srcVariableDir = join(root, "dist", "web", "variable");
const srcSubsetDir = join(srcVariableDir, "woff2-dynamic-subset");
const destVendorDir = "public/vendor";
const destPretendardDir = join(destVendorDir, "pretendard");
const destSubsetDir = join(destPretendardDir, "woff2-dynamic-subset");

await mkdir(destSubsetDir, { recursive: true });
const files = (await readdir(srcSubsetDir)).filter((f) => f.endsWith(".woff2")).sort();
if (files.length === 0) {
  throw new Error("pretendard dynamic subset woff2 files were not found.");
}

for (const file of files) {
  await copyFile(join(srcSubsetDir, file), join(destSubsetDir, file));
}

const rawCss = await readFile(join(srcVariableDir, "pretendardvariable-dynamic-subset.css"), "utf8");
const blocks = [...rawCss.matchAll(/\/\* \[(\d+)\] \*\/\s*@font-face\s*\{[^}]*unicode-range:\s*([^;]+);/g)];
const cssLines = ["/* Pretendard 1.3.9 Dynamic Subset (SIL Open Font License 1.1, /vendor/pretendard.LICENSE) */"];
for (const m of blocks) {
  const idx = m[1];
  const ur = m[2].trim();
  cssLines.push(`@font-face{font-family:"Pretendard";font-style:normal;font-display:swap;font-weight:45 920;src:url("/vendor/pretendard/woff2-dynamic-subset/PretendardVariable.subset.${idx}.woff2") format("woff2-variations");unicode-range:${ur}}`);
}
await writeFile(join(destPretendardDir, "pretendard-dynamic-subset.css"), cssLines.join("\n") + "\n");
await copyFile(join(root, "dist", "LICENSE.txt"), join(destVendorDir, "pretendard.LICENSE"));
await copyFile(join(root, "dist", "LICENSE.txt"), join(destPretendardDir, "LICENSE.txt"));
console.log(`copied pretendard ${pkg.version} dynamic subset (${files.length} files) and the OFL license`);
