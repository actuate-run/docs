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
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/actuate-run" }],
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
          items: ["guides/self-hosting", "guides/agent-tools", "guides/templates"],
        },
      ],
    }),
  ],
});
