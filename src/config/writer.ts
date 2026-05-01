import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function hashProfileDir(dir: string): string {
  if (!existsSync(dir)) return "";
  const hash = createHash("sha256");
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    const stat = lstatSync(p);
    if (!stat.isSymbolicLink()) {
      hash.update(`${entry}:${stat.mtimeMs}:${stat.size}`);
    }
  }
  return hash.digest("hex").slice(0, 8);
}

export function writeMergedConfig(
  profileConfigDir: string,
  mergedClaudeMd: string,
  mergedSettings: object,
): string {
  const content = JSON.stringify({
    claudeMd: mergedClaudeMd,
    profileDirHash: hashProfileDir(profileConfigDir),
    settings: mergedSettings,
  });
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const outDir = join(tmpdir(), `ccpod-${hash}`);

  if (existsSync(outDir)) return outDir;

  const tmpOut = mkdtempSync(join(tmpdir(), "ccpod-tmp-"));
  try {
    if (existsSync(profileConfigDir)) {
      for (const entry of readdirSync(profileConfigDir)) {
        const src = join(profileConfigDir, entry);
        if (lstatSync(src).isSymbolicLink()) continue;
        if (entry === "CLAUDE.md" || entry === "settings.json") continue;
        cpSync(src, join(tmpOut, entry), { recursive: true });
      }
    }

    writeFileSync(join(tmpOut, "CLAUDE.md"), mergedClaudeMd, {
      encoding: "utf8",
      mode: 0o600,
    });
    writeFileSync(
      join(tmpOut, "settings.json"),
      JSON.stringify(mergedSettings, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );

    renameSync(tmpOut, outDir);
  } catch (err) {
    rmSync(tmpOut, { force: true, recursive: true });
    if (existsSync(outDir)) return outDir;
    throw err;
  }

  return outDir;
}
