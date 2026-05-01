import { defineCommand } from 'citty';

export default defineCommand({
  meta: { description: 'Inspect and validate ccpod configuration' },
  subCommands: {
    show: () => import('./show.ts').then((m) => m.default),
    validate: () => import('./validate.ts').then((m) => m.default),
  },
});
