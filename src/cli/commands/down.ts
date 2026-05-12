import chalk from 'chalk';
import { defineCommand } from 'citty';
import { computeProjectHash } from '../../container/builder.ts';
import {
  removeSidecarNetwork,
  sidecarNetworkName,
} from '../../container/sidecars.ts';
import { dockerExec } from '../../runtime/docker.ts';

export default defineCommand({
  args: {
    all: {
      default: false,
      description: 'Stop all ccpod containers on this machine',
      type: 'boolean',
    },
    profile: { description: 'Limit to a specific profile', type: 'string' },
  },
  meta: {
    description: 'Stop and remove ccpod containers for the current project',
  },
  async run({ args }) {
    const currentProjectHash = computeProjectHash(process.cwd());

    const filterArgs: string[] = args.all
      ? ['--filter', 'label=ccpod.profile']
      : ['--filter', `label=ccpod.project=${currentProjectHash}`];

    if (!args.all && args.profile) {
      filterArgs.push('--filter', `label=ccpod.profile=${args.profile}`);
    }

    // Single inspect that returns id, name, status, and project label so the
    // loop below stays at one round-trip per container instead of three.
    const { stdout } = await dockerExec([
      'ps',
      '-a',
      '--format',
      '{{.ID}}|{{.Names}}|{{.Status}}|{{.Label "ccpod.project"}}',
      ...filterArgs,
    ]);
    const rows = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const [id = '', name = '', status = '', projectHash = ''] =
          line.split('|');
        return { id, name, projectHash, status };
      })
      .filter((row) => row.id);

    if (rows.length === 0) {
      console.log(
        `No ccpod containers found${args.all ? '.' : ' for this project.'}`,
      );
      return;
    }

    const touchedProjectHashes = new Set<string>();

    for (const row of rows) {
      if (row.projectHash) {
        touchedProjectHashes.add(row.projectHash);
      }
      const displayName = row.name || row.id.slice(0, 12);
      const isRunning = row.status.toLowerCase().startsWith('up');

      if (isRunning) {
        process.stdout.write(`Stopping ${chalk.cyan(displayName)}... `);
        const stopResult = await dockerExec(['stop', '-t', '5', row.id]);
        if (stopResult.exitCode !== 0) {
          console.log(chalk.red('failed'));
          console.error(`  ${stopResult.stderr}`);
          continue;
        }
        console.log(chalk.green('done'));
      }

      process.stdout.write(`Removing ${chalk.cyan(displayName)}... `);
      const rmResult = await dockerExec(['rm', row.id]);
      if (rmResult.exitCode !== 0) {
        // A concurrent run may have removed the container already — treat
        // "no such container" as success rather than failing the command.
        if (/no such container/i.test(rmResult.stderr)) {
          console.log(chalk.dim('already gone'));
        } else {
          console.log(chalk.red('failed'));
          console.error(`  ${rmResult.stderr}`);
        }
      } else {
        console.log(chalk.green('done'));
      }
    }

    // Remove each project's shared sidecar network, but only when no
    // containers still reference it. This prevents `--profile` from tearing
    // down the network while sibling profiles are still running, and ensures
    // `--all` cleans up networks per project.
    for (const projectHash of touchedProjectHashes) {
      const { stdout: remaining } = await dockerExec([
        'ps',
        '-a',
        '-q',
        '--filter',
        `label=ccpod.project=${projectHash}`,
      ]);
      if (remaining.trim() === '') {
        await removeSidecarNetwork(sidecarNetworkName(projectHash)).catch(
          () => {},
        );
      }
    }
  },
});
