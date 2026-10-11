import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

describe('ccpod config validate', () => {
  it('aggregates project/profile errors and refuses path access for invalid project profile names', async () => {
    const root = join(tmpdir(), `ccpod-validate-${Date.now()}`);
    const project = join(root, 'project');
    const ccpod = join(root, '.ccpod');
    mkdirSync(project, { recursive: true });
    mkdirSync(ccpod, { recursive: true });
    process.env.CCPOD_TEST_DIR = ccpod;
    process.chdir(project);
    writeFileSync(join(project, '.ccpod.yml'), 'profile: "../../outside"\n');

    const command = (
      await import('../../../../src/cli/commands/config/validate.ts')
    ).default;
    const output: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((line) =>
      output.push(String(line)),
    );
    const exit = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    try {
      expect(() => command.run({ args: {} } as never)).toThrow('exit');
      const rendered = output.join('\n');
      expect(rendered).toContain('.ccpod.yml');
      expect(rendered).toContain('profile.yml');
      expect(rendered).toContain('Profile name may only contain letters');
      expect(rendered).not.toContain(
        join(ccpod, 'profiles', '..', '..', 'outside'),
      );
    } finally {
      log.mockRestore();
      exit.mockRestore();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
