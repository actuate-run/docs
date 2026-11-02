// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { sidebar } from "./src/sidebar.mjs";
import { indexable } from "./src/indexable.mjs";

export default defineConfig({
  site: "https://actuate.run",
  base: "/docs",
  trailingSlash: "ignore",
  integrations: [
    starlight({
      title: "Actuate",
      description: "Documentation for Actuate, a hosted runtime for durable TypeScript actuators.",
      favicon: "/favicon.svg",
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true } },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap",
          },
        },
        { tag: "meta", attrs: { name: "theme-color", content: "#fafaf8", media: "(prefers-color-scheme: light)" } },
        { tag: "meta", attrs: { name: "theme-color", content: "#0e0e0d", media: "(prefers-color-scheme: dark)" } },
        { tag: "meta", attrs: { property: "og:image", content: "https://actuate.run/og.png" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://actuate.run/og.png" } },
        { tag: "link", attrs: { rel: "alternate", type: "text/plain", href: "/docs/llms.txt", title: "Actuate docs for LLMs" } },
        // Staging and preview builds must never be indexed (see src/indexable.mjs).
        ...(indexable ? [] : [{ tag: "meta", attrs: { name: "robots", content: "noindex, nofollow" } }]),
      ],
      customCss: ["./src/styles/theme.css"],
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
        SocialIcons: "./src/components/SocialIcons.astro",
      },
      editLink: { baseUrl: "https://github.com/actuate-run/docs/edit/main/" },
      lastUpdated: false,
      sidebar,
    }),
  ],
});
