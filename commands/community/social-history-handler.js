/*
 * /socials streamer history — past streams of the streamers this server tracks, from stream_uptime
 * (recorded by core/stream-session-recorder.js). Only channels the server has a subscription for
 * are visible, so one server cannot browse another's tracking list.
 */
import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { formatSessionDuration } from '../../core/stream-session-logic.js';

const MAX_ROWS = 15;

/** Options for the `history` subcommand; socials (commands/community/social.js) adds them with `.addSubcommand(historySubcommand(platformChoices))`. */
export function historySubcommand(platformChoices) {
    return (sub) => sub
        .setName('history')
        .setDescription('Past streams of tracked streamers (times, length, peak viewers)')
        .addStringOption(opt => opt.setName('username').setDescription('Only this streamer'))
        .addStringOption(opt => opt.setName('platform').setDescription('Only this platform').addChoices(...platformChoices))
        .addIntegerOption(opt => opt.setName('days').setDescription('How far back (default 30)').setMinValue(1).setMaxValue(365));
}

export async function handleHistory(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const username = interaction.options.getString('username')?.trim() || null;
    const platform = interaction.options.getString('platform') || null;
    const days = interaction.options.getInteger('days') || 30;

    const where = [
        'su.stream_start >= DATE_SUB(NOW(), INTERVAL ? DAY)',
        `EXISTS (SELECT 1 FROM subscriptions sub JOIN streamers s ON s.streamer_id = sub.streamer_id
                  WHERE sub.guild_id = ? AND s.platform = su.platform AND s.username = su.username)`,
    ];
    const params = [days, interaction.guild.id];
    if (platform) {
        where.push('su.platform = ?');
        params.push(platform);
    }
    if (username) {
        where.push('su.username = ?');
        params.push(username);
    }

    try {
        const [rows] = await pool.execute(
            `SELECT su.platform, su.username, su.stream_start, su.stream_end, su.duration_seconds,
                    su.last_seen_at, su.peak_viewers, su.title, su.game, su.open_key
               FROM stream_uptime su
              WHERE ${where.join(' AND ')}
              ORDER BY su.stream_start DESC
              LIMIT ${MAX_ROWS}`,
            params
        );

        const [[totals]] = await pool.execute(
            `SELECT COUNT(*) AS streams,
                    COALESCE(SUM(COALESCE(su.duration_seconds, TIMESTAMPDIFF(SECOND, su.stream_start, COALESCE(su.last_seen_at, su.stream_start)))), 0) AS seconds,
                    MAX(su.peak_viewers) AS peak,
                    COUNT(DISTINCT su.platform, su.username) AS channels
               FROM stream_uptime su
              WHERE ${where.join(' AND ')}`,
            params
        );

        if (!rows.length) {
            const scope = username ? `**${username}**` : 'any tracked streamer';
            return interaction.editReply(
                `No streams recorded for ${scope} in the last ${days} day(s). ` +
                'History starts from when stream tracking began recording sessions.'
            );
        }

        const lines = rows.map((r) => {
            const start = Math.floor(new Date(r.stream_start).getTime() / 1000);
            const live = !!r.open_key;
            const seconds = live
                ? Math.max(0, (Date.now() - new Date(r.stream_start).getTime()) / 1000)
                : (r.duration_seconds ?? 0);
            const parts = [
                `<t:${start}:f>`,
                live ? `🔴 live · ${formatSessionDuration(seconds)} so far` : formatSessionDuration(seconds),
            ];
            if (r.peak_viewers != null) parts.push(`peak ${Number(r.peak_viewers).toLocaleString('en-US')}`);
            const who = username ? '' : `**${r.username}** (${r.platform}) · `;
            const what = r.game || r.title ? `\n   ${[r.game, r.title].filter(Boolean).join(' — ').slice(0, 120)}` : '';
            return `${who}${parts.join(' · ')}${what}`;
        });

        const totalSeconds = Number(totals?.seconds) || 0;
        const streams = Number(totals?.streams) || rows.length;
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle(username ? `Stream history — ${username}` : 'Stream history')
            .setDescription(lines.join('\n').slice(0, 4000))
            .addFields(
                { name: 'Streams', value: String(streams), inline: true },
                { name: 'Total time', value: formatSessionDuration(totalSeconds), inline: true },
                { name: 'Average', value: formatSessionDuration(streams ? totalSeconds / streams : 0), inline: true },
            )
            .setFooter({ text: `Last ${days} day(s)${streams > rows.length ? ` · showing latest ${rows.length}` : ''}` });
        if (totals?.peak != null) embed.addFields({ name: 'Peak viewers', value: Number(totals.peak).toLocaleString('en-US'), inline: true });
        if (!username && Number(totals?.channels) > 1) embed.addFields({ name: 'Channels', value: String(totals.channels), inline: true });

        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        logger.error('[StreamHistory] /socials streamer history failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply('Could not load stream history right now.');
    }
}

export default { historySubcommand, handleHistory };
