import { defineCommand } from 'citty';
import { runWizard } from '../../init/wizard.ts';

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
    await runWizard(args.profile ?? 'default');
  },
});
