import chalk from 'chalk';
import { defineCommand } from 'citty';
import {
  computeProjectHash,
  LABEL_PROFILE,
  LABEL_PROJECT,
} from '../../container/builder.ts';
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
      ? ['--filter', `label=${LABEL_PROFILE}`]
      : ['--filter', `label=${LABEL_PROJECT}=${currentProjectHash}`];

    if (!args.all && args.profile) {
      filterArgs.push('--filter', `label=${LABEL_PROFILE}=${args.profile}`);
    }

    const { stdout } = await dockerExec([
      'ps',
      '-a',
      '--format',
      `{{.ID}}|{{.Names}}|{{.State}}|{{.Label "${LABEL_PROJECT}"}}`,
      ...filterArgs,
    ]);
    const rows = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const [id = '', name = '', state = '', projectHash = ''] =
          line.split('|');
        return { id, name, projectHash, state };
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
      // `.State` is the machine-readable lifecycle field: running, paused,
      // restarting, exited, created, dead, removing. Anything other than
      // "exited", "created", "dead", or "" still needs a stop before rm.
      const needsStop =
        row.state !== '' &&
        row.state !== 'exited' &&
        row.state !== 'created' &&
        row.state !== 'dead';

      if (needsStop) {
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

    // Only drop a project's shared sidecar network once nothing references
    // its label — sibling profiles may still be using it.
    for (const projectHash of touchedProjectHashes) {
      const { stdout: remaining } = await dockerExec([
        'ps',
        '-a',
        '-q',
        '--filter',
        `label=${LABEL_PROJECT}=${projectHash}`,
      ]);
      if (remaining.trim() === '') {
        await removeSidecarNetwork(sidecarNetworkName(projectHash)).catch(
          () => {},
        );
      }
    }
  },
});
