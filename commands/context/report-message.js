/*
 * Right-click a message → Apps → Report Message.
 *
 * Routes to the same staff destination `/engage report` uses, so a server does not have to
 * configure a second place for reports to land. Falls back through the configured contact
 * channel, then the moderation log, so a server that has set up either one already works.
 *
 * The reporter's identity goes to staff but the reply is ephemeral — reporting someone should
 * not itself be a public act.
 */

import { ContextMenuCommandBuilder, ApplicationCommandType, EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

/**
 * Where reports go, in order of preference. Each is a channel a server has already chosen for
 * staff traffic, so this adds no new configuration of its own.
 */
async function resolveReportChannel(guild) {
    const attempts = [
        ['SELECT reports_channel_id AS id FROM staff_contact_config WHERE guild_id = ?', 'staff contact'],
        ['SELECT mod_log_channel_id AS id FROM moderation_config WHERE guild_id = ?', 'moderation log'],
    ];

    for (const [sql] of attempts) {
        try {
            const [rows] = await pool.execute(sql, [guild.id]);
            const id = rows[0]?.id;
            if (!id) continue;
            const ch = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
            if (ch?.isTextBased()) return ch;
        } catch { /* table may not exist in this deployment — try the next */ }
    }
    return null;
}

export default {
    category: 'context',
    data: new ContextMenuCommandBuilder()
        .setName('Report Message')
        .setType(ApplicationCommandType.Message),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const message = interaction.targetMessage;

        if (message.author.id === interaction.user.id) {
            return interaction.editReply({ content: 'You cannot report your own message.' });
        }
        if (message.author.bot) {
            return interaction.editReply({
                content: 'That message was posted by a bot. If a bot is misbehaving, contact staff directly.',
            });
        }

        const channel = await resolveReportChannel(interaction.guild);
        if (!channel) {
            return interaction.editReply({
                content:
                    'This server has not set up a reports channel yet, so I have nowhere to send this. ' +
                    'An admin can set one under **Staff Contact** or **Moderation** on the dashboard.',
            });
        }

        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('Message reported')
            .addFields(
                { name: 'Reported user', value: `${message.author} (\`${message.author.id}\`)`, inline: true },
                { name: 'Reported by', value: `${interaction.user} (\`${interaction.user.id}\`)`, inline: true },
                { name: 'Channel', value: `${message.channel}`, inline: true },
                {
                    name: 'Content',
                    value: message.content ? message.content.slice(0, 1000) : '_(no text — attachment or embed only)_',
                    inline: false,
                },
                { name: 'Jump', value: `[Go to message](${message.url})`, inline: false },
            )
            .setTimestamp(message.createdAt)
            .setFooter({ text: `Message ID: ${message.id}` });

        if (message.attachments.size) {
            embed.addFields({
                name: `Attachments (${message.attachments.size})`,
                value: [...message.attachments.values()].map(a => a.url).join('\n').slice(0, 1000),
                inline: false,
            });
        }

        try {
            await channel.send({ embeds: [embed] });
        } catch (err) {
            logger.error('[ReportMessage] Could not deliver report', {
                error: err.message, guildId: interaction.guild.id, channelId: channel.id,
            });
            return interaction.editReply({
                content: 'I could not post to the reports channel — I may be missing permission there. Please contact staff directly.',
            });
        }

        await interaction.editReply({
            content: 'Thanks — staff have been notified. Your report is not visible to anyone else in the channel.',
        });
    },
};
