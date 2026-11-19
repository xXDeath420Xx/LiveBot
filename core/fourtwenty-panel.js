/**
 * Self-updating 4:20 world clock panel — the Discord twin of the /420 overlay's
 * "extended" layout.
 *
 * Countdowns are Discord <t:…:R> timestamps, which every viewer's client ticks
 * live in their own time zone. So the message only needs editing when the
 * content itself changes: a city starts or finishes its 4:20 minute and the
 * upcoming list reshuffles. The job checks every minute and edits on change.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { ZONES, snapshot } from '../utils/fourtwenty.js';

const SITE = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');
const GREEN = 0x7dfc4f;
const FLAME = 0xff9f1c;
const UPCOMING_ROWS = 8;
export const MAX_PANELS_PER_GUILD = 5;

// Discord error codes that mean the panel is gone for good.
const GONE = new Set([10003, 10008]); // Unknown Channel, Unknown Message

const short = (zone) => zone.label.split(',')[0];

/** What the panel shows. Two snapshots with the same signature render identically. */
export function signature(snap) {
    return JSON.stringify([
        snap.lit.map(l => l.zone.tz),
        snap.upcoming.slice(0, UPCOMING_ROWS).map(u => [u.zone.tz, u.at]),
        snap.last?.zone.tz
    ]);
}

export function buildPanel(snap = snapshot()) {
    const next = snap.upcoming[0];
    const lines = [];

    if (snap.lit.length) {
        const where = snap.lit.map(l => `${l.zone.flag} **${l.zone.label}** (${l.ap})`).join(' · ');
        lines.push(`🔥 **It's 4:20 right now in** ${where}`, '');
        lines.push(`Then ${next.zone.flag} **${next.zone.label}** <t:${next.at}:R>`);
    } else {
        lines.push(`Next up: ${next.zone.flag} **${next.zone.label}** — 4:20 ${next.ap} there <t:${next.at}:R>`);
        lines.push(`That's <t:${next.at}:t> your time.`);
    }

    const rows = snap.upcoming.slice(0, UPCOMING_ROWS)
        .map(u => `${u.zone.flag} **${short(u.zone)}** · 4:20 ${u.ap} · <t:${u.at}:t> your time · <t:${u.at}:R>`);

    const embed = new EmbedBuilder()
        .setColor(snap.lit.length ? FLAME : GREEN)
        .setTitle('🍃 Where in the world is it 4:20?')
        .setDescription(lines.join('\n'))
        .addFields(
            { name: '⏱️ Coming up', value: rows.join('\n') },
            {
                name: '🕰️ Last 4:20',
                value: snap.last ? `${snap.last.zone.flag} **${short(snap.last.zone)}** <t:${snap.last.at}:R>` : '—',
                inline: true
            },
            { name: '🌍 Cities tracked', value: String(ZONES.length), inline: true }
        )
        .setFooter({ text: 'Updates automatically · times shown in your own time zone' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel('Put this clock on your stream')
            .setEmoji('📺')
            .setURL(`${SITE}/420/obs`)
    );

    return { embeds: [embed], components: [row] };
}

/** The client that posted a panel — only it can edit the message. */
function clientFor(row) {
    const bm = global.botManager;
    if (bm?.clients) {
        for (const c of bm.clients.values()) {
            if (c.isReady?.() && c.user?.id === row.bot_user_id) return c;
        }
    }
    return null;
}

export async function listPanels(guildId) {
    const [rows] = await pool.execute(
        'SELECT * FROM fourtwenty_panels WHERE guild_id = ? ORDER BY created_at', [guildId]);
    return rows;
}

/**
 * Post a panel in `channel`, replacing any earlier panel in that channel.
 * Returns the new message.
 */
export async function postPanel(channel, userId) {
    const [existing] = await pool.execute(
        'SELECT * FROM fourtwenty_panels WHERE guild_id = ? AND channel_id = ?',
        [channel.guild.id, channel.id]);

    const msg = await channel.send(buildPanel());

    if (existing.length) {
        await channel.messages.delete(existing[0].message_id).catch(() => {});
        await pool.execute(
            'UPDATE fourtwenty_panels SET message_id = ?, bot_user_id = ?, created_by = ?, created_at = NOW() WHERE id = ?',
            [msg.id, channel.client.user.id, userId, existing[0].id]);
        lastSig.delete(existing[0].id);
    } else {
        await pool.execute(
            'INSERT INTO fourtwenty_panels (guild_id, channel_id, message_id, bot_user_id, created_by) VALUES (?, ?, ?, ?, ?)',
            [channel.guild.id, channel.id, msg.id, channel.client.user.id, userId]);
    }
    return msg;
}

/** Remove the panel in a channel. Returns false if there wasn't one. */
export async function removePanel(guildId, channelId, client) {
    const [rows] = await pool.execute(
        'SELECT * FROM fourtwenty_panels WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
    if (!rows.length) return false;

    const poster = clientFor(rows[0]) || client;
    const channel = await poster.channels.fetch(channelId).catch(() => null);
    await channel?.messages.delete(rows[0].message_id).catch(() => {});
    await pool.execute('DELETE FROM fourtwenty_panels WHERE id = ?', [rows[0].id]);
    lastSig.delete(rows[0].id);
    return true;
}

// panel id -> signature last rendered into it. In memory on purpose: after a
// restart every panel gets one refresh, which is exactly what we want.
const lastSig = new Map();
let running = false;

export async function refreshAll() {
    if (running) return; // a slow cycle must not overlap the next minute's
    running = true;
    try {
        const snap = snapshot();
        const sig = signature(snap);
        const [rows] = await pool.execute('SELECT * FROM fourtwenty_panels');
        let payload = null;

        for (const row of rows) {
            if (lastSig.get(row.id) === sig) continue;

            const client = clientFor(row);
            if (!client) continue; // poster not logged in (yet) — try next minute

            payload ??= buildPanel(snap);
            try {
                const channel = await client.channels.fetch(row.channel_id);
                await channel.messages.edit(row.message_id, payload);
                lastSig.set(row.id, sig);
            } catch (err) {
                if (GONE.has(err.code)) {
                    await pool.execute('DELETE FROM fourtwenty_panels WHERE id = ?', [row.id]);
                    lastSig.delete(row.id);
                    logger.info('[420Panel] Panel deleted in Discord, dropping it', {
                        guildId: row.guild_id, channelId: row.channel_id, code: err.code
                    });
                } else {
                    // Missing Access / Permissions: keep the row — an admin may fix
                    // the channel. Mark it rendered so we warn once per change, not every minute.
                    lastSig.set(row.id, sig);
                    logger.warn('[420Panel] Could not edit panel', {
                        guildId: row.guild_id, channelId: row.channel_id, code: err.code, error: err.message
                    });
                }
            }
        }
    } catch (err) {
        logger.error('[420Panel] Refresh cycle failed', { error: err.message });
    } finally {
        running = false;
    }
}
