import { ExitPromptError } from '@inquirer/core';
import { defineCommand } from 'citty';
import { runWizard } from '../../init/wizard.ts';
import { validateProfileArg } from '../validate.ts';

export default defineCommand({
  args: {
    profile: {
      default: 'default',
      description: 'Profile name to create',
      type: 'string',
    },
  },
  meta: { description: 'Interactive first-run setup wizard' },
  async run({ args }) {
    try {
      validateProfileArg(args.profile);
      await runWizard(args.profile ?? 'default');
    } catch (err) {
      if (err instanceof ExitPromptError) {
        console.log('\nCancelled.');
        process.exit(0);
      }
      throw err;
    }
  },
});
