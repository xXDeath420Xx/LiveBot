/**
 * /weekly-recap enable|disable|preview — manage the per-server weekly recap.
 */
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import { postRecapIfDue } from '../../core/weekly-recap-manager.js';

const data = new SlashCommandBuilder()
    .setName('weekly-recap')
    .setDescription('Post a weekly summary of server activity, moderation, and streams.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
        .setName('enable')
        .setDescription('Enable weekly recap posts in a channel.')
        .addChannelOption(o => o.setName('channel').setDescription('Where to post the recap.').setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addIntegerOption(o => o.setName('day').setDescription('Day of week (0=Sun ... 6=Sat; default 1=Mon)')
            .setMinValue(0).setMaxValue(6))
        .addIntegerOption(o => o.setName('hour').setDescription('Hour UTC (0-23; default 9)')
            .setMinValue(0).setMaxValue(23)))
    .addSubcommand(sub => sub
        .setName('disable')
        .setDescription('Stop posting weekly recaps.'))
    .addSubcommand(sub => sub
        .setName('status')
        .setDescription('Show current weekly recap configuration.'))
    .addSubcommand(sub => sub
        .setName('preview')
        .setDescription('Post this week’s recap right now, ignoring the schedule.'));

async function execute(interaction) {
    if (!interaction.inGuild()) {
        return interaction.reply({ content: 'This command only works in a server.', ephemeral: true });
    }
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'enable') {
        const channel = interaction.options.getChannel('channel');
        const day = interaction.options.getInteger('day') ?? 1;
        const hour = interaction.options.getInteger('hour') ?? 9;
        await pool.execute(
            `INSERT INTO weekly_recap_config (guild_id, channel_id, enabled, day_of_week, hour, created_by)
             VALUES (?, ?, 1, ?, ?, ?)
             ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), enabled = 1,
                                     day_of_week = VALUES(day_of_week), hour = VALUES(hour),
                                     created_by = VALUES(created_by)`,
            [guildId, channel.id, day, hour, interaction.user.id]);
        const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day];
        return interaction.reply({
            content: `✓ Weekly recap enabled in ${channel}. First post: next ${dayName} at ${String(hour).padStart(2, '0')}:00 UTC.`,
            ephemeral: true,
        });
    }

    if (sub === 'disable') {
        await pool.execute(
            `UPDATE weekly_recap_config SET enabled = 0 WHERE guild_id = ?`,
            [guildId]);
        return interaction.reply({ content: '✓ Weekly recap disabled.', ephemeral: true });
    }

    if (sub === 'status') {
        const [rows] = await pool.execute(
            `SELECT channel_id, enabled, day_of_week, hour, last_posted_at
               FROM weekly_recap_config WHERE guild_id = ?`,
            [guildId]);
        if (!rows.length) {
            return interaction.reply({ content: 'Not configured. Set up with `/weekly-recap enable channel:#channel`.', ephemeral: true });
        }
        const r = rows[0];
        const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][r.day_of_week];
        const embed = new EmbedBuilder()
            .setColor(r.enabled ? 0x2ECC71 : 0x8A929B)
            .setTitle('Weekly Recap')
            .addFields(
                { name: 'Status',  value: r.enabled ? 'Enabled' : 'Disabled', inline: true },
                { name: 'Channel', value: `<#${r.channel_id}>`, inline: true },
                { name: 'When',    value: `${dayName} ${String(r.hour).padStart(2, '0')}:00 UTC`, inline: true },
                { name: 'Last posted', value: r.last_posted_at ? `<t:${Math.floor(new Date(r.last_posted_at).getTime() / 1000)}:R>` : 'Never', inline: true },
            );
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'preview') {
        await interaction.deferReply({ ephemeral: true });
        // Clear last_posted_at so the manager considers it due.
        await pool.execute(
            `UPDATE weekly_recap_config SET last_posted_at = NULL WHERE guild_id = ?`,
            [guildId]);
        const out = await postRecapIfDue(guildId);
        if (out.posted) return interaction.editReply({ content: '✓ Preview posted to the configured channel.' });
        return interaction.editReply({ content: `Couldn’t post: ${out.reason || 'unknown'}${out.error ? ` — ${out.error}` : ''}` });
    }
}

export { data, execute };
export default { category: 'admin', guildScoped: true, data, execute };
