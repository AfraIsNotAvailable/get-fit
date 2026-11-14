/** Bundle the server into dist/ for systemd: one JS file, node builtins external. */
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("../../packages/db/src/schema.sql", "dist/schema.sql");

await build({
  entryPoints: ["src/main.ts", "src/cli.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  logLevel: "info",
  // the workspace packages are TypeScript sources; they get bundled too
  external: [],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
console.log("built dist/main.js and dist/cli.js");
