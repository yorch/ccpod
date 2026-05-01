import { mkdirSync, writeFileSync, cpSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

export function writeMergedConfig(
  profileConfigDir: string,
  mergedClaudeMd: string,
  mergedSettings: object,
): string {
  const content = JSON.stringify({ settings: mergedSettings, claudeMd: mergedClaudeMd });
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
  writeFileSync(join(outDir, "settings.json"), JSON.stringify(mergedSettings, null, 2), "utf8");

  return outDir;
}
