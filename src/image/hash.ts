import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { VERSION } from '../version.ts';

export function computeDockerfileHash(dockerfile: string, cwd: string): string {
  const abs = isAbsolute(dockerfile) ? dockerfile : join(cwd, dockerfile);
  const data = existsSync(abs) ? readFileSync(abs) : Buffer.from(abs);
  const hash = createHash('sha256').update(data);
  // The image also bakes in docker/entrypoint.sh (COPY from the build
  // context), so editing it must produce a new tag. Include it when present
  // next to the Dockerfile or in the context dir, plus the ccpod version.
  for (const dir of new Set([cwd, dirname(abs)])) {
    const entry = join(dir, 'entrypoint.sh');
    if (existsSync(entry)) {
      hash.update('\0entrypoint.sh\0').update(readFileSync(entry));
    }
  }
  hash.update(`\0VERSION\0${VERSION}`);
  return hash.digest('hex').slice(0, 16);
}

export function computeLocalImageTag(
  profileName: string,
  dockerfile: string,
  cwd: string,
): string {
  // Docker repository names must be lowercase; profile names may not be.
  return `ccpod-local-${profileName.toLowerCase()}-${computeDockerfileHash(dockerfile, cwd)}:latest`;
}
