/**
 * /stream-analytics — configure + inspect Twitch stream anti-abuse analytics.
 *
 * Users first need to re-connect their Twitch via the broadcaster-OAuth flow with the
 * expanded scope set (migration 342 + auth-twitch-broadcaster.js scope expansion). The
 * `status` subcommand surfaces which scopes they have granted and nudges them to re-OAuth
 * if any critical ones are missing.
 */
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';

const REQUIRED_SCOPES = [
    'moderator:read:followers',
    'channel:read:subscriptions',
    'bits:read',
    'channel:moderate',
    'user:read:chat',
    'user:bot',
];

const data = new SlashCommandBuilder()
    .setName('stream-analytics')
    .setDescription('Twitch anti-abuse analytics: view-bot / follow-bot / raid / harassment alerts.')
    .setDMPermission(false)
    .addSubcommand(sub => sub
        .setName('setup')
        .setDescription('Set the channel where anomaly alerts post.')
        .addChannelOption(o => o.setName('channel').setDescription('Discord channel for alerts.').setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand(sub => sub
        .setName('disable')
        .setDescription('Stop posting anomaly alerts (data keeps being collected).'))
    .addSubcommand(sub => sub
        .setName('status')
        .setDescription('Show your current configuration + which Twitch scopes you have granted.'))
    .addSubcommand(sub => sub
        .setName('recent')
        .setDescription('Show the last anomaly alerts fired on your Twitch channel.'))
    .addSubcommand(sub => sub
        .setName('summary')
        .setDescription('Rolled-up stats for your current / most-recent stream.'));

/**
 * Resolve the Discord user → Twitch broadcaster binding for a specific guild.
 *
 * Two tables are involved:
 *  - twitch_oauth_accounts: identity verification (email scope only). Confirms
 *    the Discord user owns the Twitch account.
 *  - twitch_role_sync_config: per-guild broadcaster OAuth with the SCOPES
 *    constant from auth-twitch-broadcaster.js. This is the scoped token that
 *    unlocks EventSub subscriptions for analytics.
 *
 * Both are required to configure analytics in a guild: identity to attribute,
 * broadcaster config to actually subscribe.
 */
async function getLinkedTwitch(discordUserId, guildId) {
    const [idRows] = await pool.execute(
        `SELECT twitch_user_id, twitch_username FROM twitch_oauth_accounts WHERE discord_user_id = ?`,
        [String(discordUserId)]);
    const identity = idRows[0];
    if (!identity) return { identity: null, broadcaster: null };

    let broadcaster = null;
    if (guildId) {
        const [brRows] = await pool.execute(
            `SELECT broadcaster_twitch_id, broadcaster_twitch_username, token_scopes, enabled
               FROM twitch_role_sync_config
              WHERE guild_id = ? AND broadcaster_twitch_id = ?`,
            [String(guildId), String(identity.twitch_user_id)]);
        broadcaster = brRows[0] || null;
    }
    return { identity, broadcaster };
}

function missingScopes(granted) {
    const have = new Set(String(granted || '').split(/[\s,]+/).filter(Boolean));
    return REQUIRED_SCOPES.filter(s => !have.has(s));
}

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (!interaction.inGuild()) {
        return interaction.reply({ content: 'Run this inside a server — analytics config is bound to the server where you completed the broadcaster OAuth.', ephemeral: true });
    }

    const { identity, broadcaster } = await getLinkedTwitch(interaction.user.id, interaction.guildId);
    if (!identity) {
        return interaction.reply({
            content: `You haven't linked your Twitch account yet. Link it here, then run this command again: ${(process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '')}/auth/twitch/link?guildId=${interaction.guildId}`,
            ephemeral: true,
        });
    }
    if (!broadcaster) {
        return interaction.reply({
            content: `Your Twitch account **${identity.twitch_username}** is linked, but this server hasn't bound you as its broadcaster yet. A server admin needs to complete the "Broadcaster OAuth" step on the dashboard for **this** server (${interaction.guild?.name || 'this guild'}) first.`,
            ephemeral: true,
        });
    }

    const broadcasterId = String(identity.twitch_user_id);
    const broadcasterName = identity.twitch_username;

    if (sub === 'setup') {
        const channel = interaction.options.getChannel('channel');
        await pool.execute(
            `INSERT INTO twitch_analytics_config (broadcaster_id, enabled, alert_discord_guild_id, alert_discord_channel_id)
             VALUES (?, 1, ?, ?)
             ON DUPLICATE KEY UPDATE enabled = 1,
                                     alert_discord_guild_id = VALUES(alert_discord_guild_id),
                                     alert_discord_channel_id = VALUES(alert_discord_channel_id)`,
            [broadcasterId, interaction.guildId, channel.id]);
        const missing = missingScopes(broadcaster.token_scopes);
        let scopeNote = '';
        if (missing.length) {
            scopeNote = `\n\n**Note:** your broadcaster OAuth is missing these scopes: \`${missing.join(', ')}\`. Re-authorise via dashboard → Twitch → Broadcaster OAuth to grant them. Until then, analytics are limited to viewer counts and raid alerts.`;
        }
        return interaction.reply({
            content: `✓ Anomaly alerts for **${broadcasterName}** will post to ${channel}.${scopeNote}`,
            ephemeral: true,
        });
    }

    if (sub === 'disable') {
        await pool.execute(
            `UPDATE twitch_analytics_config SET enabled = 0 WHERE broadcaster_id = ?`,
            [broadcasterId]);
        return interaction.reply({ content: '✓ Anomaly alerts disabled. Data collection continues; use `/creator analytics setup` to re-enable alerts.', ephemeral: true });
    }

    if (sub === 'status') {
        const [cfgRows] = await pool.execute(
            `SELECT * FROM twitch_analytics_config WHERE broadcaster_id = ?`,
            [broadcasterId]);
        const cfg = cfgRows[0];
        const missing = missingScopes(broadcaster.token_scopes);
        const embed = new EmbedBuilder()
            .setColor(cfg?.enabled ? 0x2ECC71 : 0x8A929B)
            .setTitle('Twitch stream analytics — status')
            .addFields(
                { name: 'Twitch', value: broadcasterName, inline: true },
                { name: 'Status', value: cfg?.enabled ? 'Enabled' : 'Not configured', inline: true },
                { name: 'Alert channel', value: cfg?.alert_discord_channel_id ? `<#${cfg.alert_discord_channel_id}>` : '—', inline: true },
                { name: 'Scopes granted', value: broadcaster.token_scopes ? `\`${broadcaster.token_scopes}\`` : 'Unknown (pre-upgrade token)', inline: false },
                { name: 'Scopes missing', value: missing.length ? `\`${missing.join(', ')}\`\nRe-authorise via dashboard → Twitch → Broadcaster OAuth.` : 'None — fully scoped', inline: false },
                { name: 'Thresholds', value:
                    `view-bot: ${cfg?.viewbot_threshold ?? 0.020} msgs/viewer/min, min ${cfg?.viewbot_min_viewers ?? 50} viewers\n` +
                    `follow-bot: ${cfg?.followbot_threshold ?? 10} follows/min\n` +
                    `mod spike: ${cfg?.mod_spike_threshold ?? 5} actions/min\n` +
                    `harassment: ${cfg?.harassment_threshold ?? 5} unique @-mentioners / 5 min`, inline: false },
            );
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'recent') {
        const [rows] = await pool.execute(
            `SELECT alert_type, severity, score, evidence_json, created_at FROM twitch_anomaly_alerts
              WHERE broadcaster_id = ? ORDER BY created_at DESC LIMIT 10`,
            [broadcasterId]);
        if (!rows.length) {
            return interaction.reply({ content: 'No anomaly alerts recorded yet for your channel. (Alerts only fire while you\'re live and the system has at least one user-scope subscription for you.)', ephemeral: true });
        }
        const embed = new EmbedBuilder()
            .setColor(0xE2B23A)
            .setTitle('Recent anomaly alerts')
            .setDescription(rows.map(r => {
                let ev = {};
                try { ev = JSON.parse(r.evidence_json || '{}'); } catch { /* ignore */ }
                const when = `<t:${Math.floor(new Date(r.created_at).getTime() / 1000)}:R>`;
                return `**${r.alert_type}** · ${r.severity} · ${when}\n${ev.interpretation || `score ${r.score}`}`;
            }).join('\n\n'));
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'summary') {
        const [rows] = await pool.execute(
            `SELECT MIN(recorded_at) AS from_time, MAX(recorded_at) AS to_time,
                    AVG(viewer_count) AS avg_viewers, MAX(viewer_count) AS peak_viewers,
                    SUM(msg_count) AS total_msgs, SUM(follow_count) AS total_follows,
                    SUM(sub_count) AS total_subs, SUM(bit_count) AS total_bits,
                    SUM(raid_in_count) AS total_raids
               FROM twitch_stream_snapshots
              WHERE broadcaster_id = ? AND recorded_at > DATE_SUB(NOW(), INTERVAL 12 HOUR) AND is_live = 1`,
            [broadcasterId]);
        const r = rows[0];
        if (!r || !r.from_time) {
            return interaction.reply({ content: 'No live snapshot data recorded in the last 12 hours. Analytics only populate while your stream is live.', ephemeral: true });
        }
        const dur = Math.round((new Date(r.to_time) - new Date(r.from_time)) / 60000);
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`Stream summary — ${broadcasterName}`)
            .setDescription(`${dur} minute(s) of live data, <t:${Math.floor(new Date(r.from_time).getTime()/1000)}:f> → <t:${Math.floor(new Date(r.to_time).getTime()/1000)}:f>`)
            .addFields(
                { name: 'Peak viewers', value: String(Number(r.peak_viewers) || 0), inline: true },
                { name: 'Avg viewers', value: String(Math.round(Number(r.avg_viewers) || 0)), inline: true },
                { name: 'Total chat', value: String(Number(r.total_msgs) || 0), inline: true },
                { name: 'New follows', value: String(Number(r.total_follows) || 0), inline: true },
                { name: 'New subs', value: String(Number(r.total_subs) || 0), inline: true },
                { name: 'Bits', value: String(Number(r.total_bits) || 0), inline: true },
                { name: 'Raids received', value: String(Number(r.total_raids) || 0), inline: true },
            );
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
}

export { data, execute };
export default { category: 'community', data, execute };
