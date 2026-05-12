import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GITHUB_REPO } from '../constants.ts';

const CHECKSUMS_ASSET = 'SHASUMS256.txt';

export function getAssetName(): string | null {
  const { platform, arch } = process;
  if (platform === 'darwin' && arch === 'x64') {
    return 'ccpod-darwin-x64';
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return 'ccpod-darwin-arm64';
  }
  if (platform === 'linux' && arch === 'x64') {
    return 'ccpod-linux-x64';
  }
  if (platform === 'linux' && arch === 'arm64') {
    return 'ccpod-linux-arm64';
  }
  return null;
}

export interface LatestRelease {
  assetName: string;
  checksumsUrl: string;
  url: string;
  version: string;
}

export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    { headers: { 'User-Agent': 'ccpod-updater' } },
  );
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status}`);
  }
  const data = (await res.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };
  const assetName = getAssetName();
  if (!assetName) {
    return null;
  }
  const asset = data.assets.find((a) => a.name === assetName);
  if (!asset) {
    return null;
  }
  const checksums = data.assets.find((a) => a.name === CHECKSUMS_ASSET);
  if (!checksums) {
    throw new Error(
      `Release ${data.tag_name} is missing ${CHECKSUMS_ASSET}; refusing to update without checksum verification.`,
    );
  }
  return {
    assetName,
    checksumsUrl: checksums.browser_download_url,
    url: asset.browser_download_url,
    version: data.tag_name,
  };
}

// SHASUMS256.txt format: "<hex-digest>  <filename>" per line (sha256sum format).
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = trimmed.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) {
      continue;
    }
    out.set(match[2] as string, (match[1] as string).toLowerCase());
  }
  return out;
}

async function fetchExpectedDigest(
  checksumsUrl: string,
  assetName: string,
): Promise<string> {
  const res = await fetch(checksumsUrl, {
    headers: { 'User-Agent': 'ccpod-updater' },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${CHECKSUMS_ASSET}: HTTP ${res.status}`);
  }
  const digests = parseChecksums(await res.text());
  const expected = digests.get(assetName);
  if (!expected) {
    throw new Error(
      `${CHECKSUMS_ASSET} does not contain an entry for ${assetName}.`,
    );
  }
  return expected;
}

export async function downloadAndReplace(
  release: LatestRelease,
  targetPath: string,
): Promise<void> {
  const expectedDigest = await fetchExpectedDigest(
    release.checksumsUrl,
    release.assetName,
  );

  const tmpPath = join(tmpdir(), `ccpod-update-${Date.now()}`);

  const res = await fetch(release.url, {
    headers: { 'User-Agent': 'ccpod-updater' },
  });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const actualDigest = createHash('sha256').update(bytes).digest('hex');
  if (actualDigest !== expectedDigest) {
    throw new Error(
      `Checksum mismatch for ${release.assetName}: expected ${expectedDigest}, got ${actualDigest}. Refusing to install.`,
    );
  }

  await Bun.write(tmpPath, bytes);
  chmodSync(tmpPath, 0o755);

  try {
    const { renameSync } = await import('node:fs');
    renameSync(tmpPath, targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      copyFileSync(tmpPath, targetPath);
      chmodSync(targetPath, 0o755);
      unlinkSync(tmpPath);
    } else {
      unlinkSync(tmpPath);
      throw err;
    }
  }
}
