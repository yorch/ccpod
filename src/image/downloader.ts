import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GITHUB_RAW_BASE_URL } from '../constants.ts';
import { VERSION } from '../version.ts';

const DOCKER_BASE_URL = `${GITHUB_RAW_BASE_URL}/v${VERSION}/docker`;
const DOCKER_FALLBACK_BASE_URL = `${GITHUB_RAW_BASE_URL}/main/docker`;
export const OFFICIAL_DOCKERFILE_URL = `${DOCKER_BASE_URL}/Dockerfile`;
export const OFFICIAL_ENTRYPOINT_URL = `${DOCKER_BASE_URL}/entrypoint.sh`;

async function fetchWithFallback(
  primaryUrl: string,
  fallbackUrl: string,
  label: string,
): Promise<string> {
  const res = await fetch(primaryUrl);
  if (res.ok) return res.text();
  if (res.status !== 404)
    throw new Error(`Failed to download ${label}: HTTP ${res.status}`);
  process.stderr.write(
    `Warning: v${VERSION} tag not found for ${label}, falling back to main branch.\n`,
  );
  const fallback = await fetch(fallbackUrl);
  if (fallback.ok) return fallback.text();
  throw new Error(`Failed to download ${label}: HTTP ${fallback.status}`);
}

export async function downloadOfficialDockerfile(
  destDir: string,
): Promise<void> {
  const dockerfileContent = await fetchWithFallback(
    OFFICIAL_DOCKERFILE_URL,
    `${DOCKER_FALLBACK_BASE_URL}/Dockerfile`,
    'Dockerfile',
  );
  writeFileSync(join(destDir, 'Dockerfile'), dockerfileContent, {
    mode: 0o644,
  });

  const entrypointContent = await fetchWithFallback(
    OFFICIAL_ENTRYPOINT_URL,
    `${DOCKER_FALLBACK_BASE_URL}/entrypoint.sh`,
    'entrypoint.sh',
  );
  writeFileSync(join(destDir, 'entrypoint.sh'), entrypointContent, {
    mode: 0o755,
  });
}
