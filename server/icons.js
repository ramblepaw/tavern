import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';

// Generates the PNG icons iOS needs (it ignores SVG icons) from public/icons/icon.svg on first run.
const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
];

export async function ensureIcons() {
  const dir = path.join(config.publicDir, 'icons');
  const svg = await fs.readFile(path.join(dir, 'icon.svg'));
  for (const [file, size] of targets) {
    const out = path.join(dir, file);
    if (await fs.access(out).then(() => true, () => false)) continue;
    await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out);
  }
}
