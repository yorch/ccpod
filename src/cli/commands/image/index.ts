import { defineCommand } from 'citty';

export default defineCommand({
  meta: { description: 'Manage Docker images for ccpod profiles' },
  subCommands: {
    build: () => import('./build.ts').then((m) => m.default),
    pull: () => import('./pull.ts').then((m) => m.default),
  },
});
