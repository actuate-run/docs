# docs

Documentation for [Actuate](https://actuate.run), published at [actuate.run/docs](https://actuate.run/docs).

Actuate is a hosted runtime for durable TypeScript scripts called actuators: one file with a durable step engine, its own SQLite database and an MCP endpoint, deployed in one command.

The site is built with [Astro Starlight](https://starlight.astro.build). Pages are Markdown files in [`src/content/docs/`](src/content/docs/); the sidebar is in [`astro.config.mjs`](astro.config.mjs).

## Run it locally

You need Node.js 22 and pnpm 10.

```bash
pnpm install
pnpm dev        # http://localhost:4321/docs/
pnpm build      # builds to dist/ and checks every internal link and anchor
pnpm preview    # serves the built site
```

`pnpm build` fails if any internal link or `#anchor` is broken (see [`scripts/check-links.mjs`](scripts/check-links.mjs)).

## Changelog

[`reference/changelog.md`](src/content/docs/reference/changelog.md) lists every package release from 0.4.0 on, and hand-written notes about the hosted platform. The package part comes from [actuate-run/actuate](https://github.com/actuate-run/actuate). At release time, once the release PR there (`pnpm changeset version`) is merged, run from this repository:

```bash
pnpm changelog --actuate ../actuate   # or set ACTUATE_REPO
pnpm changelog --actuate ../actuate --check   # exits 1 when the page is out of date
```

[`scripts/changelog.mjs`](scripts/changelog.mjs) reads each package's `CHANGELOG.md` and the pending `.changeset/*.md` files (as "Unreleased"), lists each changeset once (the packages share one version, so the same entry repeats in every package's changelog), and rewrites only the block between the `changelog:packages` markers. Write the hosted-platform notes below it by hand.

## Look and feel

The site uses the same palette, fonts (Geist and Geist Mono), radii and logo as actuate.run and the dashboard:

- [`src/styles/theme.css`](src/styles/theme.css): colours for light and dark, type, sidebar, tables, buttons;
- [`ec.config.mjs`](ec.config.mjs): code blocks;
- [`src/components/`](src/components/): the header wordmark and the links back to actuate.run, the dashboard and GitHub.

Keep headings short and skip subtitles and eyebrow labels.

## Fix something

Every page has an **Edit page** link at the bottom that opens the file on GitHub.

1. Fork this repository and create a branch.
2. Edit the page under `src/content/docs/`. Keep to plain, second-person prose ("you"), and write internal links as absolute paths that include the base, such as `/docs/concepts/steps-and-replay/`.
3. If you change a code sample, make sure it still type-checks against the current `@actuate/sdk` and passes `actuate check`.
4. Run `pnpm build` and confirm it ends with no broken links.
5. Open a pull request against `main` describing what was wrong.

Documentation describes what the code in [actuate-run/actuate](https://github.com/actuate-run/actuate) actually does. If you find the docs and the code disagree, open an issue.

## License

The prose is licensed under [CC BY 4.0](LICENSE). Code samples and the site's own code are MIT. See [LICENSE](LICENSE).
