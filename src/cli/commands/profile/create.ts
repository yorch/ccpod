import { defineCommand } from 'citty';
import { runWizard } from '../../../init/wizard.ts';

export default defineCommand({
  args: { name: { description: 'Profile name', type: 'positional' } },
  meta: { description: 'Create a new profile' },
  async run({ args }) {
    if (!args.name) {
      console.error('Profile name required');
      process.exit(1);
    }
    await runWizard(args.name);
  },
});
