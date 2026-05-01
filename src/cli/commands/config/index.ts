import { defineCommand } from 'citty';

export default defineCommand({
  meta: { description: 'Inspect and validate ccpod configuration' },
  subCommands: {
    get: () => import('./get.ts').then((m) => m.default),
    set: () => import('./set.ts').then((m) => m.default),
    show: () => import('./show.ts').then((m) => m.default),
    validate: () => import('./validate.ts').then((m) => m.default),
  },
});
