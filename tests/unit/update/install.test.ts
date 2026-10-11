import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('install.sh checksum handling', () => {
  let root = '';
  afterEach(() => {
    if (root && existsSync(root)) {
      rmSync(root, { force: true, recursive: true });
    }
    root = '';
  });

  function runInstaller(checksumMode: string, skipVerify = '') {
    root = mkdtempSync(join(tmpdir(), 'ccpod-install-test-'));
    const binDir = join(root, 'bin');
    const installDir = join(root, 'install');
    const scriptDir = join(root, 'scripts');
    for (const dir of [binDir, installDir, scriptDir]) {
      // Ensure the fake executables and install target are isolated from the host installation.
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(installDir, 'ccpod'), 'original-binary');
    const payload = 'new-test-binary';
    const actual = createHash('sha256').update(payload).digest('hex');
    const sums =
      checksumMode === 'malformed'
        ? 'not-a-checksum\n'
        : checksumMode === 'missing'
          ? `${actual}  another-binary\n`
          : checksumMode === 'mismatch'
            ? `${'0'.repeat(64)}  ccpod-linux-x64\n`
            : `${actual}  ccpod-linux-x64\n`;
    const fakeCurl = `#!/bin/sh\nset -e\nurl=\noutput=\nwriteout=\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) output=$2; shift 2 ;;\n    -w) writeout=$2; shift 2 ;;\n    http*) url=$1; shift ;;\n    *) shift ;;\n  esac\ndone\ncase "$url" in\n  */SHASUMS256.txt)\n    case "$CCPOD_CHECKSUM_MODE" in\n      404) echo 'missing' > "$output"; code=404 ;;
      error) echo 'failure' > "$output"; code=503 ;;
      *) printf '%s' "$CCPOD_SUMS" > "$output"; code=200 ;;
    esac\n    printf '%s' "$code"\n    ;;\n  */ccpod-linux-x64) printf '%s' 'new-test-binary' > "$output" ;;\n  *) exit 9 ;;\nesac\n`;
    writeFileSync(join(scriptDir, 'curl'), fakeCurl);
    writeFileSync(
      join(scriptDir, 'uname'),
      '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
    );
    chmodSync(join(scriptDir, 'curl'), 0o755);
    chmodSync(join(scriptDir, 'uname'), 0o755);
    const result = spawnSync('sh', ['install.sh'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        CCPOD_CHECKSUM_MODE: checksumMode,
        CCPOD_INSTALL_DIR: installDir,
        CCPOD_INSTALL_SKIP_VERIFY: skipVerify || '0',
        CCPOD_SUMS: sums,
        CCPOD_VERSION: 'v1.2.3',
        PATH: `${scriptDir}:${binDir}:${process.env.PATH}`,
      },
    });
    return { installDir, payload, result };
  }

  it('preserves the legacy 404 compatibility path', () => {
    const { result, installDir } = runInstaller('404');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('predates checksum files');
    expect(readFileSync(join(installDir, 'ccpod'), 'utf8')).toBe(
      'new-test-binary',
    );
  });

  it('rejects modern checksum fetch errors unless the explicit unsafe bypass is set', () => {
    const failed = runInstaller('error');
    expect(failed.result.status).not.toBe(0);
    expect(readFileSync(join(failed.installDir, 'ccpod'), 'utf8')).toBe(
      'original-binary',
    );
    const bypassed = runInstaller('error', '1');
    expect(bypassed.result.status).toBe(0);
    expect(bypassed.result.stderr).toContain(
      'proceeding because CCPOD_INSTALL_SKIP_VERIFY=1',
    );
    expect(readFileSync(join(bypassed.installDir, 'ccpod'), 'utf8')).toBe(
      'new-test-binary',
    );
  });

  it('rejects malformed, missing, and mismatched checksum entries without replacing the target', () => {
    for (const mode of ['malformed', 'missing', 'mismatch']) {
      const { result, installDir } = runInstaller(mode);
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(installDir, 'ccpod'), 'utf8')).toBe(
        'original-binary',
      );
    }
  });

  it('does not let the explicit unsafe bypass override a checksum mismatch', () => {
    const { result, installDir } = runInstaller('mismatch', '1');
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(installDir, 'ccpod'), 'utf8')).toBe(
      'original-binary',
    );
  });

  it('installs successfully when the checksum matches', () => {
    const { result, installDir } = runInstaller('success');
    expect(result.status).toBe(0);
    expect(readFileSync(join(installDir, 'ccpod'), 'utf8')).toBe(
      'new-test-binary',
    );
  });
});
