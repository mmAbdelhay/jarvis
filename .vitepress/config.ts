import { defineConfig } from "vitepress";

// The docs site, built from the markdown that already lives in this
// repository rather than from a copy of it.
//
// `srcDir` is the repository root, which is the whole trick: every relative
// link in README.md, SETUP.md and docs/** resolves here exactly as it does on
// GitHub, so the 65 cross-links between them keep working in both places and
// there is no second copy of anything to drift. The cost is `srcExclude`,
// which has to name everything that is code rather than prose.
export default defineConfig({
  title: "Jarvis",
  description: "A desktop workspace for running coding agents by voice",
  lang: "en-GB",

  // Project pages live under the repository name, not at the domain root.
  base: "/jarvis/",

  srcDir: ".",
  outDir: ".vitepress/dist",
  cacheDir: ".vitepress/cache",

  // README.md is the front page. Written for GitHub first — that is where
  // most people meet it — and rendered here unchanged.
  rewrites: { "README.md": "index.md" },

  srcExclude: [
    // Never published. .gitignore keeps these out of the repository; this
    // keeps them out of the site, which is a second thing to remember — so
    // scripts/check-docs-pages.mjs checks every built page is git-tracked
    // rather than trusting this list to stay complete.
    "docs/superpowers/**",
    "packages/**",
    "spikes/**",
    "design/**",
    "config/**",
    "scripts/**",
    ".github/**",
    ".claude/**",
    ".agents/**",
    "**/node_modules/**",
    ".vitepress/dist/**",
  ],

  cleanUrls: true,
  lastUpdated: true,

  // A link that 404s on the site is usually a link that 404s on GitHub too, so
  // the build fails rather than ship one. The exceptions are links to files
  // that resolve perfectly well in the repository but are not pages here:
  // LICENSE and NOTICE carry no .md extension, and spikes/ is excluded above.
  ignoreDeadLinks: [/^\.\/LICENSE$/, /^\.\/NOTICE$/, /spikes\//],

  themeConfig: {
    nav: [
      { text: "Guide", link: "/docs/guide/installation" },
      { text: "Develop", link: "/docs/develop/architecture" },
      { text: "Changelog", link: "/CHANGELOG" },
      {
        text: "Download",
        link: "https://github.com/mmAbdelhay/jarvis/releases",
      },
    ],

    sidebar: [
      {
        text: "Using it",
        items: [
          { text: "Setup on a new machine", link: "/SETUP" },
          { text: "Installation", link: "/docs/guide/installation" },
          { text: "Configuration", link: "/docs/guide/configuration" },
          { text: "The routes", link: "/docs/guide/routes" },
          { text: "Workspace tabs", link: "/docs/guide/workspace-tabs" },
          { text: "The API client", link: "/docs/guide/api-client" },
          { text: "Troubleshooting", link: "/docs/guide/troubleshooting" },
        ],
      },
      {
        text: "Working on it",
        items: [
          { text: "Architecture", link: "/docs/develop/architecture" },
          { text: "Conventions", link: "/docs/develop/conventions" },
          { text: "Testing", link: "/docs/develop/testing" },
          { text: "Adding a Workspace tab", link: "/docs/develop/adding-a-tab" },
          { text: "Contributing", link: "/CONTRIBUTING" },
        ],
      },
      {
        text: "The project",
        items: [
          { text: "Changelog", link: "/CHANGELOG" },
          { text: "Security", link: "/SECURITY" },
        ],
      },
    ],

    socialLinks: [{ icon: "github", link: "https://github.com/mmAbdelhay/jarvis" }],

    search: { provider: "local" },

    editLink: {
      pattern: "https://github.com/mmAbdelhay/jarvis/edit/master/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message:
        'MIT licensed. Third-party components keep their own licences — see <a href="https://github.com/mmAbdelhay/jarvis/blob/master/NOTICE">NOTICE</a>.',
      copyright: "© 2026 Muhammad AbdElHay",
    },
  },
});
