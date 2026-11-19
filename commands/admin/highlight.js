/**
 * /highlight — config surface for the Highlights feed (destination channel + stats).
 * Pinning actual messages is done via the "Highlight Message" context-menu command.
 */
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';

const data = new SlashCommandBuilder()
    .setName('highlight')
    .setDescription('Config the mod-highlight feed. Right-click a message → Apps → Highlight Message to pin one.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('channel').setDescription('Set the destination feed channel.')
        .addChannelOption(o => o.setName('channel').setDescription('Where highlighted messages post.').setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand(sub => sub.setName('status').setDescription('Current feed channel + recent highlight count.'))
    .addSubcommand(sub => sub.setName('disable').setDescription('Turn off the feed (keeps the row history).'));

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'channel') {
        const channel = interaction.options.getChannel('channel');
        await pool.execute(
            `INSERT INTO guild_settings (guild_id, highlight_channel_id) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE highlight_channel_id = VALUES(highlight_channel_id)`,
            [guildId, channel.id]);
        return interaction.reply({ content: `Highlight feed → ${channel}. Right-click any message → Apps → **Highlight Message** to pin one.`, ephemeral: true });
    }

    if (sub === 'disable') {
        await pool.execute(
            `UPDATE guild_settings SET highlight_channel_id = NULL WHERE guild_id = ?`, [guildId]);
        return interaction.reply({ content: 'Highlight feed disabled. Existing history kept (`/moderation highlight status` still shows it).', ephemeral: true });
    }

    // status
    const [[cfg]]      = await pool.execute('SELECT highlight_channel_id FROM guild_settings WHERE guild_id = ?', [guildId]);
    const [[counts]]   = await pool.execute(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN created_at > DATE_SUB(NOW(), INTERVAL 7  DAY) THEN 1 ELSE 0 END) AS last7,
                SUM(CASE WHEN created_at > DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS last30
           FROM message_highlights WHERE guild_id = ?`, [guildId]);
    const embed = new EmbedBuilder()
        .setTitle('Highlights — status')
        .setDescription(cfg?.highlight_channel_id ? `Feed channel: <#${cfg.highlight_channel_id}>` : 'No feed channel set — `/moderation highlight channel` to pick one.')
        .addFields(
            { name: 'Last 7 days',  value: String(counts?.last7  || 0), inline: true },
            { name: 'Last 30 days', value: String(counts?.last30 || 0), inline: true },
            { name: 'All-time',     value: String(counts?.total  || 0), inline: true },
        )
        .setFooter({ text: 'Pin a message via its right-click → Apps → Highlight Message. Requires Manage Messages.' });
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

export { data, execute };
export default { category: 'admin', data, execute };
