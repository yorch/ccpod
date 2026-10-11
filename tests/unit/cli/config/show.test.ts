import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalCwd = process.cwd();
const originalTestDir = process.env.CCPOD_TEST_DIR;
afterEach(() => {
  process.chdir(originalCwd);
  if (originalTestDir === undefined) {
    delete process.env.CCPOD_TEST_DIR;
  } else {
    process.env.CCPOD_TEST_DIR = originalTestDir;
  }
});

describe('ccpod config show', () => {
  it('preserves plain JSON shape and redacts env/service literals', async () => {
    const root = join(tmpdir(), `ccpod-show-${Date.now()}`);
    const project = join(root, 'project');
    const profileDir = join(root, '.ccpod', 'profiles', 'default');
    mkdirSync(project, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    process.env.CCPOD_TEST_DIR = join(root, '.ccpod');
    process.chdir(project);
    writeFileSync(
      join(profileDir, 'profile.yml'),
      [
        'name: default',
        'config: { source: local }',
        'auth: { type: proxy }',
        'services:',
        '  db:',
        '    image: postgres',
        '    env: { PASSWORD: from-profile }',
        'allowProjectEnvForward: [SAFE_FORWARD]',
        'env: [SAFE=value, PATH=/trusted]',
        'image: { use: test-image }',
        'network: { policy: full }',
        'ports: { list: [] }',
        'ssh: {}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(project, '.ccpod.yml'),
      [
        'env:',
        '  - "MODE=quiet"',
        `  - "TOKEN=\${HOST_SECRET}"`,
        '  - "PATH=/blocked"',
        '  - "  SAFE_FORWARD  "',
        '  - "  CUSTOM=literal  "',
        'services:',
        '  api:',
        '    image: api',
        '    env: { PASSWORD: from-project }',
        '',
      ].join('\n'),
    );
    const command = (
      await import('../../../../src/cli/commands/config/show.ts')
    ).default;
    const output: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((line) =>
      output.push(line),
    );
    try {
      await command.run({ args: { json: true } } as never);
      const result = JSON.parse(output.join('\n'));
      expect(Object.keys(result).sort()).toEqual(
        [
          'allowProject',
          'auth',
          'autoDetectMcp',
          'claudeArgs',
          'env',
          'image',
          'init',
          'isolation',
          'network',
          'permissions',
          'plugins',
          'ports',
          'profile',
          'services',
          'ssh',
          'state',
          'stateIsolation',
        ].sort(),
      );
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain('from-profile');
      expect(rendered).not.toContain('from-project');
      expect(rendered).not.toContain('HOST_SECRET');
      expect(result.env.MODE).toBe('<redacted>');
      expect(result.env.PATH).toBe('<redacted>');
      expect(result.env.SAFE_FORWARD).toBe('<forwarded from host env>');
      expect(result.env.CUSTOM).toBe('<redacted>');
      expect(result.env.TOKEN).toBe('<redacted>');
      expect(result.services.db.env.PASSWORD).toBe('<redacted>');

      const profilePath = join(profileDir, 'profile.yml');
      const originalProfile = readFileSync(profilePath, 'utf8');
      const errors: string[] = [];
      const errorLog = spyOn(console, 'error').mockImplementation((line) =>
        errors.push(String(line)),
      );
      const exit = spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);
      try {
        for (const profileHasToken of [true, false]) {
          writeFileSync(
            profilePath,
            profileHasToken
              ? originalProfile.replace(
                  'env: [SAFE=value, PATH=/trusted]',
                  'env: [SAFE=value, PATH=/trusted, TOKEN=profile-literal]',
                )
              : originalProfile,
          );
          output.length = 0;
          errors.length = 0;
          expect(() =>
            command.run({ args: { explain: true, json: true } } as never),
          ).toThrow('process.exit');
          const diagnostic = errors.join('\\n');
          expect(diagnostic).toContain('error:');
          expect(diagnostic).toContain('project.env[1] (TOKEN)');
          expect(diagnostic).toContain('runtime setup rejects this entry');
          expect(diagnostic).not.toContain('ignored');
          expect(diagnostic).not.toContain('HOST_SECRET');
          expect(output).toEqual([]);
        }
      } finally {
        errorLog.mockRestore();
        exit.mockRestore();
      }
    } finally {
      log.mockRestore();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
