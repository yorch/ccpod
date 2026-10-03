// @ts-check

import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLlmsTxt from 'starlight-llms-txt';

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
        // Google Fonts — preconnect first, then stylesheet (avoids render-blocking @import)
        {
          attrs: { href: 'https://fonts.googleapis.com', rel: 'preconnect' },
          tag: 'link',
        },
        {
          attrs: {
            crossorigin: true,
            href: 'https://fonts.gstatic.com',
            rel: 'preconnect',
          },
          tag: 'link',
        },
        {
          attrs: {
            href: 'https://fonts.googleapis.com/css2?family=Azeret+Mono:wght@400;500;600;700;800&family=Onest:wght@300;400;500;600;700&display=swap',
            rel: 'stylesheet',
          },
          tag: 'link',
        },
        // Social card: Starlight defaults og:type to "article"; this is a docs/product site
        { attrs: { content: 'website', property: 'og:type' }, tag: 'meta' },
        {
          attrs: {
            content: 'https://ccpod.brnby.com/og.png',
            property: 'og:image',
          },
          tag: 'meta',
        },
        {
          attrs: { content: '1200', property: 'og:image:width' },
          tag: 'meta',
        },
        {
          attrs: { content: '630', property: 'og:image:height' },
          tag: 'meta',
        },
        {
          attrs: {
            content: 'ccpod: Claude Code in Docker with portable profiles',
            property: 'og:image:alt',
          },
          tag: 'meta',
        },
        // Twitter/X card
        {
          attrs: { content: 'summary_large_image', name: 'twitter:card' },
          tag: 'meta',
        },
        {
          attrs: {
            content: 'https://ccpod.brnby.com/og.png',
            name: 'twitter:image',
          },
          tag: 'meta',
        },
        { attrs: { content: '@yorch', name: 'twitter:creator' }, tag: 'meta' },
        // SoftwareApplication structured data
        {
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            applicationCategory: 'DeveloperApplication',
            author: {
              '@type': 'Person',
              name: 'yorch',
              url: 'https://github.com/yorch',
            },
            description:
              'Run Claude Code in Docker with portable, versioned profiles. Share and reproduce your Claude environment across machines and teams.',
            downloadUrl: 'https://github.com/yorch/ccpod/releases',
            image: 'https://ccpod.brnby.com/og.png',
            license: 'https://github.com/yorch/ccpod/blob/main/LICENSE',
            name: 'ccpod',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            operatingSystem: 'macOS, Linux',
            sameAs: ['https://github.com/yorch/ccpod'],
            url: 'https://ccpod.brnby.com/',
          }),
          tag: 'script',
        },
        // Google Analytics
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
        // Plausible Analytics
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
      lastUpdated: true,
      logo: {
        replacesTitle: false,
        src: './src/assets/logo.svg',
      },
      plugins: [
        starlightLlmsTxt({
          description:
            'Run Claude Code in Docker with portable, versioned profiles. Share, reproduce, and pin your Claude AI development environment across machines and teams.',
          details: `
## Install

\`\`\`sh
curl -fsSL https://ccpod.brnby.com/install.sh | sh
ccpod init
ccpod run
\`\`\`

## Source

https://github.com/yorch/ccpod
`,
          projectName: 'ccpod',
        }),
      ],
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
            { label: 'Auth Proxy Design', slug: 'reference/auth-proxy-design' },
            { label: 'Internals', slug: 'reference/internals' },
            { label: 'Storage Layout', slug: 'reference/storage' },
          ],
          label: 'Reference',
        },
        {
          items: [
            { label: 'Untrusted Repos', slug: 'guides/untrusted-repos' },
            {
              label: 'Migrate Your Config',
              slug: 'guides/migrate-claude-config',
            },
          ],
          label: 'Guides',
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
