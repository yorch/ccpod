import { defineCommand } from 'citty';
import { runWizard } from '../../../init/wizard.ts';
import { validateProfileArg } from '../../validate.ts';

export default defineCommand({
  args: { name: { description: 'Profile name', type: 'positional' } },
  meta: { description: 'Create a new profile' },
  async run({ args }) {
    if (!args.name) {
      console.error('Profile name required');
      process.exit(1);
    }
    validateProfileArg(args.name);
    await runWizard(args.name);
  },
});
