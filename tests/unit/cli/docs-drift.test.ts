import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guards against the CLI reference drifting from the commands: every command
// path and every non-positional flag must be mentioned in the CLI reference.

type Cmd = {
  args?: Record<string, { type?: string }>;
  subCommands?: Record<string, unknown>;
};

async function resolve(v: unknown): Promise<Cmd> {
  return (typeof v === 'function' ? await v() : await v) as Cmd;
}

async function walk(
  cmd: Cmd,
  path: string[],
  out: Array<{ flags: string[]; path: string }>,
): Promise<void> {
  const subs = cmd.subCommands ? Object.entries(cmd.subCommands) : [];
  if (subs.length === 0) {
    const flags = Object.entries(cmd.args ?? {})
      .filter(([, a]) => a.type !== 'positional')
      // citty parses --no-state as state=false, so `state` is documented as --no-state.
      .map(([name]) => (name === 'state' ? 'no-state' : name));
    out.push({ flags, path: path.join(' ') });
    return;
  }
  for (const [name, sub] of subs) {
    await walk(await resolve(sub), [...path, name], out);
  }
}

describe('CLI reference', () => {
  it('documents every command and flag', async () => {
    // Importing cli/index.ts would run the CLI, so read its lazy imports
    // instead: a command added there but undocumented fails this test.
    const indexSrc = readFileSync(
      join(import.meta.dir, '../../../src/cli/index.ts'),
      'utf8',
    );
    const entries = [
      ...indexSrc.matchAll(
        /^\s+(\w+): \(\) => import\('\.\/commands\/([^']+)'\)/gm,
      ),
    ];
    expect(entries.length).toBeGreaterThan(5);
    const root: Cmd = {
      subCommands: Object.fromEntries(
        entries.map(([, name, file]) => [
          name,
          () =>
            import(`../../../src/cli/commands/${file}`).then((m) => m.default),
        ]),
      ),
    };
    const commands: Array<{ flags: string[]; path: string }> = [];
    await walk(root, [], commands);

    const doc = readFileSync(
      join(
        import.meta.dir,
        '../../../website/src/content/docs/reference/cli.md',
      ),
      'utf8',
    );

    // Flags must appear in a section (## / ###) that mentions the command, so
    // a flag documented for one command does not satisfy another.
    const sections = doc.split(/^#{2,3} /m);
    const missing: string[] = [];
    for (const { flags, path } of commands) {
      const own = sections.filter((s) => s.includes(`ccpod ${path}`));
      if (own.length === 0) {
        missing.push(`command: ccpod ${path}`);
        continue;
      }
      for (const flag of flags) {
        if (!own.some((s) => s.includes(`--${flag}`))) {
          missing.push(`flag: ccpod ${path} --${flag}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
