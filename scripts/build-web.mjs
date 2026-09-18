import { build, context } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = {
  absWorkingDir: root,
  entryPoints: ["src/web/src/index.tsx"],
  outdir: "src/web/dist",
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  target: ["es2022"],
  minify: true,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const watcher = await context(options);
  await watcher.watch();
} else {
  await build(options);
}
