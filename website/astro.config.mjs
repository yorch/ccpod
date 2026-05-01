// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://yorch.github.io',
  base: '/ccpod',
  integrations: [
    starlight({
      title: 'ccpod',
      description: 'Run Claude Code in Docker. Portable, composable profiles.',
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: false,
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/yorch/ccpod',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/yorch/ccpod/edit/main/website/',
      },
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://cdn.jsdelivr.net/npm/asciinema-player@3.15.1/dist/bundle/asciinema-player.css',
          },
        },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'getting-started/introduction' },
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'Quick Start', slug: 'getting-started/quick-start' },
          ],
        },
        {
          label: 'Profiles',
          items: [
            { label: 'Overview', slug: 'profiles/overview' },
            { label: 'Configuration', slug: 'profiles/configuration' },
            { label: 'Shared Team Profile', slug: 'profiles/team' },
          ],
        },
        {
          label: 'Project Config',
          items: [
            { label: 'Overview', slug: 'project-config/overview' },
            { label: 'Merge Strategies', slug: 'project-config/merge' },
          ],
        },
        {
          label: 'Features',
          items: [
            { label: 'State Persistence', slug: 'features/state' },
            { label: 'MCP Auto-detection', slug: 'features/mcp' },
            { label: 'Network Policy', slug: 'features/network' },
            { label: 'Sidecar Services', slug: 'features/sidecars' },
            { label: 'SSH Forwarding', slug: 'features/ssh' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI Reference', slug: 'reference/cli' },
            { label: 'Architecture', slug: 'reference/architecture' },
            { label: 'Storage Layout', slug: 'reference/storage' },
          ],
        },
        {
          label: 'Demo',
          items: [{ label: 'Watch a Session', slug: 'demo' }],
        },
      ],
    }),
  ],
});
