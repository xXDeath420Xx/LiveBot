import { createCanvas, loadImage } from 'canvas';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const CARD_WIDTH = 934;
const CARD_HEIGHT = 282;

export async function processBackgroundUpload(source, guildId, userId) {
  // Download image bytes if source is a URL
  let imageBuffer;
  if (typeof source === 'string') {
    const response = await fetch(source);
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } else {
    imageBuffer = source;
  }

  // Use sharp to convert any format (WebP, AVIF, etc.) to PNG that canvas can read
  const pngBuffer = await sharp(imageBuffer).png().toBuffer();

  const img = await loadImage(pngBuffer);
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext('2d');

  // Cover-fit: scale to fill, crop excess
  const scale = Math.max(CARD_WIDTH / img.width, CARD_HEIGHT / img.height);
  const sw = CARD_WIDTH / scale;
  const sh = CARD_HEIGHT / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, CARD_WIDTH, CARD_HEIGHT);

  const dir = path.join('data', 'rank-backgrounds', guildId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${userId}.png`);
  const outputBuffer = canvas.toBuffer('image/png');
  fs.writeFileSync(filePath, outputBuffer);

  return filePath;
}

export function deleteCustomBackground(guildId, userId) {
  const filePath = path.join('data', 'rank-backgrounds', guildId, `${userId}.png`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}
