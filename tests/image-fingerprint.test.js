/*
 * The blocklist deletes messages and can ban on spread, so the cost of a false positive here is a
 * member losing a real conversation. These tests pin both directions: every plausible re-post of a
 * blocked image must still match, and ordinary server artwork must not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import {
  fingerprint, matchEntry, hamming, colourDistance, popcount,
  sigToHex, sigFromHex, DHASH_MATCH, COLOUR_MATCH,
} from '../core/image-fingerprint.js';

const SCAM = ['docs/scam.jpg', 'docs/image.jpg', 'docs/image2.jpg'];

// Ordinary images that must never be mistaken for the blocked set: server graphics, unrelated
// screenshots (the same GENRE as the scam images, which are themselves screenshots), and game art.
const ORDINARY = [
  'docs/Rules.png', 'docs/Welcome.png', 'docs/SafeSpace.png', 'docs/ModBears.png',
  'docs/Shouties.png', 'docs/Unsolicited.png', 'docs/Adult_Consent.png', 'docs/image.png',
  'docs/Screenshot 2026-05-09 150701.png', 'docs/Screenshot 2026-05-09 150728.png',
  'docs/Screenshot 2026-05-09 150745.png', 'docs/Screenshot 2026-05-12 163734.png',
  'docs/Screenshot 2026-05-13 041546.png', 'docs/Screenshot_20260602_140808_High_Seas_Hero.jpg',
  'assets/rank-presets/fire.png', 'assets/rank-presets/ocean.png', 'assets/rank-presets/neon.png',
  'assets/catbot/gremlin.png', 'assets/catbot/epic.png', 'assets/catbot/rickroll.png',
];

const entriesFrom = async files => {
  const out = [];
  for (const f of files) {
    const fp = await fingerprint(fs.readFileSync(f));
    out.push({ id: out.length + 1, label: f, dhash: fp.dhash, bitsSet: fp.bitsSet, colourSig: fp.colourSig });
  }
  return out;
};

test('re-posts of a blocked image are still caught', async () => {
  const entries = await entriesFrom(SCAM);
  const src = fs.readFileSync('docs/scam.jpg');
  const meta = await sharp(src).metadata();

  const reposts = {
    identical: src,
    'jpeg q40': await sharp(src).jpeg({ quality: 40 }).toBuffer(),
    'jpeg q20': await sharp(src).jpeg({ quality: 20 }).toBuffer(),
    'png recode': await sharp(src).png().toBuffer(),
    // Discord re-serves uploads as WebP. Before fastShrinkOnLoad was disabled this one MISSED,
    // because libjpeg's decode-time shrink is a different resampler from WebP's.
    webp: await sharp(src).webp().toBuffer(),
    'resize 50%': await sharp(src).resize({ width: Math.round(meta.width * 0.5) }).toBuffer(),
    'resize 30%': await sharp(src).resize({ width: Math.round(meta.width * 0.3) }).toBuffer(),
    'brighten 1.2': await sharp(src).modulate({ brightness: 1.2 }).toBuffer(),
    'saturate 1.3': await sharp(src).modulate({ saturation: 1.3 }).toBuffer(),
    'pasted black bar': await sharp(src).composite([{
      input: { create: { width: meta.width, height: Math.round(meta.height * 0.08), channels: 3, background: { r: 0, g: 0, b: 0 } } },
      gravity: 'south',
    }]).toBuffer(),
  };

  for (const [name, buf] of Object.entries(reposts)) {
    const hit = matchEntry(await fingerprint(buf), entries);
    assert.ok(hit, `re-post not caught: ${name}`);
  }
});

test('ordinary images are never matched', async () => {
  const entries = await entriesFrom(SCAM);
  for (const f of ORDINARY) {
    const hit = matchEntry(await fingerprint(fs.readFileSync(f)), entries);
    assert.equal(hit, null, `false positive: ${f} matched ${hit?.label} (d=${hit?.distance}, colour=${hit?.colour})`);
  }
});

test('colour has to agree, not just the greyscale hash', async () => {
  // A strong tint leaves layout (and therefore dHash) intact while changing what a viewer sees, so
  // it reaches the colour gate and nothing else. If colour were redundant with dHash this would be
  // unreachable — the tinted image passes dHash at distance 3 and is rejected on colour alone.
  const src = fs.readFileSync('docs/scam.jpg');
  const base = await fingerprint(src);
  const tinted = await fingerprint(await sharp(src).tint({ r: 255, g: 60, b: 60 }).toBuffer());
  assert.ok(hamming(base.dhash, tinted.dhash) <= DHASH_MATCH, 'a tint should not move dHash much');
  assert.ok(colourDistance(base.colourSig, tinted.colourSig) > COLOUR_MATCH, 'colour should notice a heavy tint');
});

test('dHash keeps a wide margin against unrelated screenshots', async () => {
  // Colour is NOT a strong second signal within this threat class: the scam images are light-UI
  // screenshots, and two unrelated light-UI screenshots sit as close as 3.5 apart on colour — well
  // inside COLOUR_MATCH. What actually separates them is dHash, so that margin is asserted here
  // rather than assumed. If a future change erodes it, colour will not cover for it.
  const scam = await fingerprint(fs.readFileSync('docs/scam.jpg'));
  const shots = ORDINARY.filter(f => f.includes('Screenshot'));
  assert.ok(shots.length >= 4, 'expected several unrelated screenshots in the corpus');
  for (const f of shots) {
    const other = await fingerprint(fs.readFileSync(f));
    const d = hamming(scam.dhash, other.dhash);
    assert.ok(d > DHASH_MATCH + 5, `only ${d} bits between scam.jpg and ${f} — margin too thin`);
  }
});

test('flat and gradient images are refused rather than matched', async () => {
  // A near-uniform image has no horizontal detail, so every neighbour comparison answers the same
  // way and the hash degenerates to all-zeros — which would match every other flat image at
  // distance 0. forest.png and a vendored jQuery UI gradient really do collide this way.
  const solid = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 20, g: 60, b: 120 } } }).png().toBuffer();
  const gradient = fs.readFileSync('assets/rank-presets/forest.png');

  for (const [name, buf] of [['solid colour', solid], ['gradient', gradient]]) {
    const fp = await fingerprint(buf);
    assert.equal(fp.usable, false, `${name} should be refused as a fingerprint (bits=${fp.bitsSet})`);
    assert.equal(matchEntry(fp, [{ id: 1, label: 'x', dhash: fp.dhash, bitsSet: fp.bitsSet, colourSig: fp.colourSig }]), null,
      `${name} matched itself despite being degenerate`);
  }
});

test('a degenerate entry can never match, even a byte-identical post', async () => {
  // Both directions of the guard: an all-zero entry that slipped into the table must not start
  // deleting every flat image people post.
  const flat = await fingerprint(await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer());
  const entry = { id: 1, label: 'degenerate', dhash: flat.dhash, bitsSet: flat.bitsSet, colourSig: flat.colourSig };
  const other = await fingerprint(await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 200, g: 9, b: 9 } } }).png().toBuffer());
  assert.equal(matchEntry(other, [entry]), null);
});

test('colour signature survives a hex round-trip', async () => {
  const fp = await fingerprint(fs.readFileSync('docs/scam.jpg'));
  const back = sigFromHex(sigToHex(fp.colourSig));
  assert.equal(sigToHex(back).length, 96);
  assert.equal(colourDistance(fp.colourSig, back), 0);
});

test('popcount and hamming agree on known values', () => {
  assert.equal(popcount(0n), 0);
  assert.equal(popcount(0xffn), 8);
  assert.equal(hamming(0b1010n, 0b0101n), 4);
  assert.equal(hamming(42n, 42n), 0);
});
