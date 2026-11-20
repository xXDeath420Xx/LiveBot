/*
 * Procedural wallpaper and profile-card images (node-canvas, loaded lazily). If canvas cannot load, every
 * function returns null and the caller falls back to a plain embed; the failure is remembered.
 */
import { wallpaperById } from './data/wallpapers.js';
import { seededRng } from './rules/rng.js';

let canvasMod;
let canvasFailed = false;

async function loadCanvas() {
    if (canvasFailed) return null;
    if (canvasMod) return canvasMod;
    try {
        canvasMod = await import('canvas');
        return canvasMod;
    } catch {
        canvasFailed = true;
        return null;
    }
}

const SAFE_HEX = /^#[0-9a-f]{6}$/i;
/** Valid #rrggbb colours of a wallpaper; dark grey when none are valid. */
export function wallpaperColors(wp) {
    const list = (wp?.colors || []).filter(c => SAFE_HEX.test(c));
    return list.length ? list : ['#2b2d31'];
}

function paint(ctx, wp, w, h) {
    const colors = wallpaperColors(wp);
    const style = wp?.style || 'solid';
    if (style === 'gradient' || style === 'waves' || style === 'stars') {
        const grad = ctx.createLinearGradient(0, 0, w, h);
        const stops = style === 'stars' ? [colors[0], colors[0]] : colors;
        stops.forEach((c, i) => grad.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), c));
        ctx.fillStyle = grad;
    } else {
        ctx.fillStyle = colors[0];
    }
    ctx.fillRect(0, 0, w, h);
    if (style === 'stripes') {
        const band = Math.max(12, Math.floor(w / 18));
        for (let x = -h, i = 0; x < w; x += band, i++) {
            ctx.fillStyle = colors[i % colors.length];
            ctx.globalAlpha = 0.55;
            ctx.beginPath();
            ctx.moveTo(x, 0); ctx.lineTo(x + band, 0); ctx.lineTo(x + band + h, h); ctx.lineTo(x + h, h);
            ctx.closePath(); ctx.fill();
        }
        ctx.globalAlpha = 1;
    } else if (style === 'waves') {
        for (let k = 0; k < 5; k++) {
            ctx.strokeStyle = colors[(k + 1) % colors.length];
            ctx.globalAlpha = 0.35;
            ctx.lineWidth = 6;
            ctx.beginPath();
            for (let x = 0; x <= w; x += 8) {
                const y = h * (0.25 + k * 0.14) + Math.sin((x / w) * Math.PI * 4 + k) * (h * 0.05);
                if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    } else if (style === 'stars') {
        const rng = seededRng(1000 + (wp?.id || 0)); // deterministic per wallpaper
        ctx.fillStyle = colors[1] || '#ffffff';
        for (let i = 0; i < 140; i++) {
            ctx.globalAlpha = 0.3 + rng() * 0.7;
            ctx.beginPath();
            ctx.arc(rng() * w, rng() * h, 0.6 + rng() * 2.2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
}

/** PNG of a wallpaper (preview). */
export async function renderWallpaper(id, { width = 800, height = 300 } = {}) {
    const wp = wallpaperById(id);
    const mod = await loadCanvas();
    if (!wp || !mod) return null;
    const c = mod.createCanvas(width, height);
    paint(c.getContext('2d'), wp, width, height);
    return c.toBuffer('image/png');
}

/**
 * PNG profile card. data: { wallpaperId, avatarUrl, name, title, about, tiles: [{ label, value }] (up to 4) }.
 */
export async function renderProfileCard(data, { width = 900, height = 380 } = {}) {
    const mod = await loadCanvas();
    const wp = wallpaperById(data?.wallpaperId);
    if (!mod || !wp) return null;
    const c = mod.createCanvas(width, height);
    const ctx = c.getContext('2d');
    paint(ctx, wp, width, height);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(20, 20, width - 40, height - 40);
    if (data.avatarUrl) {
        try {
            const img = await mod.loadImage(data.avatarUrl);
            ctx.save();
            ctx.beginPath(); ctx.arc(110, 110, 70, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
            ctx.drawImage(img, 40, 40, 140, 140);
            ctx.restore();
        } catch { /* no avatar */ }
    }
    const [r, g, b, a] = wp.nameColor;
    ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText(String(data.name || '').slice(0, 32), 210, 90);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '22px sans-serif';
    if (data.title) ctx.fillText(String(data.title).slice(0, 30), 210, 125);
    ctx.font = '18px sans-serif';
    const about = String(data.about || '');
    const words = about.split(/\s+/);
    let line = ''; let y = 165;
    for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > width - 260 && line) { ctx.fillText(line, 210, y); line = word; y += 24; if (y > 230) break; } else line = test;
    }
    if (line && y <= 230) ctx.fillText(line, 210, y);
    const tiles = (data.tiles || []).slice(0, 4);
    const tw = (width - 80 - (tiles.length - 1) * 16) / Math.max(1, tiles.length);
    tiles.forEach((t, i) => {
        const x = 40 + i * (tw + 16);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x, 260, tw, 90);
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '16px sans-serif';
        ctx.fillText(String(t.label).slice(0, 20), x + 14, 288);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 26px sans-serif';
        ctx.fillText(String(t.value).slice(0, 18), x + 14, 328);
    });
    return c.toBuffer('image/png');
}
