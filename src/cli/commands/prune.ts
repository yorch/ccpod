import chalk from 'chalk';
import { defineCommand } from 'citty';
import { LABEL_PROFILE } from '../../container/builder.ts';
import { removeVolume } from '../../plugins/volume.ts';
import { profileExists } from '../../profile/manager.ts';
import { dockerExec } from '../../runtime/docker.ts';
import { validateProfileArg } from '../validate.ts';

const VOLUME_NAME_RE = /^ccpod-plugins-([a-zA-Z0-9_-]{1,64})$/;

interface StaleContainer {
  id: string;
  name: string;
  profile: string;
  state: string;
}

async function listStaleContainers(
  profile?: string,
): Promise<StaleContainer[]> {
  const filterArgs = ['-a', '--filter', `label=${LABEL_PROFILE}`];
  if (profile) {
    filterArgs.push('--filter', `label=${LABEL_PROFILE}=${profile}`);
  }
  const { exitCode, stdout, stderr } = await dockerExec([
    'ps',
    ...filterArgs,
    '--format',
    '{{.ID}}|{{.Names}}|{{.State}}|{{.Label "ccpod.profile"}}',
  ]);
  if (exitCode !== 0) {
    console.warn(`Warning: docker ps failed: ${stderr}`);
    return [];
  }
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = '', name = '', state = '', prof = ''] = line.split('|');
      return { id, name, profile: prof, state };
    })
    .filter((row) => row.id);
}

async function listOrphanedNetworks(): Promise<string[]> {
  const { exitCode, stdout, stderr } = await dockerExec([
    'network',
    'ls',
    '--filter',
    'name=ccpod-net-',
    '--format',
    '{{.Name}}',
  ]);
  if (exitCode !== 0) {
    console.warn(`Warning: docker network ls failed: ${stderr}`);
    return [];
  }
  const names = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((n) => n.startsWith('ccpod-net-'));

  const orphaned: string[] = [];
  for (const name of names) {
    const {
      exitCode: inspectCode,
      stdout: inspect,
      stderr: inspectErr,
    } = await dockerExec([
      'network',
      'inspect',
      '-f',
      '{{json .Containers}}',
      name,
    ]);
    if (inspectCode !== 0) {
      // Skip networks we can't inspect — treat as in-use to avoid accidental removal.
      console.warn(`Warning: could not inspect network ${name}: ${inspectErr}`);
      continue;
    }
    // Empty container map means no endpoints attached. Docker returns `{}`,
    // but Podman or non-bridge networks may return `null` or `<no value>`.
    const trimmed = inspect.trim();
    if (
      trimmed === '{}' ||
      trimmed === '' ||
      trimmed === 'null' ||
      trimmed === '<no value>'
    ) {
      orphaned.push(name);
    }
  }
  return orphaned;
}

async function listOrphanedVolumes(
  profile?: string,
): Promise<{ name: string; profile: string }[]> {
  const { exitCode, stdout, stderr } = await dockerExec([
    'volume',
    'ls',
    '--filter',
    'name=ccpod-plugins-',
    '--format',
    '{{.Name}}',
  ]);
  if (exitCode !== 0) {
    console.warn(`Warning: docker volume ls failed: ${stderr}`);
    return [];
  }
  const names = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((n) => n.startsWith('ccpod-plugins-'));

  const orphaned: { name: string; profile: string }[] = [];
  for (const volName of names) {
    // Strict parse: only accept volumes with a valid profile name suffix.
    // Prevents path traversal from crafted volume names (e.g. ccpod-plugins-..).
    const match = volName.match(VOLUME_NAME_RE);
    if (!match?.[1]) {
      continue;
    }
    const prof = match[1];
    if (profile && prof !== profile) {
      continue;
    }
    // Check if ANY container references this volume (not just ccpod-labeled
    // ones — a non-ccpod container could still be mounting it).
    const {
      exitCode: refCode,
      stdout: refs,
      stderr: refErr,
    } = await dockerExec(['ps', '-a', '-q', '--filter', `volume=${volName}`]);
    if (refCode !== 0) {
      // Can't determine if the volume is in use — skip it to avoid accidental removal.
      console.warn(
        `Warning: could not check volume references for ${volName}: ${refErr}`,
      );
      continue;
    }
    if (refs.trim() !== '') {
      continue;
    }
    // If no profile filter, only consider orphaned if the profile no longer
    // exists on disk. With a profile filter, the caller explicitly wants it.
    if (!profile && profileExists(prof)) {
      continue;
    }
    orphaned.push({ name: volName, profile: prof });
  }
  return orphaned;
}

export default defineCommand({
  args: {
    'dry-run': {
      default: false,
      description: 'Show what would be removed without making changes',
      type: 'boolean',
    },
    force: {
      default: false,
      description: 'Skip confirmation prompt',
      type: 'boolean',
    },
    profile: {
      description: 'Restrict cleanup to a specific profile',
      type: 'string',
    },
  },
  meta: {
    description:
      'Remove stopped ccpod containers, orphaned networks, and unreferenced plugin volumes',
  },
  async run({ args }) {
    validateProfileArg(args.profile);

    const dryRun = args['dry-run'];
    const action = dryRun ? 'Would remove' : 'Removing';

    // --- Stopped containers ---
    const containers = await listStaleContainers(args.profile);
    const staleContainers = containers.filter(
      (c) =>
        c.state !== 'running' &&
        c.state !== 'paused' &&
        c.state !== 'restarting',
    );

    if (staleContainers.length > 0) {
      console.log(
        chalk.bold(`\n${staleContainers.length} stopped container(s)`),
      );
      for (const c of staleContainers) {
        const displayName = c.name || c.id.slice(0, 12);
        if (dryRun) {
          console.log(`  ${chalk.dim(action)} ${chalk.cyan(displayName)}`);
        } else {
          process.stdout.write(`  Removing ${chalk.cyan(displayName)}... `);
          const rmResult = await dockerExec(['rm', c.id]);
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
      }
    } else {
      console.log(chalk.dim('\nNo stopped ccpod containers found.'));
    }

    // --- Orphaned networks ---
    const networks = await listOrphanedNetworks();
    if (networks.length > 0) {
      console.log(chalk.bold(`\n${networks.length} orphaned network(s)`));
      for (const name of networks) {
        if (dryRun) {
          console.log(`  ${chalk.dim(action)} ${chalk.cyan(name)}`);
        } else {
          process.stdout.write(`  Removing ${chalk.cyan(name)}... `);
          const rmResult = await dockerExec(['network', 'rm', name]);
          if (rmResult.exitCode !== 0) {
            if (/no such network/i.test(rmResult.stderr)) {
              console.log(chalk.dim('already gone'));
            } else {
              console.log(chalk.red('failed'));
              console.error(`  ${rmResult.stderr}`);
            }
          } else {
            console.log(chalk.green('done'));
          }
        }
      }
    } else {
      console.log(chalk.dim('No orphaned ccpod networks found.'));
    }

    // --- Unreferenced plugin volumes ---
    const volumes = await listOrphanedVolumes(args.profile);
    if (volumes.length > 0) {
      console.log(
        chalk.bold(`\n${volumes.length} unreferenced plugin volume(s)`),
      );
      if (!dryRun && !args.force) {
        const { confirm } = await import('@inquirer/prompts');
        const ok = await confirm({
          default: false,
          message: `Remove ${volumes.length} plugin volume(s)? Plugin installs will be recreated on next run.`,
        });
        if (!ok) {
          console.log(chalk.dim('Skipped volumes.'));
          console.log(
            chalk.bold(`\n${dryRun ? 'Dry run complete.' : 'Prune complete.'}`),
          );
          return;
        }
      }
      for (const v of volumes) {
        if (dryRun) {
          console.log(`  ${chalk.dim(action)} ${chalk.cyan(v.name)}`);
        } else {
          process.stdout.write(`  Removing ${chalk.cyan(v.name)}... `);
          try {
            await removeVolume(v.name);
            console.log(chalk.green('done'));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(chalk.red('failed'));
            console.error(`  ${msg}`);
          }
        }
      }
    } else {
      console.log(chalk.dim('No unreferenced plugin volumes found.'));
    }

    console.log(
      chalk.bold(`\n${dryRun ? 'Dry run complete.' : 'Prune complete.'}`),
    );
  },
});
