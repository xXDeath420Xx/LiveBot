import db from '../utils/db';
import logger from '../utils/logger';
import { EmbedBuilder, Guild, User, GuildMember, TextChannel } from 'discord.js';
import { RowDataPacket } from 'mysql2';

interface EscalationRule extends RowDataPacket {
    infraction_count: number;
    time_period_hours: number;
    action: string;
    action_duration_minutes: number | null;
}

interface InfractionCount extends RowDataPacket {
    count: number;
}

interface ModerationConfig extends RowDataPacket {
    mod_log_channel_id: string | null;
}

interface InfractionIdResult extends RowDataPacket {
    'LAST_INSERT_ID()': number;
}

async function checkEscalations(guild: Guild, user: User): Promise<void> {
    try {
        const [rules] = await db.execute<EscalationRule[]>('SELECT * FROM escalation_rules WHERE guild_id = ? ORDER BY infraction_count DESC', [guild.id]);

        if (rules.length === 0) return;

        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member || !member.moderatable) return;

        for (const rule of rules) {
            const sinceDate = new Date(Date.now() - rule.time_period_hours * 60 * 60 * 1000);
            const [[result]] = await db.execute<InfractionCount[]>(
                'SELECT COUNT(*) as count FROM infractions WHERE guild_id = ? AND user_id = ? AND created_at >= ?',
                [guild.id, user.id, sinceDate]
            );

            if (result.count >= rule.infraction_count) {
                // This user has met the criteria for an escalation.
                // We apply the highest-matching rule and then stop.
                await applyAction(guild, member, user, rule);
                return;
            }
        }
    } catch (error) {
        logger.error(`[EscalationManager] Error checking escalations for user ${user.id}:`, error as Record<string, any>);
    }
}

async function applyAction(guild: Guild, member: GuildMember, user: User, rule: EscalationRule): Promise<void> {
    const reason = `Automatic action: ${rule.infraction_count} infractions in ${rule.time_period_hours} hours.`;

    // Log this new, automated infraction
    const [[result]] = await db.execute<InfractionIdResult[]>(
        'INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason, duration_minutes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [guild.id, user.id, (global as any).client.user.id, rule.action, reason, rule.action_duration_minutes, rule.action_duration_minutes ? new Date(Date.now() + rule.action_duration_minutes * 60000) : null]
    );

    const infractionId = result['LAST_INSERT_ID()'];

    // DM the user about the automated action
    try {
        const dmEmbed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle(`Automatic Action Taken in ${guild.name}`)
            .setDescription(`Due to accumulating too many infractions recently, an automatic action has been taken.`)
            .addFields(
                { name: 'Action', value: rule.action },
                { name: 'Reason', value: reason }
            );

        if (rule.action_duration_minutes) {
            dmEmbed.addFields({ name: 'Duration', value: `${rule.action_duration_minutes} minutes` });
        }

        await user.send({ embeds: [dmEmbed] });
    } catch (e) {
        logger.warn(`[EscalationManager] Could not DM user ${user.tag} about automated action.`);
    }

    // Apply the action
    switch (rule.action) {
        case 'mute':
            await member.timeout(rule.action_duration_minutes! * 60 * 1000, reason);
            break;
        case 'kick':
            await member.kick(reason);
            break;
        case 'ban':
            await member.ban({ reason });
            break;
    }

    // Announce it in the mod log
    const [[config]] = await db.execute<ModerationConfig[]>('SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?', [guild.id]);

    if (!config || !config.mod_log_channel_id) return;

    const logChannel = await guild.channels.fetch(config.mod_log_channel_id).catch(() => null) as TextChannel | null;
    if (!logChannel) return;

    const logEmbed = new EmbedBuilder()
        .setColor('#C0392B')
        .setAuthor({ name: 'Automated Moderation' })
        .setTitle(`Escalation Rule Triggered`)
        .addFields(
            { name: 'User', value: `${user.tag} (${user.id})` },
            { name: 'Action Taken', value: `${rule.action} ${rule.action_duration_minutes ? `(${rule.action_duration_minutes}m)` : ''}` },
            { name: 'Trigger', value: `Reached ${rule.infraction_count} infractions in ${rule.time_period_hours} hours.` },
            { name: 'Case ID', value: `#${infractionId}` }
        )
        .setTimestamp();

    await logChannel.send({ embeds: [logEmbed] });
}

export { checkEscalations };
