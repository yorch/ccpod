import { defineCommand } from 'citty';

export default defineCommand({
  meta: { description: 'Manage Claude Code state for a profile' },
  subCommands: {
    clear: () => import('./clear.ts').then((m) => m.default),
  },
});
