import chalk from 'chalk';
import { defineCommand } from 'citty';
import { listCcpodContainers } from '../../container/list.ts';
import { rejectExtraPositionals } from '../args.ts';
import { exitWithError } from '../errors.ts';
import { validateProfileArg } from '../validate.ts';

export default defineCommand({
  args: {
    all: {
      default: false,
      description: 'Include stopped containers',
      type: 'boolean',
    },
    details: {
      default: false,
      description: 'Inspect exit code and health status',
      type: 'boolean',
    },
    json: { default: false, description: 'Output as JSON', type: 'boolean' },
    profile: {
      description: 'Only show containers for this profile',
      type: 'string',
    },
  },
  meta: { description: 'List ccpod containers', name: 'ps' },
  async run({ args }) {
    rejectExtraPositionals(args);
    validateProfileArg(args.profile);
    let containers: Awaited<ReturnType<typeof listCcpodContainers>>;
    try {
      containers = await listCcpodContainers({
        all: args.all,
        details: args.details || args.json,
        ...(args.profile ? { profile: args.profile } : {}),
      });
    } catch (err) {
      exitWithError(err);
    }
    if (args.json) {
      console.log(JSON.stringify(containers, null, 2));
      return;
    }
    if (containers.length === 0) {
      console.log(
        'No ccpod containers' +
          (args.all ? '.' : ' running. Use --all to include stopped.'),
      );
      return;
    }
    const col = (s: string, w: number) => s.slice(0, w).padEnd(w);
    const header = `${'CONTAINER'.padEnd(32)} ${'PROFILE'.padEnd(16)} ${'STATE'.padEnd(12)} ${'IMAGE'.padEnd(34)} WORKDIR`;
    console.log(chalk.bold(header));
    console.log(chalk.dim('─'.repeat(header.length)));
    for (const container of containers) {
      const state = container.state || 'unknown';
      const stateColored = container.running
        ? chalk.green(state)
        : chalk.yellow(state);
      const details = args.details
        ? ` exit=${container.exitCode ?? 'unknown'} health=${container.health ?? 'unknown'}`
        : '';
      console.log(
        `${col(container.name, 32)} ${col(container.profile || '-', 16)} ${stateColored}${' '.repeat(Math.max(0, 12 - state.length))} ${col(container.image, 34)} ${container.workdir || container.project || '-'}${details}`,
      );
    }
  },
});
