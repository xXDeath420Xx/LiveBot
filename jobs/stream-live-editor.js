/**
 * Edits active Twitch go-live posts in place every 5 minutes with the current
 * viewer count + "live for X" uptime. Keeps stream posts fresh as the stream
 * progresses (P2.4 — Sapphire parity). Reads live_announcements rows with
 * platform='twitch', stream_started_at IS NOT NULL, offline_check_count=0.
 *
 * Only edits the EMBED FOOTER (minimal change — leaves title/body/thumbnail
 * untouched to avoid clobbering per-guild customisation).
 */
import cron from 'node-cron';
import axios from 'axios';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import botManager from '../core/bot-manager.js';
import { getAccessToken } from '../utils/platforms/twitch-api.js';

const LOG = '[StreamLiveEditor]';
let task = null;

async function fetchViewerCounts(twitchLogins) {
    if (!twitchLogins.length) return new Map();
    const token = await getAccessToken();
    const out = new Map();
    for (let i = 0; i < twitchLogins.length; i += 100) {
        const batch = twitchLogins.slice(i, i + 100);
        const url = 'https://api.twitch.tv/helix/streams?' + batch.map(l => `user_login=${encodeURIComponent(l)}`).join('&');
        try {
            const r = await axios.get(url, {
                headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
                timeout: 10_000,
            });
            for (const s of r.data?.data || []) {
                out.set(String(s.user_login).toLowerCase(), {
                    viewers: Number(s.viewer_count) || 0,
                    title: s.title || null, game: s.game_name || null,
                });
            }
        } catch (err) {
            logger.warn(`${LOG} fetchViewerCounts batch failed: ${err.message}`);
        }
    }
    return out;
}

function fmtUptime(ms) {
    const sec = Math.floor(ms / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

async function runCycle() {
    const [rows] = await pool.execute(
        `SELECT id, guild_id, platform, username, stream_started_at, channel_id, message_id,
                last_viewer_count, peak_viewer_count
           FROM live_announcements
          WHERE platform = 'twitch' AND stream_started_at IS NOT NULL AND offline_check_count = 0
          LIMIT 500`);
    if (!rows.length) return;

    const logins = [...new Set(rows.map(r => String(r.username).toLowerCase()))];
    const live = await fetchViewerCounts(logins);

    let edited = 0, skipped = 0, failed = 0;
    for (const r of rows) {
        const liveInfo = live.get(String(r.username).toLowerCase());
        if (!liveInfo) { skipped++; continue; }   // offline (will be swept by streamer-departure)
        const peak = Math.max(Number(r.peak_viewer_count) || 0, liveInfo.viewers);
        const uptimeMs = Date.now() - new Date(r.stream_started_at).getTime();
        const footerText = `${liveInfo.viewers} viewer${liveInfo.viewers === 1 ? '' : 's'} · peak ${peak} · live ${fmtUptime(uptimeMs)}`;

        try {
            const client = botManager?.getClientForGuild?.(String(r.guild_id));
            if (!client) { failed++; continue; }
            const channel = await client.channels.fetch(r.channel_id).catch(() => null);
            if (!channel) { failed++; continue; }
            const msg = await channel.messages.fetch(r.message_id).catch(() => null);
            if (!msg || !msg.editable) { failed++; continue; }
            // Keep every embed; just swap the footer on the first one.
            const embeds = msg.embeds.map(e => e.toJSON ? e.toJSON() : e);
            if (!embeds.length) { skipped++; continue; }
            embeds[0] = { ...embeds[0], footer: { text: footerText } };
            await msg.edit({ embeds });
            await pool.execute(
                'UPDATE live_announcements SET last_viewer_count = ?, peak_viewer_count = ?, last_edited_at = NOW() WHERE id = ?',
                [liveInfo.viewers, peak, r.id]);
            edited++;
        } catch (err) {
            logger.warn(`${LOG} edit ${r.id} failed: ${err.message}`);
            failed++;
        }
    }
    logger.info(`${LOG} cycle: ${rows.length} active · ${edited} edited · ${skipped} offline/skipped · ${failed} failed`);
}

export function startStreamLiveEditor() {
    if (task) { logger.warn(`${LOG} already running`); return; }
    // Every 5 minutes. Twitch rate limits per app-token = ~800/min so even
    // 500 broadcasters at once stays well under the ceiling via batched streams.
    task = cron.schedule('*/5 * * * *', () => {
        runCycle().catch(err => logger.error(`${LOG} cycle error: ${err.message}`));
    });
    logger.info(`${LOG} scheduled every 5 minutes`);
}
export function stopStreamLiveEditor() { if (task) { task.stop(); task = null; } }
