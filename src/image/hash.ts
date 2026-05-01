import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export function computeDockerfileHash(dockerfile: string, cwd: string): string {
  const abs = isAbsolute(dockerfile) ? dockerfile : join(cwd, dockerfile);
  const data = existsSync(abs) ? readFileSync(abs) : Buffer.from(abs);
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}
