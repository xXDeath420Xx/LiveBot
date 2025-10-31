import db from '../utils/db';
import logger from '../utils/logger';
import { EmbedBuilder, CommandInteraction, User, Guild, TextChannel } from 'discord.js';
import { RowDataPacket } from 'mysql2';

interface ModerationConfig extends RowDataPacket {
    mod_log_channel_id: string | null;
}

interface EscalationCheckGuild {
    id: string;
    channels: {
        fetch: (channelId: string) => Promise<TextChannel | null>;
    };
    members: {
        fetch: (userId: string) => Promise<any>;
    };
}

async function checkEscalations(guild: EscalationCheckGuild | Guild, user: User): Promise<void> {
    // This function is imported from escalation-manager
    const { checkEscalations: checkEscalationsImpl } = await import('./escalation-manager');
    await checkEscalationsImpl(guild as any, user);
}

async function logInfraction(
    interaction: CommandInteraction,
    user: User,
    type: string,
    reason: string,
    durationMinutes: number | null = null
): Promise<void> {
    try {
        const expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60000) : null;

        await db.execute(
            'INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason, duration_minutes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [interaction.guild!.id, user.id, interaction.user.id, type, reason, durationMinutes, expiresAt]
        );

        const [[config]] = await db.execute<ModerationConfig[]>(
            'SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?',
            [interaction.guild!.id]
        );
        if (!config || !config.mod_log_channel_id) return;

        const logChannel = await interaction.guild!.channels.fetch(config.mod_log_channel_id).catch(() => null) as TextChannel | null;
        if (!logChannel) return;

        let color = '#E67E22'; // Default for Warning
        if (type === 'Mute') color = '#F1C40F';
        if (type === 'Kick') color = '#E74C3C';
        if (type === 'Ban') color = '#C0392B';
        if (type === 'Unmute' || type === 'Unban') color = '#2ECC71'; // Green for reversals
        if (type === 'ClearInfractions') color = '#95A5A6'; // Add this line for a neutral/grey color

        const logEmbed = new EmbedBuilder()
            .setColor(color)
            .setAuthor({ name: 'Moderation Log' })
            .setTitle(`${type.charAt(0).toUpperCase() + type.slice(1)} Issued`)
            .addFields(
                { name: 'User', value: `${user.tag} (${user.id})`, inline: false },
                { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
                { name: 'Reason', value: reason }
            )
            .setTimestamp();

        if (durationMinutes) {
            logEmbed.addFields({ name: 'Duration', value: `${durationMinutes} minutes` });
        }

        await logChannel.send({ embeds: [logEmbed] });

        // We don't check for escalations on reversal actions
        if (type !== 'Unmute' && type !== 'Unban') {
            await checkEscalations(interaction.guild!, user);
        }

    } catch (error: any) {
        logger.error('[ModerationManager] Failed to log infraction:', error as Record<string, any>);
    }
}

export { logInfraction };
