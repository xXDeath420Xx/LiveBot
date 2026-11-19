/**
 * How a live announcement should be drawn, resolved per streamer / per channel / per guild.
 *
 *   'twitch' (default) — hotlink the platform's live preview as the embed image and the
 *                        streamer's avatar as the embed thumbnail. This is what the unified
 *                        community channel does via jobs/cross-network-scheduler.js.
 *   'card'             — upload the card we render ourselves (utils/stream-card.js).
 *
 * The card exists because Discord's image proxy briefly could not fetch Twitch's preview CDN
 * (see the comment in utils/announcer.js) — hotlinked previews came back 0x0 and rendered
 * broken. That has since stopped being true: live messages in the unified channel currently
 * proxy at 1920x1080. So 'twitch' is the default again, and 'card' stays available for anyone
 * who prefers the uniform look or hits proxy trouble on a niche platform.
 *
 * Most specific scope wins: streamer → channel → guild → DEFAULT_STYLE.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

export const STYLES = ['twitch', 'card', 'v2'];
export const DEFAULT_STYLE = 'twitch';

export const STYLE_LABELS = {
    twitch: 'Platform preview (Twitch-style thumbnail)',
    card: 'Custom rendered card',
    v2: 'Components V2 (new Discord layout — container, media gallery, watch button)',
};

const isStyle = (value) => STYLES.includes(value);

/**
 * @returns {Promise<{style: string, source: 'streamer'|'channel'|'guild'|'default'}>}
 */
export async function resolveStyle({ guildId, channelId = null, streamerId = null }) {
    if (!guildId) return { style: DEFAULT_STYLE, source: 'default' };
    try {
        const [rows] = await pool.execute(
            `SELECT scope_type, scope_id, style FROM stream_render_style
             WHERE guild_id = ? AND (
                   (scope_type = 'guild')
                or (scope_type = 'channel'  AND scope_id = ?)
                or (scope_type = 'streamer' AND scope_id = ?))`,
            [guildId, String(channelId ?? ''), String(streamerId ?? '')]
        );
        if (!rows.length) return { style: DEFAULT_STYLE, source: 'default' };

        for (const scope of ['streamer', 'channel', 'guild']) {
            const hit = rows.find(r => r.scope_type === scope && isStyle(r.style));
            if (hit) return { style: hit.style, source: scope };
        }
        return { style: DEFAULT_STYLE, source: 'default' };
    } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE') return { style: DEFAULT_STYLE, source: 'default' };
        // Never let a settings lookup stop an announcement — fall back to the default look.
        logger.warn(`[StreamRenderStyle] Lookup failed for guild ${guildId}: ${error.message}`);
        return { style: DEFAULT_STYLE, source: 'default' };
    }
}

export async function setStyle({ guildId, scopeType, scopeId = '', style, updatedBy = null }) {
    if (!['guild', 'channel', 'streamer'].includes(scopeType)) throw new Error(`Bad scope type: ${scopeType}`);
    if (!isStyle(style)) throw new Error(`Bad style: ${style}`);
    await pool.execute(
        `INSERT INTO stream_render_style (guild_id, scope_type, scope_id, style, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE style = VALUES(style), updated_by = VALUES(updated_by)`,
        [guildId, scopeType, scopeType === 'guild' ? '' : String(scopeId), style, updatedBy]
    );
}

/** Remove an override so the scope falls back to the next one up. */
export async function clearStyle({ guildId, scopeType, scopeId = '' }) {
    await pool.execute(
        'DELETE FROM stream_render_style WHERE guild_id = ? AND scope_type = ? AND scope_id = ?',
        [guildId, scopeType, scopeType === 'guild' ? '' : String(scopeId)]
    );
}

export async function listStyles(guildId) {
    try {
        const [rows] = await pool.execute(
            'SELECT scope_type, scope_id, style, updated_at FROM stream_render_style WHERE guild_id = ? ORDER BY scope_type, scope_id',
            [guildId]
        );
        return rows;
    } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE') return [];
        throw error;
    }
}

/**
 * Size a platform preview URL and force Discord to re-proxy it.
 *
 * Twitch hands out a template (`{width}`/`{height}`) and the resulting URL is stable for the
 * whole stream — so on an embed update Discord would serve the frame it cached the first time.
 * The bucket param changes every few minutes, which is what makes the preview actually move.
 */
export function sizePreviewUrl(url, { bucket = null, width = 440, height = 248 } = {}) {
    if (!url) return null;
    let out = String(url).replace('{width}', String(width)).replace('{height}', String(height));
    if (bucket !== null) out += (out.includes('?') ? '&' : '?') + `t=${bucket}`;
    return out;
}

export default { STYLES, DEFAULT_STYLE, STYLE_LABELS, resolveStyle, setStyle, clearStyle, listStyles, sizePreviewUrl };
