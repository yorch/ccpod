# ccpod config get/set — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ccpod config get <key>` and `ccpod config set <key> <value>` subcommands for managing global ccpod settings.

**Architecture:** Two new command files under `src/cli/commands/config/`. The `set.ts` file owns the `KNOWN_KEYS` coercion map (exported so `get.ts` can import it for key validation). Both commands delegate I/O to the existing `loadGlobalConfig`/`saveGlobalConfig` functions in `src/global/config.ts` — no changes needed there.

**Tech Stack:** TypeScript, Bun, citty (CLI framework), chalk (terminal colors), bun:test (test runner)

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `src/cli/commands/config/set.ts` | `ccpod config set <key> <value>` — coercion map + command |
| Create | `src/cli/commands/config/get.ts` | `ccpod config get <key>` — reads and prints value |
| Modify | `src/cli/commands/config/index.ts` | Register `get` and `set` subcommands |
| Create | `tests/unit/cli/config/set.test.ts` | Unit tests for set command |
| Create | `tests/unit/cli/config/get.test.ts` | Unit tests for get command |

---

## Task 1: Write failing tests for `set` command

**Files:**
- Create: `tests/unit/cli/config/set.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('ccpod config set', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dir, `__tmp_set_${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.CCPOD_TEST_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
    delete process.env.CCPOD_TEST_DIR;
  });

  describe('KNOWN_KEYS coercion', () => {
    it('coerces "true" to boolean true', async () => {
      const { KNOWN_KEYS } = await import(
        '../../../../src/cli/commands/config/set.ts'
      );
      expect(KNOWN_KEYS.autoCheckUpdates('true')).toBe(true);
    });

    it('coerces "1" to boolean true', async () => {
      const { KNOWN_KEYS } = await import(
        '../../../../src/cli/commands/config/set.ts'
      );
      expect(KNOWN_KEYS.autoCheckUpdates('1')).toBe(true);
    });

    it('coerces "false" to boolean false', async () => {
      const { KNOWN_KEYS } = await import(
        '../../../../src/cli/commands/config/set.ts'
      );
      expect(KNOWN_KEYS.autoCheckUpdates('false')).toBe(false);
    });

    it('coerces "0" to boolean false', async () => {
      const { KNOWN_KEYS } = await import(
        '../../../../src/cli/commands/config/set.ts'
      );
      expect(KNOWN_KEYS.autoCheckUpdates('0')).toBe(false);
    });

    it('throws on invalid boolean string', async () => {
      const { KNOWN_KEYS } = await import(
        '../../../../src/cli/commands/config/set.ts'
      );
      expect(() => KNOWN_KEYS.autoCheckUpdates('notabool')).toThrow(
        'expected boolean (true/false)',
      );
    });
  });

  describe('run()', () => {
    it('writes value and prints confirmation', async () => {
      const cmd = (
        await import('../../../../src/cli/commands/config/set.ts')
      ).default;
      const { loadGlobalConfig } = await import(
        '../../../../src/global/config.ts'
      );
      const logs: string[] = [];
      const logSpy = spyOn(console, 'log').mockImplementation((m) =>
        logs.push(m),
      );

      await cmd.run({ args: { key: 'autoCheckUpdates', value: 'false' } } as never);

      logSpy.mockRestore();
      expect(logs).toContain('autoCheckUpdates = false');
      expect(loadGlobalConfig().autoCheckUpdates).toBe(false);
    });

    it('exits 1 on unknown key', async () => {
      const cmd = (
        await import('../../../../src/cli/commands/config/set.ts')
      ).default;
      const errors: string[] = [];
      const errSpy = spyOn(console, 'error').mockImplementation((m) =>
        errors.push(m),
      );
      const exitSpy = spyOn(process, 'exit').mockImplementation(
        (() => {
          throw new Error('process.exit');
        }) as never,
      );

      expect(() =>
        cmd.run({ args: { key: 'nonexistent', value: 'x' } } as never),
      ).toThrow('process.exit');

      errSpy.mockRestore();
      exitSpy.mockRestore();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errors[0]).toContain("unknown config key 'nonexistent'");
      expect(errors[0]).toContain('autoCheckUpdates');
    });

    it('exits 1 on invalid value', async () => {
      const cmd = (
        await import('../../../../src/cli/commands/config/set.ts')
      ).default;
      const errors: string[] = [];
      const errSpy = spyOn(console, 'error').mockImplementation((m) =>
        errors.push(m),
      );
      const exitSpy = spyOn(process, 'exit').mockImplementation(
        (() => {
          throw new Error('process.exit');
        }) as never,
      );

      expect(() =>
        cmd.run({
          args: { key: 'autoCheckUpdates', value: 'notabool' },
        } as never),
      ).toThrow('process.exit');

      errSpy.mockRestore();
      exitSpy.mockRestore();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errors[0]).toContain("invalid value for 'autoCheckUpdates'");
      expect(errors[0]).toContain('expected boolean (true/false)');
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail (file doesn't exist yet)**

```bash
bun test tests/unit/cli/config/set.test.ts
```

Expected: error — `Cannot find module '../../../../src/cli/commands/config/set.ts'`

---

## Task 2: Implement `src/cli/commands/config/set.ts`

**Files:**
- Create: `src/cli/commands/config/set.ts`

- [ ] **Step 1: Create the file**

```typescript
import chalk from 'chalk';
import { defineCommand } from 'citty';
import type { GlobalConfig } from '../../../global/config.ts';
import {
  loadGlobalConfig,
  saveGlobalConfig,
} from '../../../global/config.ts';

export const KNOWN_KEYS = {
  autoCheckUpdates: (v: string): boolean => {
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    throw new Error('expected boolean (true/false)');
  },
} satisfies Record<keyof GlobalConfig, (v: string) => unknown>;

export default defineCommand({
  args: {
    key: { description: 'Config key to set', required: true, type: 'positional' },
    value: { description: 'Value to set', required: true, type: 'positional' },
  },
  meta: { description: 'Set a global ccpod config value' },
  run({ args }) {
    const key = args.key as string;
    const rawValue = args.value as string;

    if (!(key in KNOWN_KEYS)) {
      console.error(
        `${chalk.red('error:')} unknown config key '${key}'. Known keys: ${Object.keys(KNOWN_KEYS).join(', ')}`,
      );
      process.exit(1);
    }

    let coerced: unknown;
    try {
      coerced = KNOWN_KEYS[key as keyof GlobalConfig](rawValue);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `${chalk.red('error:')} invalid value for '${key}': ${msg}`,
      );
      process.exit(1);
    }

    const config = loadGlobalConfig();
    saveGlobalConfig({ ...config, [key]: coerced });
    console.log(`${key} = ${coerced}`);
  },
});
```

- [ ] **Step 2: Run tests to confirm they pass**

```bash
bun test tests/unit/cli/config/set.test.ts
```

Expected: `8 pass, 0 fail`

---

## Task 3: Write failing tests for `get` command

**Files:**
- Create: `tests/unit/cli/config/get.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('ccpod config get', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dir, `__tmp_get_${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.CCPOD_TEST_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
    delete process.env.CCPOD_TEST_DIR;
  });

  it('prints current value when config file exists', async () => {
    const { saveGlobalConfig } = await import(
      '../../../../src/global/config.ts'
    );
    saveGlobalConfig({ autoCheckUpdates: false });

    const cmd = (
      await import('../../../../src/cli/commands/config/get.ts')
    ).default;
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((m) =>
      logs.push(m),
    );

    await cmd.run({ args: { key: 'autoCheckUpdates' } } as never);

    logSpy.mockRestore();
    expect(logs).toContain('false');
  });

  it('prints default value when no config file exists', async () => {
    const cmd = (
      await import('../../../../src/cli/commands/config/get.ts')
    ).default;
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((m) =>
      logs.push(m),
    );

    await cmd.run({ args: { key: 'autoCheckUpdates' } } as never);

    logSpy.mockRestore();
    expect(logs).toContain('true');
  });

  it('exits 1 on unknown key', async () => {
    const cmd = (
      await import('../../../../src/cli/commands/config/get.ts')
    ).default;
    const errors: string[] = [];
    const errSpy = spyOn(console, 'error').mockImplementation((m) =>
      errors.push(m),
    );
    const exitSpy = spyOn(process, 'exit').mockImplementation(
      (() => {
        throw new Error('process.exit');
      }) as never,
    );

    expect(() =>
      cmd.run({ args: { key: 'nonexistent' } } as never),
    ).toThrow('process.exit');

    errSpy.mockRestore();
    exitSpy.mockRestore();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errors[0]).toContain("unknown config key 'nonexistent'");
    expect(errors[0]).toContain('autoCheckUpdates');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail (file doesn't exist yet)**

```bash
bun test tests/unit/cli/config/get.test.ts
```

Expected: error — `Cannot find module '../../../../src/cli/commands/config/get.ts'`

---

## Task 4: Implement `src/cli/commands/config/get.ts`

**Files:**
- Create: `src/cli/commands/config/get.ts`

- [ ] **Step 1: Create the file**

```typescript
import chalk from 'chalk';
import { defineCommand } from 'citty';
import type { GlobalConfig } from '../../../global/config.ts';
import { loadGlobalConfig } from '../../../global/config.ts';
import { KNOWN_KEYS } from './set.ts';

export default defineCommand({
  args: {
    key: { description: 'Config key to read', required: true, type: 'positional' },
  },
  meta: { description: 'Get a global ccpod config value' },
  run({ args }) {
    const key = args.key as string;

    if (!(key in KNOWN_KEYS)) {
      console.error(
        `${chalk.red('error:')} unknown config key '${key}'. Known keys: ${Object.keys(KNOWN_KEYS).join(', ')}`,
      );
      process.exit(1);
    }

    const config = loadGlobalConfig();
    console.log(String(config[key as keyof GlobalConfig]));
  },
});
```

- [ ] **Step 2: Run tests to confirm they pass**

```bash
bun test tests/unit/cli/config/get.test.ts
```

Expected: `3 pass, 0 fail`

---

## Task 5: Wire subcommands into `config/index.ts`

**Files:**
- Modify: `src/cli/commands/config/index.ts`

- [ ] **Step 1: Update the file to register `get` and `set`**

Replace the entire file with:

```typescript
import { defineCommand } from 'citty';

export default defineCommand({
  meta: { description: 'Inspect and validate ccpod configuration' },
  subCommands: {
    get: () => import('./get.ts').then((m) => m.default),
    set: () => import('./set.ts').then((m) => m.default),
    show: () => import('./show.ts').then((m) => m.default),
    validate: () => import('./validate.ts').then((m) => m.default),
  },
});
```

- [ ] **Step 2: Run full unit test suite to confirm nothing broke**

```bash
bun test tests/unit/
```

Expected: all pass, 0 fail

- [ ] **Step 3: Run quality gates**

```bash
bun run typecheck && bun run check
```

Expected: no errors. If biome reformats anything, stage those changes too.

- [ ] **Step 4: Smoke test manually**

```bash
bun run dev config get autoCheckUpdates
# Expected output: true

bun run dev config set autoCheckUpdates false
# Expected output: autoCheckUpdates = false

bun run dev config get autoCheckUpdates
# Expected output: false

bun run dev config get badkey
# Expected: error: unknown config key 'badkey'. Known keys: autoCheckUpdates

bun run dev config set autoCheckUpdates notabool
# Expected: error: invalid value for 'autoCheckUpdates': expected boolean (true/false)

# Reset to default
bun run dev config set autoCheckUpdates true
```

- [ ] **Step 5: Commit**

```bash
git add \
  src/cli/commands/config/get.ts \
  src/cli/commands/config/set.ts \
  src/cli/commands/config/index.ts \
  tests/unit/cli/config/get.test.ts \
  tests/unit/cli/config/set.test.ts \
  docs/superpowers/specs/2026-05-01-config-get-set-design.md \
  docs/superpowers/plans/2026-05-01-config-get-set.md
git commit -m 'feat(config): add `config get` and `config set` subcommands for global settings'
```
