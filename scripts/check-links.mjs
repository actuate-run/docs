// Checks every internal link and #anchor in the built site (dist/).
// Starlight has no built-in link validation, so this runs after `astro build`.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const BASE = "/docs";
const dist = new URL("../dist/", import.meta.url).pathname;

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (p.endsWith(".html")) yield p;
  }
}

function fileFor(pathname) {
  if (!pathname.startsWith(BASE)) return null;
  const rel = decodeURIComponent(pathname.slice(BASE.length)).replace(/^\//, "");
  for (const candidate of [rel, join(rel, "index.html"), `${rel}.html`]) {
    const p = join(dist, candidate);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file)) ids.set(file, new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  return ids.get(file);
};

const problems = [];
let checked = 0;
for (const file of htmlFiles(dist)) {
  const html = readFileSync(file, "utf8");
  const page = "/" + relative(dist, file);
  for (const [, href] of html.matchAll(/\shref="([^"]+)"/g)) {
    if (/^(https?:|mailto:|data:)/.test(href) || href.startsWith("//")) continue;
    checked++;
    const url = new URL(href.replace(/&amp;/g, "&"), `https://actuate.run${BASE}${page}`);
    const target = fileFor(url.pathname);
    if (!target) {
      problems.push(`${page}: broken link ${href}`);
      continue;
    }
    const hash = decodeURIComponent(url.hash.slice(1));
    if (hash && target.endsWith(".html") && !idsOf(target).has(hash)) problems.push(`${page}: missing anchor ${href}`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} broken internal link(s).`);
  process.exit(1);
}
console.log(`✓ ${checked} internal links checked, none broken.`);
