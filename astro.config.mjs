// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

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
      ],
      customCss: ["./src/styles/theme.css"],
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
        SocialIcons: "./src/components/SocialIcons.astro",
      },
      editLink: { baseUrl: "https://github.com/actuate-run/docs/edit/main/" },
      lastUpdated: false,
      sidebar: [
        {
          label: "Getting started",
          items: [
            "getting-started/introduction",
            "getting-started/quickstart",
            "getting-started/first-actuator",
          ],
        },
        {
          label: "Concepts",
          items: [
            "concepts/actuators",
            "concepts/steps-and-replay",
            "concepts/sleeping-and-waiting",
            "concepts/approvals",
            "concepts/database",
            "concepts/capabilities",
            "concepts/triggers",
            "concepts/mcp-and-openapi",
          ],
        },
        {
          label: "Reference",
          items: ["reference/sdk", "reference/cli", "reference/runtime-http", "reference/limits"],
        },
        {
          label: "Guides",
          items: ["guides/connect-your-agent", "guides/agent-tools", "guides/self-hosting", "guides/templates"],
        },
      ],
    }),
  ],
});
