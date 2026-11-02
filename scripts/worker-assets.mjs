#!/usr/bin/env node
/**
 * Lay the docs build out at the paths it is served from. Astro builds with base /docs into
 * dist/ (pages at the root of dist), and actuate.run's front door forwards /docs/* to this
 * Worker unchanged, so the Worker's assets need a docs/ folder: dist-worker/docs/.
 */
import { cpSync, existsSync, rmSync } from "node:fs";

if (!existsSync("dist/index.html")) {
  console.error("No docs build in dist/. Run: pnpm build");
  process.exit(1);
}
rmSync("dist-worker", { recursive: true, force: true });
cpSync("dist", "dist-worker/docs", { recursive: true });
console.log("Docs assets ready in dist-worker/docs");
