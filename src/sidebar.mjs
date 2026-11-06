// The docs' order: the sidebar, and llms.txt / llms-full.txt (scripts/llms.mjs).
export const sidebar = [
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
      "concepts/agents",
    ],
  },
  {
    label: "Reference",
    items: ["reference/sdk", "reference/cli", "reference/runtime-http", "reference/platform-api", "reference/limits"],
  },
  {
    label: "Guides",
    items: [
      "guides/connect-your-agent",
      "guides/agent-tools",
      "guides/best-practices",
      "guides/alerts",
      "guides/custom-webhook",
      "guides/retry-and-rollback",
      "guides/self-hosting",
      "guides/templates",
    ],
  },
];
