/**
 * One-time script to generate preset rank card background images.
 * Each preset is a 934x282 PNG with gradients, overlays, and patterns
 * to create visually distinct, premium-feeling backgrounds.
 *
 * Usage: node scripts/generate-rank-presets.js
 */

import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WIDTH = 934;
const HEIGHT = 282;
const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'rank-presets');

// ── Helper drawing functions ──────────────────────────────────────────────

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 0, g: 0, b: 0 };
}

/** Draw a multi-stop linear gradient across the full canvas */
function drawLinearGradient(ctx, angle, stops) {
  const rad = (angle * Math.PI) / 180;
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const len = Math.sqrt(WIDTH * WIDTH + HEIGHT * HEIGHT) / 2;
  const x0 = cx - Math.cos(rad) * len;
  const y0 = cy - Math.sin(rad) * len;
  const x1 = cx + Math.cos(rad) * len;
  const y1 = cy + Math.sin(rad) * len;

  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach(([offset, color]) => grad.addColorStop(offset, color));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

/** Draw a radial glow at a given position */
function drawRadialGlow(ctx, cx, cy, radius, color, alpha = 0.3) {
  const rgb = hexToRgb(color);
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  grad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`);
  grad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
}

/** Draw a subtle grid pattern overlay */
function drawGrid(ctx, spacing = 20, color = 'rgba(255,255,255,0.03)') {
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.5;
  for (let x = 0; x < WIDTH; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, HEIGHT);
    ctx.stroke();
  }
  for (let y = 0; y < HEIGHT; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WIDTH, y);
    ctx.stroke();
  }
}

/** Draw a scattered dot pattern */
function drawDots(ctx, count, color = 'rgba(255,255,255,0.06)', minR = 1, maxR = 3) {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = (Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1;
    const y = (Math.sin(i * 269.5 + 183.3) * 43758.5453) % 1;
    const px = Math.abs(x) * WIDTH;
    const py = Math.abs(y) * HEIGHT;
    const r = minR + Math.abs((Math.sin(i * 78.233) * 43758.5453) % 1) * (maxR - minR);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Draw diagonal light streaks */
function drawDiagonalStreaks(ctx, count = 5, color = 'rgba(255,255,255,0.04)', thickness = 2) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = thickness;
  for (let i = 0; i < count; i++) {
    const offset = (i / count) * (WIDTH + HEIGHT);
    ctx.beginPath();
    ctx.moveTo(offset - HEIGHT, 0);
    ctx.lineTo(offset, HEIGHT);
    ctx.stroke();
  }
  ctx.restore();
}

/** Draw wide diagonal light bands for a softer look */
function drawLightBands(ctx, count = 4, color = 'rgba(255,255,255,0.02)', bandWidth = 40) {
  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const offset = (i / count) * (WIDTH + HEIGHT + bandWidth);
    ctx.beginPath();
    ctx.moveTo(offset - HEIGHT, 0);
    ctx.lineTo(offset, HEIGHT);
    ctx.lineTo(offset + bandWidth, HEIGHT);
    ctx.lineTo(offset + bandWidth - HEIGHT, 0);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Draw a subtle noise-like texture using tiny semi-transparent rectangles */
function drawNoise(ctx, density = 3000, alpha = 0.015) {
  for (let i = 0; i < density; i++) {
    const x = (Math.sin(i * 127.1 + 5.7) * 43758.5453) % 1;
    const y = (Math.sin(i * 269.5 + 13.3) * 43758.5453) % 1;
    const px = Math.abs(x) * WIDTH;
    const py = Math.abs(y) * HEIGHT;
    const bright = Math.abs((Math.sin(i * 78.233 + 42.1) * 43758.5453) % 1) > 0.5 ? 255 : 0;
    ctx.fillStyle = `rgba(${bright}, ${bright}, ${bright}, ${alpha})`;
    ctx.fillRect(px, py, 1, 1);
  }
}

/** Draw small star/sparkle shapes */
function drawStars(ctx, count = 30, color = 'rgba(255,255,255,0.15)') {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = Math.abs((Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1) * WIDTH;
    const y = Math.abs((Math.sin(i * 269.5 + 183.3) * 43758.5453) % 1) * HEIGHT;
    const size = 0.5 + Math.abs((Math.sin(i * 78.233) * 43758.5453) % 1) * 2;

    // Draw a 4-point star shape
    ctx.beginPath();
    ctx.moveTo(x, y - size * 2);
    ctx.lineTo(x + size * 0.5, y - size * 0.5);
    ctx.lineTo(x + size * 2, y);
    ctx.lineTo(x + size * 0.5, y + size * 0.5);
    ctx.lineTo(x, y + size * 2);
    ctx.lineTo(x - size * 0.5, y + size * 0.5);
    ctx.lineTo(x - size * 2, y);
    ctx.lineTo(x - size * 0.5, y - size * 0.5);
    ctx.closePath();
    ctx.fill();
  }
}

/** Draw flowing wave lines */
function drawWaves(ctx, count = 3, color = 'rgba(255,255,255,0.04)', amplitude = 20) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  for (let w = 0; w < count; w++) {
    const yBase = (HEIGHT / (count + 1)) * (w + 1);
    ctx.beginPath();
    for (let x = 0; x <= WIDTH; x += 2) {
      const y = yBase + Math.sin((x / WIDTH) * Math.PI * 4 + w * 2) * amplitude;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Draw concentric circles emanating from a point */
function drawConcentricRings(ctx, cx, cy, maxRadius, ringCount, color = 'rgba(255,255,255,0.03)') {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let i = 1; i <= ringCount; i++) {
    const r = (maxRadius / ringCount) * i;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Draw hexagonal pattern */
function drawHexPattern(ctx, size = 30, color = 'rgba(255,255,255,0.025)') {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.5;
  const h = size * Math.sqrt(3);
  for (let row = -1; row < HEIGHT / h + 1; row++) {
    for (let col = -1; col < WIDTH / (size * 1.5) + 1; col++) {
      const cx = col * size * 1.5;
      const cy = row * h + (col % 2 === 0 ? 0 : h / 2);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 6;
        const px = cx + size * 0.6 * Math.cos(angle);
        const py = cy + size * 0.6 * Math.sin(angle);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Draw ember/floating particle effect */
function drawEmbers(ctx, count = 40, color = '#ff6600', alphaRange = [0.05, 0.25]) {
  for (let i = 0; i < count; i++) {
    const x = Math.abs((Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1) * WIDTH;
    const y = Math.abs((Math.sin(i * 269.5 + 183.3) * 43758.5453) % 1) * HEIGHT;
    const r = 1 + Math.abs((Math.sin(i * 78.233) * 43758.5453) % 1) * 4;
    const alpha = alphaRange[0] + Math.abs((Math.sin(i * 42.1 + 7.3) * 43758.5453) % 1) * (alphaRange[1] - alphaRange[0]);
    const rgb = hexToRgb(color);

    const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 2);
    grad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`);
    grad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r * 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Draw falling petal / blossom shapes */
function drawPetals(ctx, count = 25, color = 'rgba(255,182,159,0.15)') {
  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = Math.abs((Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1) * WIDTH;
    const y = Math.abs((Math.sin(i * 269.5 + 183.3) * 43758.5453) % 1) * HEIGHT;
    const size = 3 + Math.abs((Math.sin(i * 78.233) * 43758.5453) % 1) * 8;
    const rotation = Math.abs((Math.sin(i * 42.1 + 7.3) * 43758.5453) % 1) * Math.PI * 2;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);

    // Petal shape using two bezier curves
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(size * 0.5, -size, size, -size * 0.5, 0, size * 0.3);
    ctx.bezierCurveTo(-size, -size * 0.5, -size * 0.5, -size, 0, 0);
    ctx.fill();

    ctx.restore();
  }
  ctx.restore();
}

// ── Preset Generators ─────────────────────────────────────────────────────

const presets = {
  midnight(ctx) {
    // Deep blue/purple with stars and subtle aurora-like waves
    drawLinearGradient(ctx, 30, [
      [0, '#0f0c29'],
      [0.4, '#302b63'],
      [1, '#24243e'],
    ]);

    // Subtle aurora glow
    drawRadialGlow(ctx, WIDTH * 0.3, HEIGHT * 0.2, 300, '#6a5acd', 0.12);
    drawRadialGlow(ctx, WIDTH * 0.7, HEIGHT * 0.8, 250, '#483d8b', 0.1);

    // Stars
    drawStars(ctx, 50, 'rgba(255,255,255,0.2)');
    drawStars(ctx, 20, 'rgba(200,200,255,0.35)');

    // Subtle grid
    drawGrid(ctx, 40, 'rgba(100,100,200,0.02)');

    // Diagonal light streaks like moonbeams
    drawDiagonalStreaks(ctx, 3, 'rgba(150,150,255,0.03)', 1);

    // Noise texture
    drawNoise(ctx, 2000, 0.012);
  },

  sunset(ctx) {
    // Orange/pink/purple with warm glow and light bands
    drawLinearGradient(ctx, 0, [
      [0, '#fc5c7d'],
      [0.3, '#f77062'],
      [0.6, '#c471ed'],
      [1, '#6a82fb'],
    ]);

    // Warm sun glow in the upper area
    drawRadialGlow(ctx, WIDTH * 0.6, -30, 350, '#ffcc00', 0.15);
    drawRadialGlow(ctx, WIDTH * 0.4, HEIGHT * 0.3, 200, '#ff6b6b', 0.1);

    // Light bands like sun rays
    drawLightBands(ctx, 6, 'rgba(255,255,200,0.04)', 30);

    // Horizontal cloud-like streaks
    drawWaves(ctx, 4, 'rgba(255,255,255,0.03)', 15);

    // Warm dots like dust in sunlight
    drawDots(ctx, 80, 'rgba(255,220,180,0.08)', 0.5, 2);

    drawNoise(ctx, 1500, 0.01);
  },

  forest(ctx) {
    // Dark green tones with organic patterns
    drawLinearGradient(ctx, 45, [
      [0, '#0f2027'],
      [0.4, '#203a43'],
      [1, '#2c5364'],
    ]);

    // Dappled light effect
    drawRadialGlow(ctx, WIDTH * 0.2, HEIGHT * 0.1, 200, '#4a9e6e', 0.1);
    drawRadialGlow(ctx, WIDTH * 0.8, HEIGHT * 0.6, 180, '#2d8a5e', 0.08);
    drawRadialGlow(ctx, WIDTH * 0.5, HEIGHT * 0.4, 250, '#1e7a4e', 0.06);

    // Hexagonal pattern like leaves viewed from below
    drawHexPattern(ctx, 35, 'rgba(100,180,130,0.025)');

    // Light filtering through canopy
    drawDiagonalStreaks(ctx, 7, 'rgba(150,220,150,0.025)', 1.5);

    // Subtle particle motes
    drawDots(ctx, 60, 'rgba(180,255,180,0.05)', 0.5, 2);

    drawNoise(ctx, 2500, 0.015);
  },

  ocean(ctx) {
    // Teal/blue with wave patterns and depth
    drawLinearGradient(ctx, 15, [
      [0, '#005c97'],
      [0.5, '#1a3a6a'],
      [1, '#363795'],
    ]);

    // Underwater light caustics
    drawRadialGlow(ctx, WIDTH * 0.4, -50, 400, '#00bcd4', 0.1);
    drawRadialGlow(ctx, WIDTH * 0.7, HEIGHT * 0.3, 200, '#0097a7', 0.08);

    // Wave patterns
    drawWaves(ctx, 5, 'rgba(100,200,255,0.04)', 25);

    // Concentric ripples
    drawConcentricRings(ctx, WIDTH * 0.3, HEIGHT * 0.5, 200, 8, 'rgba(100,200,255,0.025)');

    // Bubble-like dots
    drawDots(ctx, 40, 'rgba(150,220,255,0.08)', 1, 3);

    // Light bands from surface
    drawLightBands(ctx, 3, 'rgba(100,200,255,0.03)', 50);

    drawNoise(ctx, 2000, 0.01);
  },

  fire(ctx) {
    // Red/orange with ember effects and heat distortion feel
    drawLinearGradient(ctx, -20, [
      [0, '#f12711'],
      [0.3, '#e44d26'],
      [0.7, '#f5af19'],
      [1, '#f12711'],
    ]);

    // Hot core glow
    drawRadialGlow(ctx, WIDTH * 0.5, HEIGHT * 0.9, 400, '#ffcc00', 0.2);
    drawRadialGlow(ctx, WIDTH * 0.3, HEIGHT * 0.5, 200, '#ff4500', 0.12);
    drawRadialGlow(ctx, WIDTH * 0.7, HEIGHT * 0.3, 180, '#ff6600', 0.1);

    // Ember particles
    drawEmbers(ctx, 60, '#ffcc00', [0.05, 0.2]);
    drawEmbers(ctx, 30, '#ff4500', [0.03, 0.15]);

    // Heat wave distortion lines
    drawWaves(ctx, 3, 'rgba(255,200,50,0.04)', 10);

    // Diagonal heat streaks
    drawDiagonalStreaks(ctx, 5, 'rgba(255,200,100,0.03)', 2);

    drawNoise(ctx, 3000, 0.02);
  },

  neon(ctx) {
    // Cyan/magenta with electric glow and circuit-like grid
    // Dark base first
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Gradient overlay
    drawLinearGradient(ctx, 30, [
      [0, 'rgba(0,242,96,0.15)'],
      [0.5, 'rgba(5,117,230,0.2)'],
      [1, 'rgba(0,242,96,0.1)'],
    ]);

    // Neon glows
    drawRadialGlow(ctx, WIDTH * 0.2, HEIGHT * 0.3, 250, '#00f260', 0.2);
    drawRadialGlow(ctx, WIDTH * 0.8, HEIGHT * 0.6, 250, '#0575e6', 0.2);
    drawRadialGlow(ctx, WIDTH * 0.5, HEIGHT * 0.5, 200, '#00ccff', 0.1);

    // Circuit-like grid
    drawGrid(ctx, 25, 'rgba(0,255,200,0.04)');

    // Bright dots at intersections
    ctx.fillStyle = 'rgba(0,255,200,0.1)';
    for (let x = 25; x < WIDTH; x += 50) {
      for (let y = 25; y < HEIGHT; y += 50) {
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Horizontal scan lines
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    for (let y = 0; y < HEIGHT; y += 4) {
      ctx.fillRect(0, y, WIDTH, 1);
    }

    // Light streaks
    drawDiagonalStreaks(ctx, 4, 'rgba(0,255,200,0.03)', 1);

    drawNoise(ctx, 1500, 0.02);
  },

  sakura(ctx) {
    // Pink/white with petal effects and soft warmth
    drawLinearGradient(ctx, 20, [
      [0, '#ffecd2'],
      [0.3, '#f8b4b4'],
      [0.6, '#fcb69f'],
      [1, '#ffecd2'],
    ]);

    // Soft warm glows
    drawRadialGlow(ctx, WIDTH * 0.3, HEIGHT * 0.2, 300, '#ffffff', 0.2);
    drawRadialGlow(ctx, WIDTH * 0.7, HEIGHT * 0.7, 250, '#f8b4b4', 0.15);

    // Falling petals
    drawPetals(ctx, 35, 'rgba(255,150,150,0.12)');
    drawPetals(ctx, 20, 'rgba(255,180,180,0.08)');

    // Soft diagonal light
    drawLightBands(ctx, 3, 'rgba(255,255,255,0.06)', 60);

    // Gentle dots like pollen
    drawDots(ctx, 50, 'rgba(255,200,200,0.1)', 0.5, 1.5);

    drawNoise(ctx, 1000, 0.008);
  },

  void(ctx) {
    // Near-black with subtle purple and ominous depth
    drawLinearGradient(ctx, 0, [
      [0, '#0a0a0a'],
      [0.4, '#1a0a2e'],
      [0.6, '#150825'],
      [1, '#0a0a0a'],
    ]);

    // Deep void glow
    drawRadialGlow(ctx, WIDTH * 0.5, HEIGHT * 0.5, 350, '#2a0845', 0.15);
    drawRadialGlow(ctx, WIDTH * 0.2, HEIGHT * 0.8, 200, '#1a0a2e', 0.1);
    drawRadialGlow(ctx, WIDTH * 0.8, HEIGHT * 0.2, 200, '#0d0221', 0.08);

    // Faint concentric rings like a black hole
    drawConcentricRings(ctx, WIDTH * 0.5, HEIGHT * 0.5, 300, 12, 'rgba(100,50,150,0.02)');

    // Very faint stars in the void
    drawStars(ctx, 15, 'rgba(150,100,200,0.1)');

    // Subtle hex pattern like reality fracturing
    drawHexPattern(ctx, 50, 'rgba(100,50,150,0.015)');

    // Scan line darkness
    ctx.fillStyle = 'rgba(0,0,0,0.04)';
    for (let y = 0; y < HEIGHT; y += 3) {
      ctx.fillRect(0, y, WIDTH, 1);
    }

    drawNoise(ctx, 4000, 0.025);
  },
};

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const presetList = JSON.parse(
    fs.readFileSync(path.join(OUTPUT_DIR, 'presets.json'), 'utf8')
  );

  console.log(`Generating ${presetList.length} rank card preset backgrounds (${WIDTH}x${HEIGHT})...\n`);

  for (const preset of presetList) {
    const generator = presets[preset.name];
    if (!generator) {
      console.warn(`  [SKIP] No generator found for preset "${preset.name}"`);
      continue;
    }

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    // Clear canvas
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // Generate the preset
    generator(ctx);

    // Write to file
    const outPath = path.join(OUTPUT_DIR, preset.file);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outPath, buffer);

    const sizeKB = (buffer.length / 1024).toFixed(1);
    console.log(`  [OK] ${preset.label.padEnd(10)} -> ${preset.file} (${sizeKB} KB)`);
  }

  console.log('\nDone! All presets generated.');
}

main().catch((err) => {
  console.error('Failed to generate presets:', err);
  process.exit(1);
});
