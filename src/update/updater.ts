import { createHash } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  mkdtempSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
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
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(checksumsUrl, {
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

export interface UpdaterDependencies {
  chmod?: typeof chmodSync;
  createStageDir?: (parent: string) => string;
  createWriteStream?: typeof createWriteStream;
  fetch?: typeof fetch;
  remove?: typeof rmSync;
  rename?: typeof renameSync;
}

export async function downloadAndReplace(
  release: LatestRelease,
  targetPath: string,
  dependencies: UpdaterDependencies = {},
): Promise<void> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const [expectedDigest, binaryRes] = await Promise.all([
    fetchExpectedDigest(release.checksumsUrl, release.assetName, fetchImpl),
    fetchImpl(release.url, { headers: { 'User-Agent': 'ccpod-updater' } }),
  ]);
  if (!binaryRes.ok) {
    throw new Error(`Download failed: ${binaryRes.status}`);
  }

  if (!binaryRes.body) {
    throw new Error('Download response has no body');
  }

  // Create staging data beneath the target's parent so rename is same-filesystem.
  const parentDir = dirname(targetPath);
  const makeStageDir = dependencies.createStageDir ?? mkdtempSync;
  const tmpDir = makeStageDir(join(parentDir, '.ccpod-update-'));
  const tmpPath = join(tmpDir, release.assetName);

  try {
    // Stream the response through the hash and into the temp file at the same
    // time, so a ~50-80 MB binary is never held in memory twice (once as an
    // ArrayBuffer for hashing, once as a Buffer for writing).
    const hash = createHash('sha256');
    await pipeline(
      Readable.fromWeb(
        // SAFETY: Fetch bodies are WHATWG byte streams, matching Node's web stream type.
        binaryRes.body as unknown as NodeReadableStream<Uint8Array>,
      ),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk as Uint8Array);
          yield chunk;
        }
      },
      (dependencies.createWriteStream ?? createWriteStream)(tmpPath),
    );
    const actualDigest = hash.digest('hex');
    if (actualDigest !== expectedDigest) {
      throw new Error(
        `Checksum mismatch for ${release.assetName}: expected ${expectedDigest}, got ${actualDigest}. Refusing to install.`,
      );
    }

    (dependencies.chmod ?? chmodSync)(tmpPath, 0o755);

    // The staged file is on the destination filesystem. Its verified bytes and
    // mode are complete before this final mutation; rename preserves the old
    // executable if staging or verification fails.
    (dependencies.rename ?? renameSync)(tmpPath, targetPath);
  } finally {
    // Remove the stage directory after success or any failure.
    (dependencies.remove ?? rmSync)(tmpDir, { force: true, recursive: true });
  }
}
