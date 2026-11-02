// @ts-check
import { defineEcConfig } from "@astrojs/starlight/expressive-code";

// Code blocks styled like the code cards on actuate.run.
export default defineEcConfig({
  themes: ["github-dark", "github-light"],
  // Shell snippets are plain code cards, without a terminal title bar.
  defaultProps: { overridesByLang: { "bash,sh,shell,text": { frame: "none" } } },
  styleOverrides: {
    borderRadius: "12px",
    borderColor: "var(--a-line-strong)",
    codeBackground: "var(--a-code-bg)",
    codeFontFamily: "var(--sl-font-mono)",
    codeFontSize: "13px",
    codeLineHeight: "1.65",
    uiFontFamily: "var(--sl-font)",
    frames: {
      editorTabBarBackground: "var(--a-code-bg)",
      editorActiveTabBackground: "var(--a-code-bg)",
      editorActiveTabIndicatorTopColor: "transparent",
      editorActiveTabIndicatorBottomColor: "transparent",
      editorTabBarBorderBottomColor: "var(--a-line)",
      editorActiveTabForeground: "var(--a-fg-faint)",
      terminalTitlebarBackground: "var(--a-code-bg)",
      terminalBackground: "var(--a-code-bg)",
      terminalTitlebarBorderBottomColor: "var(--a-line)",
      terminalTitlebarForeground: "var(--a-fg-faint)",
      terminalTitlebarDotsForeground: "var(--a-line-strong)",
      frameBoxShadowCssValue: "none",
    },
  },
});
