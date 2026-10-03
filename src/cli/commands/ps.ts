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
    json: {
      default: false,
      description: 'Output as JSON',
      type: 'boolean',
    },
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
    const HEADER = `${'CONTAINER'.padEnd(32)} ${'PROFILE'.padEnd(16)} ${'STATE'.padEnd(10)} ${'IMAGE'.padEnd(34)} WORKDIR`;
    console.log(chalk.bold(HEADER));
    console.log(chalk.dim('─'.repeat(HEADER.length)));

    for (const c of containers) {
      const stateRaw = c.running ? 'running' : 'stopped';
      const stateColored = c.running
        ? chalk.green(stateRaw)
        : chalk.yellow(stateRaw);
      const statePad = ' '.repeat(Math.max(0, 10 - stateRaw.length));
      console.log(
        `${col(c.name, 32)} ${col(c.profile || '-', 16)} ${stateColored}${statePad} ${col(c.image, 34)} ${c.workdir || c.project || '-'}`,
      );
    }
  },
});
