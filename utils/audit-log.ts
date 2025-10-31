import { EmbedBuilder, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import pool from './db';
import { logger } from './logger';
import { RowDataPacket } from 'mysql2/promise';

interface GuildSettingsRow extends RowDataPacket {
    audit_log_channel_id: string | null;
}

async function logAuditEvent(
    interaction: ChatInputCommandInteraction,
    title: string,
    description: string
): Promise<void> {
    try {
        const [guildSettingsRows] = await pool.execute<GuildSettingsRow[]>(
            'SELECT audit_log_channel_id FROM guilds WHERE guild_id = ?',
            [interaction.guild!.id]
        );
        const guildSettings = guildSettingsRows[0];
        const channelId = guildSettings?.audit_log_channel_id;

        if (!channelId) {
            return; // This guild has not configured an audit log channel.
        }

        const auditChannel = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (!auditChannel || !(auditChannel instanceof TextChannel)) {
            logger.warn(`[Audit Log] Guild ${interaction.guild!.id} has an invalid audit channel ID: ${channelId}`);
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#FEE75C')
            .setTitle(title)
            .setDescription(description)
            .setTimestamp()
            .setFooter({
                text: `Action performed by: ${interaction.user.tag}`,
                iconURL: interaction.user.displayAvatarURL()
            });

        await auditChannel.send({ embeds: [embed] });

    } catch (error: unknown) {
        logger.error(`[Audit Log] Failed to send audit log for guild ${interaction.guild!.id}:`, { error });
    }
}

export { logAuditEvent };
