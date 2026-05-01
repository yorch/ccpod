import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function writeMergedConfig(
  profileConfigDir: string,
  mergedClaudeMd: string,
  mergedSettings: object,
): string {
  const content = JSON.stringify({
    claudeMd: mergedClaudeMd,
    settings: mergedSettings,
  });
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const outDir = join(tmpdir(), `ccpod-${hash}`);

  if (existsSync(outDir)) return outDir;

  mkdirSync(outDir, { recursive: true });

  // Copy non-symlinked assets from profile config dir
  if (existsSync(profileConfigDir)) {
    for (const entry of readdirSync(profileConfigDir)) {
      const src = join(profileConfigDir, entry);
      if (lstatSync(src).isSymbolicLink()) continue; // skip symlinks (not portable)
      if (entry === "CLAUDE.md" || entry === "settings.json") continue; // handled below
      cpSync(src, join(outDir, entry), { recursive: true });
    }
  }

  writeFileSync(join(outDir, "CLAUDE.md"), mergedClaudeMd, "utf8");
  writeFileSync(
    join(outDir, "settings.json"),
    JSON.stringify(mergedSettings, null, 2),
    "utf8",
  );

  return outDir;
}
