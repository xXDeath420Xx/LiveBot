/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * Draws OwO profile wallpapers with node-canvas (already a dependency — utils/rank-card-generator.js
 * uses it). Upstream served pre-rendered wallpaper PNGs from its image host; we have none, so each
 * catalog entry (owo_backgrounds.style + colors) is painted procedurally: solid, gradient, a seeded
 * star field, soft waves, or stripes.
 *
 * canvas is a native module. It is imported lazily and a failure is remembered, so a box without
 * it still shows profiles — as a plain embed in the wallpaper's colour instead of an image.
 */
import logger from '../../utils/logger.js';
import { rgbaFromNameColor, seededRandom } from './social-math.js';

let canvasMod = null;
let canvasUnavailable = false;

async function loadCanvas() {
    if (canvasMod || canvasUnavailable) return canvasMod;
    try {
        const m = await import('canvas');
        canvasMod = m.createCanvas ? m : m.default;
    } catch (e) {
        canvasUnavailable = true;
        logger.warn('[OwO] canvas unavailable — profiles fall back to plain embeds', { err: e.message });
    }
    return canvasMod;
}

function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function gradientFill(ctx, w, h, colors) {
    if (colors.length === 1) return colors[0];
    const g = ctx.createLinearGradient(0, 0, w, h);
    colors.forEach((c, i) => g.addColorStop(i / (colors.length - 1), c));
    return g;
}

/** Paint a wallpaper over the whole canvas. Pure drawing — no I/O. */
export function paintWallpaper(ctx, w, h, wp) {
    const colors = wp?.colors?.length ? wp.colors : ['#2c2f33'];
    ctx.fillStyle = wp?.style === 'solid' ? colors[0] : gradientFill(ctx, w, h, colors);
    ctx.fillRect(0, 0, w, h);

    if (wp?.style === 'stars') {
        const rand = seededRandom(wp.bid || 1);
        for (let i = 0; i < Math.round((w * h) / 2600); i++) {
            const r = rand() < 0.9 ? rand() * 1.4 + 0.3 : rand() * 2.4 + 1.2;
            ctx.globalAlpha = 0.35 + rand() * 0.65;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(rand() * w, rand() * h, r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    } else if (wp?.style === 'waves') {
        for (let band = 0; band < 3; band++) {
            ctx.globalAlpha = 0.12 + band * 0.05;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            const base = h * (0.55 + band * 0.15);
            ctx.moveTo(0, h);
            for (let x = 0; x <= w; x += 8) {
                ctx.lineTo(x, base + Math.sin((x / w) * Math.PI * (2 + band) + band) * h * 0.06);
            }
            ctx.lineTo(w, h);
            ctx.closePath();
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    } else if (wp?.style === 'stripes') {
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = '#ffffff';
        for (let x = -h; x < w; x += 36) {
            ctx.beginPath();
            ctx.moveTo(x, h); ctx.lineTo(x + 18, h); ctx.lineTo(x + 18 + h, 0); ctx.lineTo(x + h, 0);
            ctx.closePath();
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
}

function fitText(ctx, text, maxWidth) {
    let t = String(text ?? '');
    if (ctx.measureText(t).width <= maxWidth) return t;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
    return `${t}…`;
}

function wrapLines(ctx, text, maxWidth, maxLines) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (ctx.measureText(next).width <= maxWidth) { line = next; continue; }
        if (line) lines.push(line);
        line = word;
        if (lines.length === maxLines) break;
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
        lines[maxLines - 1] = fitText(ctx, `${lines[maxLines - 1]}…`, maxWidth);
    }
    return lines.map(l => fitText(ctx, l, maxWidth));
}

/** A 600x200 swatch of a wallpaper with its name, for the shop. Returns a PNG Buffer or null. */
export async function renderWallpaperPreview(wp) {
    const mod = await loadCanvas();
    if (!mod) return null;
    try {
        const w = 600; const h = 200;
        const canvas = mod.createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        paintWallpaper(ctx, w, h, wp);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        roundRectPath(ctx, 20, h - 70, w - 40, 50, 12);
        ctx.fill();
        ctx.fillStyle = rgbaFromNameColor(wp.nameColor);
        ctx.font = 'bold 26px Arial';
        ctx.fillText(fitText(ctx, `${wp.name}`, w - 80), 40, h - 36);
        return canvas.toBuffer('image/png');
    } catch (e) {
        logger.warn('[OwO] wallpaper preview render failed', { bid: wp?.bid, err: e.message });
        return null;
    }
}

/**
 * The profile card: wallpaper, avatar, name/title/about and a row of stats.
 * @param {{wallpaper, avatarURL: string, name: string, title?: string, about?: string,
 *          stats: Array<{label: string, value: string}>, accent?: string}} p
 * @returns {Promise<Buffer|null>} PNG, or null when canvas is unavailable or drawing failed
 */
export async function renderProfileCard(p) {
    const mod = await loadCanvas();
    if (!mod) return null;
    try {
        const w = 900; const h = 340;
        const canvas = mod.createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        paintWallpaper(ctx, w, h, p.wallpaper);

        // Readability panel behind the text.
        ctx.fillStyle = 'rgba(0,0,0,0.38)';
        roundRectPath(ctx, 230, 24, w - 254, h - 48, 18);
        ctx.fill();

        // Avatar.
        const ax = 30; const ay = 70; const size = 180;
        ctx.save();
        ctx.beginPath();
        ctx.arc(ax + size / 2, ay + size / 2, size / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fill();
        ctx.clip();
        try {
            if (p.avatarURL) ctx.drawImage(await mod.loadImage(p.avatarURL), ax, ay, size, size);
        } catch (e) {
            logger.debug?.('[OwO] profile avatar load failed', { err: e.message });
        }
        ctx.restore();
        ctx.lineWidth = 6;
        ctx.strokeStyle = p.accent || '#ffffff';
        ctx.beginPath();
        ctx.arc(ax + size / 2, ay + size / 2, size / 2, 0, Math.PI * 2);
        ctx.stroke();

        const tx = 256; const maxW = w - tx - 44;
        ctx.fillStyle = rgbaFromNameColor(p.wallpaper?.nameColor);
        ctx.font = 'bold 40px Arial';
        ctx.fillText(fitText(ctx, p.name, maxW), tx, 78);

        let y = 112;
        if (p.title) {
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.font = 'italic 24px Arial';
            ctx.fillText(fitText(ctx, p.title, maxW), tx, y);
            y += 34;
        }
        if (p.about) {
            ctx.fillStyle = 'rgba(255,255,255,0.92)';
            ctx.font = '20px Arial';
            for (const line of wrapLines(ctx, p.about, maxW, 3)) { ctx.fillText(line, tx, y); y += 26; }
        }

        // Stats row along the bottom of the panel.
        const stats = (p.stats || []).slice(0, 4);
        if (stats.length) {
            const colW = maxW / stats.length;
            stats.forEach((s, i) => {
                const sx = tx + i * colW;
                ctx.fillStyle = 'rgba(255,255,255,0.65)';
                ctx.font = '15px Arial';
                ctx.fillText(fitText(ctx, s.label, colW - 12), sx, h - 70);
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 24px Arial';
                ctx.fillText(fitText(ctx, s.value, colW - 12), sx, h - 42);
            });
        }
        return canvas.toBuffer('image/png');
    } catch (e) {
        logger.warn('[OwO] profile card render failed', { err: e.message });
        return null;
    }
}
