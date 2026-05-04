# Profile Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ccpod profile install <source>` and `ccpod profile export <name>` so users can share profile configs via git repos, raw URLs, local files, or self-contained base64 strings.

**Architecture:** Two thin CLI commands delegate to two new modules: `src/profile/exporter.ts` (reads + base64-encodes) and `src/profile/installer.ts` (detects source type, fetches YAML, validates). The install command handles conflict resolution interactively. No registry; no server; no new dependencies.

**Tech Stack:** TypeScript, Bun, `bun:test`, `simple-git` (already in deps), `@inquirer/prompts` (already in deps), `chalk`, `citty`, `yaml`, `zod`

---

## File Map

| Path | Action | Purpose |
|------|--------|---------|
| `src/profile/exporter.ts` | Create | `exportProfile(name)` — reads profile.yml, returns base64 string |
| `src/profile/installer.ts` | Create | `detectSource(input)` + `fetchProfileYaml(source)` — source detection and fetching |
| `src/cli/commands/profile/export.ts` | Create | Thin command — calls exporter, writes to stdout |
| `src/cli/commands/profile/install.ts` | Create | Thin command — conflict prompt, writes profile |
| `src/cli/commands/profile/index.ts` | Modify | Add `export` and `install` subcommands |
| `tests/unit/profile/exporter.test.ts` | Create | Unit tests for exporter |
| `tests/unit/profile/installer.test.ts` | Create | Unit tests for installer |

---

### Task 1: `src/profile/exporter.ts`

**Files:**
- Create: `src/profile/exporter.ts`
- Test: `tests/unit/profile/exporter.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/profile/exporter.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportProfile } from '../../../src/profile/exporter.ts';

let testBase: string;

beforeEach(() => {
  testBase = mkdtempSync(join(tmpdir(), 'ccpod-exporter-test-'));
  process.env.CCPOD_TEST_DIR = testBase;
});

afterEach(() => {
  delete process.env.CCPOD_TEST_DIR;
  rmSync(testBase, { force: true, recursive: true });
});

function makeProfile(name: string, content: string): void {
  const dir = join(testBase, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'profile.yml'), content);
}

describe('exportProfile', () => {
  it('returns base64-encoded profile.yml content', () => {
    const yaml = 'name: test\nstate: ephemeral\n';
    makeProfile('test', yaml);
    const result = exportProfile('test');
    expect(Buffer.from(result, 'base64').toString('utf8')).toBe(yaml);
  });

  it('throws when profile does not exist', () => {
    expect(() => exportProfile('missing')).toThrow('Profile not found: missing');
  });

  it('round-trips: exported string decodes to original bytes', () => {
    const yaml = 'name: roundtrip\nstate: persistent\n';
    makeProfile('roundtrip', yaml);
    const encoded = exportProfile('roundtrip');
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(yaml);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test tests/unit/profile/exporter.test.ts
```

Expected: error — `exportProfile` not found.

- [ ] **Step 3: Implement `src/profile/exporter.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProfileDir } from './manager.ts';

export function exportProfile(name: string): string {
  const profilePath = join(getProfileDir(name), 'profile.yml');
  if (!existsSync(profilePath)) {
    throw new Error(`Profile not found: ${name}`);
  }
  return readFileSync(profilePath).toString('base64');
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test tests/unit/profile/exporter.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/profile/exporter.ts tests/unit/profile/exporter.test.ts
git commit -m "feat(profile): add exportProfile for base64 sharing"
```

---

### Task 2: `detectSource` in `src/profile/installer.ts`

**Files:**
- Create: `src/profile/installer.ts`
- Test: `tests/unit/profile/installer.test.ts`

- [ ] **Step 1: Write the failing tests for `detectSource`**

```ts
// tests/unit/profile/installer.test.ts
import { describe, expect, it } from 'bun:test';
import { detectSource } from '../../../src/profile/installer.ts';

describe('detectSource', () => {
  it('detects github.com URL as git', () => {
    const src = detectSource('https://github.com/user/my-profile');
    expect(src).toEqual({ type: 'git', url: 'https://github.com/user/my-profile' });
  });

  it('detects gitlab.com URL as git', () => {
    const src = detectSource('https://gitlab.com/org/profile');
    expect(src).toEqual({ type: 'git', url: 'https://gitlab.com/org/profile' });
  });

  it('detects bitbucket.org URL as git', () => {
    const src = detectSource('https://bitbucket.org/user/profile');
    expect(src).toEqual({ type: 'git', url: 'https://bitbucket.org/user/profile' });
  });

  it('detects .git suffix URL as git', () => {
    const src = detectSource('https://example.com/repo.git');
    expect(src).toEqual({ type: 'git', url: 'https://example.com/repo.git' });
  });

  it('detects plain https URL as url', () => {
    const src = detectSource('https://example.com/profile.yml');
    expect(src).toEqual({ type: 'url', url: 'https://example.com/profile.yml' });
  });

  it('detects http URL as url', () => {
    const src = detectSource('http://example.com/raw/profile.yml');
    expect(src).toEqual({ type: 'url', url: 'http://example.com/raw/profile.yml' });
  });

  it('detects absolute path as file', () => {
    const src = detectSource('/home/user/.ccpod/profiles/test/profile.yml');
    expect(src).toEqual({ type: 'file', path: '/home/user/.ccpod/profiles/test/profile.yml' });
  });

  it('detects relative path as file', () => {
    const src = detectSource('./my-profile.yml');
    expect(src).toEqual({ type: 'file', path: './my-profile.yml' });
  });

  it('expands ~ in file paths', () => {
    const src = detectSource('~/profiles/test.yml');
    expect(src.type).toBe('file');
    expect((src as { type: 'file'; path: string }).path).not.toContain('~');
  });

  it('treats unknown input as base64', () => {
    const encoded = Buffer.from('name: test\n').toString('base64');
    const src = detectSource(encoded);
    expect(src).toEqual({ type: 'base64', data: encoded });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test tests/unit/profile/installer.test.ts
```

Expected: error — `detectSource` not found.

- [ ] **Step 3: Implement `detectSource` in `src/profile/installer.ts`**

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';

const GIT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];

export type InstallSource =
  | { type: 'git'; url: string }
  | { type: 'url'; url: string }
  | { type: 'file'; path: string }
  | { type: 'base64'; data: string };

export function detectSource(input: string): InstallSource {
  if (/^https?:\/\/.+\.git$/.test(input) || GIT_HOSTS.some((h) => input.includes(h))) {
    return { type: 'git', url: input };
  }
  if (/^https?:\/\//.test(input)) {
    return { type: 'url', url: input };
  }
  if (input.startsWith('/') || input.startsWith('./') || input.startsWith('~/') || input === '~') {
    return { type: 'file', path: input.replace(/^~(?=\/|$)/, homedir()) };
  }
  return { type: 'base64', data: input };
}

export async function fetchProfileYaml(source: InstallSource): Promise<string> {
  // implemented in Task 3
  throw new Error('not implemented');
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test tests/unit/profile/installer.test.ts
```

Expected: all `detectSource` tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/profile/installer.ts tests/unit/profile/installer.test.ts
git commit -m "feat(profile): add detectSource for install source auto-detection"
```

---

### Task 3: `fetchProfileYaml` in `src/profile/installer.ts`

**Files:**
- Modify: `src/profile/installer.ts`
- Modify: `tests/unit/profile/installer.test.ts` (add new describe block)

- [ ] **Step 1: Add tests for `fetchProfileYaml`**

Add this below the existing `detectSource` describe block in `tests/unit/profile/installer.test.ts`:

```ts
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchProfileYaml } from '../../../src/profile/installer.ts';

// Add these describe blocks after the detectSource tests:

describe('fetchProfileYaml - file', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccpod-fetch-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it('reads YAML from an absolute file path', async () => {
    const filePath = join(tmpDir, 'profile.yml');
    writeFileSync(filePath, 'name: test\n');
    const result = await fetchProfileYaml({ type: 'file', path: filePath });
    expect(result).toBe('name: test\n');
  });

  it('throws when file does not exist', async () => {
    await expect(
      fetchProfileYaml({ type: 'file', path: join(tmpDir, 'missing.yml') }),
    ).rejects.toThrow('File not found:');
  });
});

describe('fetchProfileYaml - base64', () => {
  it('decodes base64 string to YAML', async () => {
    const yaml = 'name: test\nstate: ephemeral\n';
    const encoded = Buffer.from(yaml).toString('base64');
    const result = await fetchProfileYaml({ type: 'base64', data: encoded });
    expect(result).toBe(yaml);
  });

  it('round-trips: encode then decode returns original', async () => {
    const yaml = 'name: myprofile\nstate: persistent\nimage:\n  use: ghcr.io/user/image:latest\n';
    const encoded = Buffer.from(yaml).toString('base64');
    const result = await fetchProfileYaml({ type: 'base64', data: encoded });
    expect(result).toBe(yaml);
  });
  // Note: Node's Buffer.from never throws on invalid base64 — it silently decodes what it can.
  // Invalid content is caught downstream by the YAML parser and Zod schema in the install command.
});

describe('fetchProfileYaml - url', () => {
  it('fetches and returns YAML from HTTP URL', async () => {
    const yaml = 'name: remote\nstate: ephemeral\n';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => ({
      ok: true,
      text: async () => yaml,
    })) as typeof fetch;

    try {
      const result = await fetchProfileYaml({
        type: 'url',
        url: 'https://example.com/profile.yml',
      });
      expect(result).toBe(yaml);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws on non-200 HTTP response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 404,
    })) as typeof fetch;

    try {
      await expect(
        fetchProfileYaml({ type: 'url', url: 'https://example.com/missing.yml' }),
      ).rejects.toThrow('HTTP 404');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

- [ ] **Step 2: Run tests to confirm new ones fail**

```bash
bun test tests/unit/profile/installer.test.ts
```

Expected: `fetchProfileYaml` tests fail with "not implemented".

- [ ] **Step 3: Implement `fetchProfileYaml` in `src/profile/installer.ts`**

Replace the stub `fetchProfileYaml` with:

```ts
export async function fetchProfileYaml(source: InstallSource): Promise<string> {
  switch (source.type) {
    case 'git': {
      const tmpDir = mkdtempSync(join(tmpdir(), 'ccpod-install-'));
      try {
        await simpleGit().clone(source.url, tmpDir, ['--depth', '1']);
        const profilePath = join(tmpDir, 'profile.yml');
        if (!existsSync(profilePath)) {
          throw new Error(`No profile.yml found at root of ${source.url}`);
        }
        return readFileSync(profilePath, 'utf8');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
    case 'url': {
      const res = await fetch(source.url);
      if (!res.ok) {
        throw new Error(`Failed to fetch ${source.url}: HTTP ${res.status}`);
      }
      return res.text();
    }
    case 'file': {
      if (!existsSync(source.path)) {
        throw new Error(`File not found: ${source.path}`);
      }
      return readFileSync(source.path, 'utf8');
    }
    case 'base64': {
      return Buffer.from(source.data, 'base64').toString('utf8');
    }
  }
}
```

- [ ] **Step 4: Run all installer tests**

```bash
bun test tests/unit/profile/installer.test.ts
```

Expected: all tests passing (git source skipped — not unit-testable without network).

- [ ] **Step 5: Commit**

```bash
git add src/profile/installer.ts tests/unit/profile/installer.test.ts
git commit -m "feat(profile): implement fetchProfileYaml for all source types"
```

---

### Task 4: `ccpod profile export` command

**Files:**
- Create: `src/cli/commands/profile/export.ts`

- [ ] **Step 1: Create `src/cli/commands/profile/export.ts`**

```ts
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { exportProfile } from '../../../profile/exporter.ts';

export default defineCommand({
  args: {
    name: { description: 'Profile name', type: 'positional' },
  },
  meta: { description: 'Export a profile as a shareable base64 string' },
  run({ args }) {
    if (!args.name) {
      console.error('Profile name required.');
      process.exit(1);
    }
    try {
      const encoded = exportProfile(args.name);
      process.stdout.write(`${encoded}\n`);
    } catch (err) {
      console.error(
        chalk.red(err instanceof Error ? err.message : String(err)),
      );
      process.exit(1);
    }
  },
});
```

- [ ] **Step 2: Manual smoke test**

First create a profile if none exist (`ccpod init`), then:

```bash
bun run dev profile export <your-profile-name>
```

Expected: long base64 string printed to stdout, pipeable.

```bash
bun run dev profile export <your-profile-name> | base64 -d
```

Expected: valid YAML matching your profile.yml.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/profile/export.ts
git commit -m "feat(profile): add export command"
```

---

### Task 5: `ccpod profile install` command

**Files:**
- Create: `src/cli/commands/profile/install.ts`

- [ ] **Step 1: Create `src/cli/commands/profile/install.ts`**

```ts
import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';
import { profileConfigSchema } from '../../../config/schema.ts';
import {
  detectSource,
  fetchProfileYaml,
} from '../../../profile/installer.ts';
import {
  ensureCcpodDirs,
  getProfileDir,
  profileExists,
} from '../../../profile/manager.ts';

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export default defineCommand({
  args: {
    source: {
      description:
        'Profile source: git URL, raw HTTPS URL, file path, or base64 string',
      type: 'positional',
    },
  },
  meta: { description: 'Install a profile from a URL, git repo, file, or base64 string' },
  async run({ args }) {
    if (!args.source) {
      console.error('Source required.');
      process.exit(1);
    }

    const source = detectSource(args.source);
    console.log(chalk.dim(`Fetching profile (${source.type})...`));

    let yaml: string;
    try {
      yaml = await fetchProfileYaml(source);
    } catch (err) {
      console.error(
        chalk.red(`Failed to fetch profile: ${err instanceof Error ? err.message : err}`),
      );
      process.exit(1);
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(yaml);
    } catch {
      console.error(chalk.red('Invalid YAML in profile source.'));
      process.exit(1);
    }

    const result = profileConfigSchema.safeParse(parsed);
    if (!result.success) {
      console.error(chalk.red('Profile validation failed:'));
      console.error(result.error.message);
      process.exit(1);
    }

    let profileName = result.data.name;

    if (profileExists(profileName)) {
      const action = (await select({
        choices: [
          { name: 'Overwrite existing profile', value: 'overwrite' },
          { name: 'Install with a different name', value: 'rename' },
          { name: 'Cancel', value: 'cancel' },
        ],
        message: `Profile ${chalk.cyan(profileName)} already exists. What would you like to do?`,
      })) as 'cancel' | 'overwrite' | 'rename';

      if (action === 'cancel') {
        console.log('Aborted.');
        return;
      }

      if (action === 'rename') {
        profileName = await input({
          message: 'New profile name:',
          validate: (v: string) => {
            if (!NAME_RE.test(v)) {
              return 'Name may only contain letters, digits, hyphens, and underscores (max 64 chars)';
            }
            if (profileExists(v)) {
              return `Profile '${v}' already exists`;
            }
            return true;
          },
        });
      }
    }

    // If name changed, update the name field in YAML preserving other content
    let finalYaml = yaml;
    if (profileName !== result.data.name) {
      const doc = parseDocument(yaml);
      doc.set('name', profileName);
      finalYaml = doc.toString();
    }

    ensureCcpodDirs();
    const profileDir = getProfileDir(profileName);
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'profile.yml'), finalYaml, 'utf8');

    console.log(chalk.green(`✓ Profile ${chalk.cyan(profileName)} installed.`));
    console.log(chalk.dim(`  Run: ccpod run ${profileName}`));
  },
});
```

- [ ] **Step 2: Manual smoke test — base64 round-trip**

```bash
# Export an existing profile
ENCODED=$(bun run dev profile export <your-profile-name>)

# Install it under a new name
bun run dev profile install "$ENCODED"
# When prompted for conflict: choose rename, enter a new name like "test-import"

# Verify it was created
bun run dev profile list
```

Expected: new profile appears in the list.

- [ ] **Step 3: Manual smoke test — local file**

```bash
bun run dev profile install ~/.ccpod/profiles/<your-profile-name>/profile.yml
```

Expected: conflict prompt (same name) → overwrite or rename → profile installed.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/profile/install.ts
git commit -m "feat(profile): add install command with conflict resolution"
```

---

### Task 6: Wire commands into router + quality gates

**Files:**
- Modify: `src/cli/commands/profile/index.ts`

- [ ] **Step 1: Add `export` and `install` to profile subcommands**

Edit `src/cli/commands/profile/index.ts`:

```ts
import { defineCommand } from 'citty';

export default defineCommand({
  meta: { description: 'Manage ccpod profiles' },
  subCommands: {
    create: () => import('./create.ts').then((m) => m.default),
    delete: () => import('./delete.ts').then((m) => m.default),
    export: () => import('./export.ts').then((m) => m.default),
    install: () => import('./install.ts').then((m) => m.default),
    list: () => import('./list.ts').then((m) => m.default),
    update: () => import('./update.ts').then((m) => m.default),
  },
});
```

- [ ] **Step 2: Run full quality gates**

```bash
bun run typecheck && bun test tests/unit/ && bun run check
```

Expected: all passing. Fix any type errors before proceeding.

- [ ] **Step 3: Verify commands appear in help**

```bash
bun run dev profile --help
```

Expected output includes:
```
  export    Export a profile as a shareable base64 string
  install   Install a profile from a URL, git repo, file, or base64 string
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/profile/index.ts
git commit -m "feat(profile): wire install and export into profile CLI router"
```

---

### Task 7: Update docs

**Files:**
- Modify: `CLAUDE.md` / `AGENTS.md`
- Modify: `website/src/content/docs/reference/internals.md` (if it covers CLI commands)

- [ ] **Step 1: Check what docs exist for profile commands**

```bash
grep -r "profile" website/src/content/docs/ --include="*.md" -l
```

- [ ] **Step 2: Add `install` and `export` to any docs that list profile subcommands**

In whichever doc covers profile commands, add:

```markdown
### `ccpod profile install <source>`

Installs a profile from any source — auto-detected:

| Input | Detected as |
|-------|-------------|
| `https://github.com/...` or `*.git` URL | Git repo (clones, reads `profile.yml` at root) |
| `https://...` | Raw URL fetch |
| `/path/...`, `./path/...`, `~/...` | Local file |
| Anything else | Base64-encoded profile string |

If a profile with the same name already exists, you're prompted to overwrite, rename, or cancel.

### `ccpod profile export <name>`

Prints a base64-encoded string of the profile to stdout. Pipe it anywhere:

```bash
ccpod profile export myprofile | pbcopy   # copy to clipboard
ccpod profile export myprofile > shared.txt
```

To install from the string on another machine:
```bash
ccpod profile install <paste-string-here>
```
```

- [ ] **Step 3: Run quality gates one final time**

```bash
bun run typecheck && bun test tests/unit/ && bun run check
```

Expected: all passing.

- [ ] **Step 4: Final commit**

```bash
git add CLAUDE.md AGENTS.md website/
git commit -m "docs(profile): document install and export commands"
```
