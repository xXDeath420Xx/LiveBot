const db = require('../utils/db');
const logger = require('../utils/logger');
const { EmbedBuilder } = require('discord.js');

async function checkEscalations(guild, user) {
    try {
        const [rules] = await db.execute('SELECT * FROM escalation_rules WHERE guild_id = ? ORDER BY infraction_count DESC', [guild.id]);
        if (rules.length === 0) return;

        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member || !member.moderatable) return;

        for (const rule of rules) {
            const sinceDate = new Date(Date.now() - rule.time_period_hours * 60 * 60 * 1000);
            const [[{ count }]] = await db.execute(
                'SELECT COUNT(*) as count FROM infractions WHERE guild_id = ? AND user_id = ? AND created_at >= ?',
                [guild.id, user.id, sinceDate]
            );

            if (count >= rule.infraction_count) {
                // This user has met the criteria for an escalation.
                // We apply the highest-matching rule and then stop.
                await applyAction(guild, member, user, rule);
                return; 
            }
        }
    } catch (error) {
        logger.error(`[EscalationManager] Error checking escalations for user ${user.id}:`, error);
    }
}

async function applyAction(guild, member, user, rule) {
    const reason = `Automatic action: ${rule.infraction_count} infractions in ${rule.time_period_hours} hours.`;

    // Log this new, automated infraction
    const [[{ 'LAST_INSERT_ID()': infractionId }]] = await db.execute(
        'INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason, duration_minutes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [guild.id, user.id, global.client.user.id, rule.action, reason, rule.action_duration_minutes, rule.action_duration_minutes ? new Date(Date.now() + rule.action_duration_minutes * 60000) : null]
    );

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
            await member.timeout(rule.action_duration_minutes * 60 * 1000, reason);
            break;
        case 'kick':
            await member.kick(reason);
            break;
        case 'ban':
            await member.ban({ reason });
            break;
    }
    
    // Announce it in the mod log
    const [[config]] = await db.execute('SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?', [guild.id]);
    if (!config || !config.mod_log_channel_id) return;
    const logChannel = await guild.channels.fetch(config.mod_log_channel_id).catch(() => null);
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

module.exports = { checkEscalations };