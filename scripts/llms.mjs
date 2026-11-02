#!/usr/bin/env node
/**
 * Plain-Markdown copies of the docs for LLMs and answer engines (https://llmstxt.org):
 *   /docs/llms.txt        an index: what Actuate is, then every page with its description
 *   /docs/llms-full.txt   every page, in sidebar order, in one file
 *   /docs/<page>.md       each page as Markdown (e.g. /docs/concepts/capabilities.md)
 * Written into dist/ after `astro build`. Search engines are told not to index these
 * copies (X-Robots-Tag in scripts/worker-assets.mjs); the HTML pages are canonical.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sidebar } from "../src/sidebar.mjs";

const SITE = "https://actuate.run/docs";
const pages = sidebar.flatMap((group) =>
  group.items.map((slug) => {
    const raw = readFileSync(`src/content/docs/${slug}.md`, "utf8");
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
    const field = (k) => fm?.[1].match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "") ?? "";
    const body = (fm ? raw.slice(fm[0].length) : raw)
      .replace(/\]\(\/docs\/([^)#]*?)\/?(#[^)]*)?\)/g, (_, path, hash = "") => `](${SITE}/${path}${path ? "/" : ""}${hash})`)
      .trim();
    return { group: group.label, slug, title: field("title"), description: field("description"), body };
  }),
);

const page = (p) => `# ${p.title}\n\n> ${p.description}\n\nSource: ${SITE}/${p.slug}/\n\n${p.body}\n`;
for (const p of pages) {
  const file = `dist/${p.slug}.md`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page(p));
}

const intro = `# Actuate

> Actuate runs a TypeScript file as a tool an AI agent can call over MCP or HTTP. Each tool has a durable step engine (steps run exactly once, retries are safe), its own SQLite database, waits that cost nothing (sleep, events, payments, human approval by signed link), and uses your own messaging, payment and LLM accounts. Start with \`npm create actuate\`, deploy with \`npx @actuate/cli deploy\`; the runtime is open source (Apache-2.0) and self-hostable on Cloudflare Workers.

Website: https://actuate.run · Source: https://github.com/actuate-run/actuate · Templates: https://github.com/actuate-run/templates
Every page below is also available as Markdown at its .md URL. All pages in one file: ${SITE}/llms-full.txt
`;
let index = intro;
for (const group of sidebar) {
  index += `\n## ${group.label}\n\n`;
  for (const p of pages.filter((x) => x.group === group.label)) index += `- [${p.title}](${SITE}/${p.slug}.md): ${p.description}\n`;
}
writeFileSync("dist/llms.txt", index);
writeFileSync("dist/llms-full.txt", `${intro}\n${pages.map(page).join("\n---\n\n")}`);
console.log(`llms.txt: ${pages.length} pages`);
