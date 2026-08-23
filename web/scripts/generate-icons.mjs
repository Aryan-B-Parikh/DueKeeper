import sharp from 'sharp';
import { readFile, writeFile } from 'fs/promises';

const svg = await readFile('./public/icon.svg', 'utf8');

const targets = [
  { file: './public/icon-192.png', size: 192 },
  { file: './public/icon-512.png', size: 512 },
  { file: './public/apple-touch-icon.png', size: 180 }
];

for (const { file, size } of targets) {
  await sharp(Buffer.from(svg), { density: 300 })
    .resize(size, size)
    .png()
    .toFile(file);
  console.log(`wrote ${file} (${size}x${size})`);
}

const maskable = svg.replace('width="64" height="64" viewBox="0 0 64 64"', 'width="82" height="82" viewBox="-9 -9 82 82"');
await sharp(Buffer.from(maskable), { density: 300 })
  .resize(512, 512, { fit: 'contain', background: '#6d54eb' })
  .png()
  .toFile('./public/icon-maskable-512.png');
console.log('wrote ./public/icon-maskable-512.png (512x512 maskable)');
