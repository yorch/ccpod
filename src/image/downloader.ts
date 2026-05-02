import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../version.ts';

const DOCKER_BASE_URL = `https://raw.githubusercontent.com/yorch/ccpod/v${VERSION}/docker`;
export const OFFICIAL_DOCKERFILE_URL = `${DOCKER_BASE_URL}/Dockerfile`;
export const OFFICIAL_ENTRYPOINT_URL = `${DOCKER_BASE_URL}/entrypoint.sh`;

export async function downloadOfficialDockerfile(
  destDir: string,
): Promise<void> {
  const dockerfileRes = await fetch(OFFICIAL_DOCKERFILE_URL);
  if (!dockerfileRes.ok)
    throw new Error(
      `Failed to download Dockerfile: HTTP ${dockerfileRes.status}`,
    );
  writeFileSync(join(destDir, 'Dockerfile'), await dockerfileRes.text(), {
    mode: 0o644,
  });

  const entrypointRes = await fetch(OFFICIAL_ENTRYPOINT_URL);
  if (!entrypointRes.ok)
    throw new Error(
      `Failed to download entrypoint.sh: HTTP ${entrypointRes.status}`,
    );
  writeFileSync(join(destDir, 'entrypoint.sh'), await entrypointRes.text(), {
    mode: 0o755,
  });
}
