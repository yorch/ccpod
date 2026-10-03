// Renders scripts/og.svg to public/og.png (1200x630). Run: bun scripts/build-og.mjs
import sharp from 'sharp';

await sharp('scripts/og.svg', { density: 144 })
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toFile('public/og.png');
