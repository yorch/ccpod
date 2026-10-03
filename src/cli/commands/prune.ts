import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { LABEL_PROFILE, LABEL_PROJECT } from '../../container/builder.ts';
import { listCcpodContainers } from '../../container/list.ts';
import { removeVolume } from '../../plugins/volume.ts';
import {
  getCcpodHome,
  PROJECT_MARKER_FILE,
  profileExists,
} from '../../profile/manager.ts';
import { dockerExec } from '../../runtime/docker.ts';
import { rejectExtraPositionals } from '../args.ts';
import { exitWithError } from '../errors.ts';
import { validateProfileArg } from '../validate.ts';

const VOLUME_NAME_RE = /^ccpod-plugins-([a-zA-Z0-9_-]{1,64})$/;
const PROJECT_HASH_RE = /^[a-f0-9]{16}$/;

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
    // Only a volume whose profile is gone from disk is orphaned. Not even
    // --profile overrides this: step 1 of prune removes that profile's stopped
    // containers, which would make a live profile's volume look unreferenced.
    if (profileExists(prof)) {
      continue;
    }
    orphaned.push({ name: volName, profile: prof });
  }
  return orphaned;
}

interface OrphanedStateDir {
  path: string;
  profile: string;
  projectHash: string;
  projectPath: string;
}

interface StateScan {
  orphaned: OrphanedStateDir[];
  // Dirs with no .ccpod-project marker (created by an older ccpod): their
  // project is unknown, so they are never deleted automatically.
  unknown: number;
}

// A per-project state dir is orphaned when the project it was created for no
// longer exists on disk. Container existence is NOT evidence either way:
// containers are not run with --rm, `ccpod down` and prune step 1 remove them,
// and none of that means the user is done with the project's history.
async function scanStateDirs(profile?: string): Promise<StateScan> {
  const stateBase = join(getCcpodHome(), 'state');
  const result: StateScan = { orphaned: [], unknown: 0 };
  if (!existsSync(stateBase)) {
    return result;
  }

  // Still protect state in use right now (docker unreachable => stop).
  const containers = await listCcpodContainers({
    all: true,
    ...(profile ? { profile } : {}),
  });
  const activeKeys = new Set(
    containers.map((c) => `${c.profile}/${c.project}`),
  );

  const profileDirs = profile
    ? [profile]
    : readdirSync(stateBase, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

  for (const prof of profileDirs) {
    const profStateDir = join(stateBase, prof);
    if (!existsSync(profStateDir)) {
      continue;
    }
    for (const entry of readdirSync(profStateDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !PROJECT_HASH_RE.test(entry.name)) {
        continue;
      }
      if (activeKeys.has(`${prof}/${entry.name}`)) {
        continue;
      }
      const dir = join(profStateDir, entry.name);
      let projectPath: string;
      try {
        projectPath = readFileSync(
          join(dir, PROJECT_MARKER_FILE),
          'utf8',
        ).trim();
      } catch {
        result.unknown++;
        continue;
      }
      // Missing path counts only when its parent exists: a project on an
      // unmounted external/network volume must not look deleted.
      if (
        projectPath === '' ||
        existsSync(projectPath) ||
        !existsSync(dirname(projectPath))
      ) {
        continue;
      }
      result.orphaned.push({
        path: dir,
        profile: prof,
        projectHash: entry.name,
        projectPath,
      });
    }
  }
  return result;
}

export default defineCommand({
  args: {
    'dry-run': {
      default: false,
      description: 'Show what would be removed without making changes',
      type: 'boolean',
    },
    force: {
      alias: ['y', 'yes'],
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
    name: 'prune',
  },
  async run({ args }) {
    rejectExtraPositionals(args);
    validateProfileArg(args.profile);

    const dryRun = args['dry-run'];
    const action = dryRun ? 'Would remove' : 'Removing';

    // --- Stopped containers ---
    let containers: Awaited<ReturnType<typeof listCcpodContainers>>;
    try {
      containers = await listCcpodContainers({
        all: true,
        ...(args.profile ? { profile: args.profile } : {}),
      });
    } catch (err) {
      // Everything below decides what to delete from docker's answer; if we
      // can't get one, stop rather than guess.
      exitWithError(err);
    }
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
    // Sidecar networks are per project, not per profile, so a profile-scoped
    // prune must not touch them.
    const networks = args.profile ? [] : await listOrphanedNetworks();
    if (args.profile) {
      console.log(
        chalk.dim(
          'Skipping networks (not profile-scoped; run without --profile).',
        ),
      );
    } else if (networks.length > 0) {
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
    let volumeConfirmed = true;
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
        }
        volumeConfirmed = ok;
      }
      for (const v of volumeConfirmed ? volumes : []) {
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

    // --- Orphaned per-project state dirs ---
    let stateScan: StateScan;
    try {
      stateScan = await scanStateDirs(args.profile);
    } catch (err) {
      exitWithError(err);
    }
    const stateDirs = stateScan.orphaned;
    if (stateScan.unknown > 0) {
      console.log(
        chalk.dim(
          `Kept ${stateScan.unknown} state dir(s) with no recorded project path (created by an older ccpod; they are tagged the next time their project runs).`,
        ),
      );
    }
    let stateConfirmed = true;
    if (stateDirs.length > 0) {
      console.log(chalk.bold(`\n${stateDirs.length} orphaned state dir(s)`));
      if (!dryRun && !args.force) {
        const { confirm } = await import('@inquirer/prompts');
        const ok = await confirm({
          default: false,
          message: `Remove ${stateDirs.length} orphaned state dir(s)? This deletes conversation history for projects whose directory no longer exists.`,
        });
        if (!ok) {
          console.log(chalk.dim('Skipped state dirs.'));
        }
        stateConfirmed = ok;
      }
      for (const s of stateConfirmed ? stateDirs : []) {
        const label = `${s.profile}/${s.projectHash} (${s.projectPath})`;
        if (dryRun) {
          console.log(`  ${chalk.dim(action)} ${chalk.cyan(label)}`);
        } else {
          // Re-check for a container with this profile+hash before removing.
          // A container may have started between the initial scan and now.
          const { exitCode: recheckCode, stdout: recheckOut } =
            await dockerExec([
              'ps',
              '-a',
              '--filter',
              `label=${LABEL_PROFILE}=${s.profile}`,
              '--filter',
              `label=${LABEL_PROJECT}=${s.projectHash}`,
              '--quiet',
            ]);
          if (recheckCode !== 0) {
            // Can't prove the state is unused — keep it.
            console.log(chalk.dim('skipped (could not check containers)'));
            continue;
          }
          if (recheckOut.trim() !== '') {
            console.log(chalk.dim('skipped (container started)'));
            continue;
          }
          process.stdout.write(`  Removing ${chalk.cyan(label)}... `);
          try {
            rmSync(s.path, { force: true, recursive: true });
            console.log(chalk.green('done'));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(chalk.red('failed'));
            console.error(`  ${msg}`);
          }
        }
      }
    } else {
      console.log(chalk.dim('No orphaned state dirs found.'));
    }

    console.log(
      chalk.bold(`\n${dryRun ? 'Dry run complete.' : 'Prune complete.'}`),
    );
  },
});
