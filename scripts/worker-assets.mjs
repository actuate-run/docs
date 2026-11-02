#!/usr/bin/env node
/**
 * Lay the docs build out at the paths it is served from. Astro builds with base /docs into
 * dist/ (pages at the root of dist), and actuate.run's front door forwards /docs/* to this
 * Worker unchanged, so the Worker's assets need a docs/ folder: dist-worker/docs/.
 */
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { indexable } from "../src/indexable.mjs";

if (!existsSync("dist/index.html")) {
  console.error("No docs build in dist/. Run: pnpm build");
  process.exit(1);
}
rmSync("dist-worker", { recursive: true, force: true });
cpSync("dist", "dist-worker/docs", { recursive: true });
// Response headers (Workers static assets read _headers from the assets root). The Markdown and
// llms.txt copies are for LLMs, not search results; outside production nothing is indexed.
const noindex = "  X-Robots-Tag: noindex, nofollow";
const rules = [
  `/docs/*.md\n${noindex}\n  Content-Type: text/markdown; charset=utf-8`,
  `/docs/llms.txt\n${noindex}`,
  `/docs/llms-full.txt\n${noindex}`,
  ...(indexable ? [] : [`/*\n${noindex}`]),
];
writeFileSync("dist-worker/_headers", rules.join("\n\n") + "\n");
console.log(`Docs assets ready in dist-worker/docs (${indexable ? "indexable" : "noindex"})`);
