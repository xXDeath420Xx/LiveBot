/*
 * Live-stream announcement card.
 *
 * Discord's image proxy can't fetch Twitch's CDN, so a hotlinked preview or avatar renders
 * as a broken image. We compose the card here and upload the bytes with the message, which
 * Discord hosts itself — always renders, and the layout is ours rather than a raw preview frame.
 */
import Canvas from 'canvas';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WIDTH = 1200;
const HEIGHT = 400;

// Monochrome emoji font so glyphs render as shapes instead of tofu boxes (same
// approach as the event-schedule renderer).
const EMOJI_FONT = 'NotoEmoji';
try {
    Canvas.registerFont(path.join(__dirname, '../assets/fonts/NotoEmoji-Regular.ttf'), { family: EMOJI_FONT });
} catch { /* optional */ }

const FONT = 'DejaVu Sans';

// Accent per platform — the card should read as "a Twitch stream" at a glance
const PLATFORM_STYLE = {
    twitch: { accent: '#9146FF', label: 'TWITCH' },
    kick: { accent: '#53FC18', label: 'KICK' },
    youtube: { accent: '#FF0000', label: 'YOUTUBE' },
    tiktok: { accent: '#FF0050', label: 'TIKTOK' },
    facebook: { accent: '#1877F2', label: 'FACEBOOK' },
    instagram: { accent: '#E4405F', label: 'INSTAGRAM' },
    rumble: { accent: '#85C742', label: 'RUMBLE' },
};
const DEFAULT_STYLE = { accent: '#5865F2', label: 'LIVE' };

function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** Trim to the given pixel width, adding an ellipsis when it doesn't fit. */
function fit(ctx, text, maxWidth) {
    const str = String(text ?? '');
    if (ctx.measureText(str).width <= maxWidth) return str;
    let out = str;
    while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
    return out + '…';
}

function formatUptime(startedAt) {
    if (!startedAt) return null;
    const ms = Date.now() - new Date(startedAt).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    const mins = Math.floor(ms / 60000);
    const h = Math.floor(mins / 60);
    return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

/**
 * @param {object} data
 * @param {string} data.username        streamer display name
 * @param {string} [data.title]         stream title
 * @param {string} [data.game]          category / game
 * @param {number} [data.viewers]
 * @param {string} [data.startedAt]     ISO timestamp, for uptime
 * @param {string} data.platform
 * @param {Buffer} [data.avatarBuffer]  avatar bytes (already downloaded by the announcer)
 * @param {boolean} [data.offline]      render the ended-stream variant (grey, OFFLINE badge)
 * @returns {Promise<Buffer|null>} PNG bytes, or null if rendering fails
 */
export async function renderStreamCard(data) {
    try {
        const offline = !!data.offline;
        // An ended stream drops the platform colour entirely — the card must never still
        // read as live once the message has been edited to "stream has ended".
        const style = offline
            ? { accent: '#6b7280', label: String(data.platform || '').toUpperCase() || 'STREAM' }
            : (PLATFORM_STYLE[String(data.platform || '').toLowerCase()] || DEFAULT_STYLE);
        const canvas = Canvas.createCanvas(WIDTH, HEIGHT);
        const ctx = canvas.getContext('2d');

        // Background: dark base with a subtle wash of the platform accent
        ctx.fillStyle = '#0f1015';
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        const wash = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
        wash.addColorStop(0, `${style.accent}33`);
        wash.addColorStop(0.55, '#0f101500');
        wash.addColorStop(1, `${style.accent}1a`);
        ctx.fillStyle = wash;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);

        // Accent spine down the left edge
        ctx.fillStyle = style.accent;
        ctx.fillRect(0, 0, 12, HEIGHT);

        // ── Avatar ───────────────────────────────────────────────────────────
        const AV = 220;
        const avX = 64, avY = (HEIGHT - AV) / 2;
        let drewAvatar = false;
        if (data.avatarBuffer) {
            try {
                const img = await Canvas.loadImage(data.avatarBuffer);
                ctx.save();
                roundedRect(ctx, avX, avY, AV, AV, 28);
                ctx.clip();
                if (offline) ctx.globalAlpha = 0.45; // visibly dimmed once the stream is over
                ctx.drawImage(img, avX, avY, AV, AV);
                ctx.restore();
                drewAvatar = true;
            } catch { /* fall through to the initial */ }
        }
        if (!drewAvatar) {
            // Initial on an accent tile, so a missing avatar still looks deliberate
            ctx.fillStyle = `${style.accent}44`;
            roundedRect(ctx, avX, avY, AV, AV, 28);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = `bold 110px "${FONT}"`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(data.username || '?').charAt(0).toUpperCase(), avX + AV / 2, avY + AV / 2);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
        }
        // Accent ring around the avatar
        ctx.strokeStyle = style.accent;
        ctx.lineWidth = 5;
        roundedRect(ctx, avX, avY, AV, AV, 28);
        ctx.stroke();

        // ── Right-hand column ────────────────────────────────────────────────
        const colX = avX + AV + 48;
        const colW = WIDTH - colX - 56;

        // Status pill, top-right
        const pillLabel = offline ? 'OFFLINE' : 'LIVE';
        const pillW = offline ? 176 : 130;
        const pillH = 46;
        const pillX = WIDTH - pillW - 56, pillY = 52;
        ctx.fillStyle = offline ? '#3a3d46' : '#ff3b30';
        roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
        ctx.fill();
        ctx.fillStyle = offline ? '#9aa0ad' : '#ffffff';
        ctx.beginPath();
        ctx.arc(pillX + 30, pillY + pillH / 2, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `bold 24px "${FONT}"`;
        ctx.fillText(pillLabel, pillX + 48, pillY + pillH / 2 + 8);

        // Platform label above the name
        ctx.fillStyle = style.accent;
        ctx.font = `bold 26px "${FONT}"`;
        ctx.fillText(style.label, colX, 92);

        // Streamer name
        ctx.fillStyle = offline ? '#9aa0ad' : '#ffffff';
        ctx.font = `bold 62px "${FONT}"`;
        ctx.fillText(fit(ctx, data.username, colW - pillW - 24), colX, 160);

        // Stream title
        ctx.fillStyle = offline ? '#767b87' : '#c9ccd4';
        ctx.font = `34px "${FONT}"`;
        ctx.fillText(fit(ctx, offline ? (data.title || 'Stream has ended') : (data.title || 'Untitled Stream'), colW), colX, 214);

        // ── Stat row ─────────────────────────────────────────────────────────
        // Only facts that stay true for the life of the card. The embed is deliberately not
        // refreshed on a timer, so a viewer count or uptime baked in here would be a lie
        // within minutes — those are passed through and rendered only when the caller opts
        // in by supplying them AND asking for a live-refreshing card.
        const stats = [];
        if (data.game) stats.push(['CATEGORY', data.game]);
        if (data.showLiveStats) {
            if (Number.isFinite(data.viewers) && data.viewers > 0) stats.push(['VIEWERS', String(data.viewers)]);
            const uptime = formatUptime(data.startedAt);
            if (uptime) stats.push(['UPTIME', uptime]);
        }

        let sx = colX;
        const statY = 292;
        for (const [label, value] of stats) {
            // Measure at the exact sizes these are drawn at, or the box comes out
            // too narrow and every value gets needlessly ellipsised.
            ctx.font = `bold 28px "${FONT}"`;
            const valueWidth = ctx.measureText(value).width;
            ctx.font = `600 18px "${FONT}"`;
            const boxW = Math.min(Math.max(valueWidth, ctx.measureText(label).width) + 44, 340);
            if (sx + boxW > WIDTH - 56) break; // don't run off the card

            ctx.fillStyle = offline ? '#ffffff0d' : '#ffffff14';
            roundedRect(ctx, sx, statY, boxW, 78, 14);
            ctx.fill();

            ctx.fillStyle = offline ? '#6a6f7b' : '#8b90a0';
            ctx.font = `600 18px "${FONT}"`;
            ctx.fillText(label, sx + 22, statY + 30);

            ctx.fillStyle = offline ? '#8b90a0' : '#ffffff';
            ctx.font = `bold 28px "${FONT}"`;
            ctx.fillText(fit(ctx, value, boxW - 44), sx + 22, statY + 62);

            sx += boxW + 16;
        }

        return canvas.toBuffer('image/png');
    } catch (error) {
        logger.warn(`[StreamCard] Render failed for ${data?.username}: ${error.message}`, { category: 'announcer' });
        return null;
    }
}

export default { renderStreamCard };
