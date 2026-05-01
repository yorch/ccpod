// @ts-check

import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  base: '/',
  integrations: [
    starlight({
      components: {
        Footer: './src/components/Footer.astro',
      },
      customCss: ['./src/styles/custom.css'],
      description: 'Run Claude Code in Docker. Portable, composable profiles.',
      editLink: {
        baseUrl: 'https://github.com/yorch/ccpod/edit/main/website/',
      },
      head: [
        {
          attrs: {
            async: true,
            src: 'https://www.googletagmanager.com/gtag/js?id=G-VJXW4GZXT6',
          },
          tag: 'script',
        },
        {
          content: `
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-VJXW4GZXT6');
`,
          tag: 'script',
        },
        {
          attrs: {
            async: true,
            src: 'https://plausible.brnby.com/js/pa-eRH3SRTdLLQukpA4zRNB1.js',
          },
          tag: 'script',
        },
        {
          content: `
window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
plausible.init()
`,
          tag: 'script',
        },
      ],
      logo: {
        replacesTitle: false,
        src: './src/assets/logo.svg',
      },
      sidebar: [
        {
          items: [
            { label: 'Introduction', slug: 'getting-started/introduction' },
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'Quick Start', slug: 'getting-started/quick-start' },
          ],
          label: 'Getting Started',
        },
        {
          items: [
            { label: 'Overview', slug: 'profiles/overview' },
            { label: 'Configuration', slug: 'profiles/configuration' },
            { label: 'Shared Team Profile', slug: 'profiles/team' },
          ],
          label: 'Profiles',
        },
        {
          items: [
            { label: 'Overview', slug: 'project-config/overview' },
            { label: 'Merge Strategies', slug: 'project-config/merge' },
          ],
          label: 'Project Config',
        },
        {
          items: [
            { label: 'State Persistence', slug: 'features/state' },
            { label: 'MCP Auto-detection', slug: 'features/mcp' },
            { label: 'Network Policy', slug: 'features/network' },
            { label: 'Sidecar Services', slug: 'features/sidecars' },
            { label: 'SSH Forwarding', slug: 'features/ssh' },
          ],
          label: 'Features',
        },
        {
          items: [
            { label: 'CLI Reference', slug: 'reference/cli' },
            { label: 'Architecture', slug: 'reference/architecture' },
            { label: 'Internals', slug: 'reference/internals' },
            { label: 'Storage Layout', slug: 'reference/storage' },
          ],
          label: 'Reference',
        },
        {
          items: [{ label: 'Watch a Session', slug: 'demo' }],
          label: 'Demo',
        },
      ],
      social: [
        {
          href: 'https://github.com/yorch/ccpod',
          icon: 'github',
          label: 'GitHub',
        },
      ],
      title: 'ccpod',
    }),
  ],
  site: 'https://ccpod.brnby.com',
});
