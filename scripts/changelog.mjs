#!/usr/bin/env node
/**
 * Fills the package part of src/content/docs/reference/changelog.md from an actuate-run/actuate checkout:
 *   - released versions from packages/<name>/CHANGELOG.md (written by `pnpm changeset version`);
 *   - an "Unreleased" section from the pending .changeset/*.md files, if there are any.
 *
 * The five packages share one version (a changesets fixed group), so one changeset is repeated in the
 * CHANGELOG of every package it names. Entries are deduplicated by changeset hash, or by their text when
 * an entry has no hash. "Updated dependencies" entries are left out.
 *
 * Only the text between the `changelog:packages` markers is replaced; the hosted-platform notes around
 * it are written by hand.
 *
 *   node scripts/changelog.mjs [--actuate ../actuate] [--from 0.4.0] [--check]
 *   pnpm changelog --actuate ../actuate
 *
 * --actuate  the actuate checkout (default: $ACTUATE_REPO, else ../actuate)
 * --from     the oldest version to list (default 0.4.0)
 * --check    write nothing; exit 1 when the page is out of date
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const PAGE = "src/content/docs/reference/changelog.md";
const START = "<!-- changelog:packages:start -->";
const END = "<!-- changelog:packages:end -->";
// Package order on the page and in the tie-break for an entry's first appearance.
const PACKAGES = ["sdk", "runtime", "cli", "providers", "create-actuate"];

const { values: args } = parseArgs({
  options: {
    actuate: { type: "string", default: process.env.ACTUATE_REPO ?? "../actuate" },
    from: { type: "string", default: "0.4.0" },
    check: { type: "boolean", default: false },
  },
});
const repo = resolve(args.actuate);
if (!existsSync(join(repo, "packages"))) {
  console.error(`No actuate checkout at ${repo}. Pass --actuate <path> or set ACTUATE_REPO.`);
  process.exit(2);
}

const semver = (v) => v.split(/[.-]/).slice(0, 3).map(Number);
const compare = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** The entries of one CHANGELOG.md: [{ version, hash, text }], `text` dedented to the changeset's own Markdown. */
function readChangelog(file) {
  const entries = [];
  let version = null;
  let current = null;
  const flush = () => {
    if (current) entries.push({ version, hash: current.hash, text: current.lines.join("\n").trim() });
    current = null;
  };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const heading = /^## (\d+\.\d+\.\d+\S*)\s*$/.exec(line);
    if (heading) {
      flush();
      version = heading[1];
      continue;
    }
    if (!version || /^#/.test(line)) {
      flush();
      continue;
    }
    const item = /^- (?:([0-9a-f]{7,40}): )?(.*)$/.exec(line);
    if (item) {
      flush();
      current = { hash: item[1] ?? null, lines: [item[2]] };
    } else if (current) {
      current.lines.push(line.startsWith("  ") ? line.slice(2) : line);
    }
  }
  flush();
  return entries.filter((e) => !/^Updated dependencies\b/.test(e.text));
}

/** Pending changesets: { bump, text } each, the bump being the largest one the file asks for. */
function readChangesets(dir) {
  if (!existsSync(dir)) return [];
  const rank = { patch: 1, minor: 2, major: 3 };
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort()
    .map((f) => {
      const raw = readFileSync(join(dir, f), "utf8");
      const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
      const bumps = [...(fm?.[1] ?? "").matchAll(/:\s*"?(patch|minor|major)"?\s*$/gm)].map((m) => m[1]);
      const bump = bumps.sort((a, b) => rank[b] - rank[a])[0] ?? "patch";
      return { bump, text: (fm ? raw.slice(fm[0].length) : raw).trim() };
    })
    .filter((c) => c.text);
}

function nextVersion(current, bump) {
  const [major, minor, patch] = semver(current);
  if (bump === "major") return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Released versions, deduplicated across the packages' changelogs.
const byVersion = new Map();
const seen = new Set();
for (const name of PACKAGES) {
  const file = join(repo, "packages", name, "CHANGELOG.md");
  if (!existsSync(file)) continue;
  for (const entry of readChangelog(file)) {
    if (compare(entry.version, args.from) < 0) continue;
    const key = `${entry.version}\n${entry.hash ?? entry.text.replace(/\s+/g, " ")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byVersion.has(entry.version)) byVersion.set(entry.version, []);
    byVersion.get(entry.version).push(entry.text);
  }
}
// A version every package shipped with nothing but dependency updates still gets a heading.
for (const name of PACKAGES) {
  const file = join(repo, "packages", name, "CHANGELOG.md");
  if (!existsSync(file)) continue;
  for (const [, v] of readFileSync(file, "utf8").matchAll(/^## (\d+\.\d+\.\d+\S*)\s*$/gm)) {
    if (compare(v, args.from) >= 0 && !byVersion.has(v)) byVersion.set(v, []);
  }
}

/**
 * Changelog text is Markdown that the docs render as HTML, so a bare `<actuator>` would vanish as an unknown tag.
 * Escape `<` outside code spans and fenced blocks; code is shown as written.
 */
function escapeHtml(text) {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 ? part : part.replace(/</g, "&lt;")))
        .join("");
    })
    .join("\n");
}

const sections = [];
const pending = readChangesets(join(repo, ".changeset"));
if (pending.length) {
  const current = JSON.parse(readFileSync(join(repo, "packages", "sdk", "package.json"), "utf8")).version;
  const rank = { patch: 1, minor: 2, major: 3 };
  const bump = pending.map((c) => c.bump).sort((a, b) => rank[b] - rank[a])[0];
  sections.push(`### Unreleased (${nextVersion(current, bump)})\n\nFrom the pending changesets. These packages are not on npm yet.\n\n${pending.map((c) => escapeHtml(c.text)).join("\n\n")}`);
}
for (const version of [...byVersion.keys()].sort((a, b) => compare(b, a))) {
  const texts = byVersion.get(version);
  sections.push(`### ${version}\n\n${texts.length ? texts.map(escapeHtml).join("\n\n") : "Dependency updates only."}`);
}

const generated = `${START}\n<!-- Generated by scripts/changelog.mjs from actuate-run/actuate. Don't edit by hand; run the script. -->\n\n${sections.join("\n\n")}\n\n${END}`;
const page = readFileSync(PAGE, "utf8");
const i = page.indexOf(START);
const j = page.indexOf(END);
if (i < 0 || j < i) {
  console.error(`${PAGE} has no ${START} ... ${END} block.`);
  process.exit(2);
}
const next = page.slice(0, i) + generated + page.slice(j + END.length);
if (args.check) {
  if (next !== page) {
    console.error(`${PAGE} is out of date. Run: node scripts/changelog.mjs --actuate ${args.actuate}`);
    process.exit(1);
  }
  console.log(`${PAGE} is up to date.`);
} else {
  writeFileSync(PAGE, next);
  console.log(`${PAGE}: ${sections.length} version section(s) from ${repo}`);
}
