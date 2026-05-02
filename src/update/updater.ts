import { chmodSync, copyFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GITHUB_REPO } from '../constants.ts';

export function getAssetName(): string | null {
  const { platform, arch } = process;
  if (platform === 'darwin' && arch === 'x64') return 'ccpod-darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'ccpod-darwin-arm64';
  if (platform === 'linux' && arch === 'x64') return 'ccpod-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'ccpod-linux-arm64';
  return null;
}

export async function fetchLatestRelease(): Promise<{
  version: string;
  url: string;
} | null> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    { headers: { 'User-Agent': 'ccpod-updater' } },
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = (await res.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };
  const assetName = getAssetName();
  if (!assetName) return null;
  const asset = data.assets.find((a) => a.name === assetName);
  if (!asset) return null;
  return { url: asset.browser_download_url, version: data.tag_name };
}

export async function downloadAndReplace(
  url: string,
  targetPath: string,
): Promise<void> {
  const tmpPath = join(tmpdir(), `ccpod-update-${Date.now()}`);

  const res = await fetch(url, { headers: { 'User-Agent': 'ccpod-updater' } });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  await Bun.write(tmpPath, await res.arrayBuffer());
  chmodSync(tmpPath, 0o755);

  try {
    // Atomic on same filesystem
    const { renameSync } = await import('node:fs');
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Cross-device link: fall back to copy + delete
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
