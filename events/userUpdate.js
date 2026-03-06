import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

export default {
    name: Events.UserUpdate,
    async execute(oldUser, newUser) {
        try {
            const changes = [];
            if (oldUser.username !== newUser.username) changes.push(`Username: ${oldUser.username} → ${newUser.username}`);
            if (oldUser.discriminator !== newUser.discriminator) changes.push(`Discriminator: #${oldUser.discriminator} → #${newUser.discriminator}`);
            if (oldUser.avatar !== newUser.avatar) changes.push('Avatar changed');
            if (oldUser.banner !== newUser.banner) changes.push('Banner changed');
            if (oldUser.globalName !== newUser.globalName) changes.push(`Display Name: ${oldUser.globalName || 'None'} → ${newUser.globalName || 'None'}`);

            if (changes.length === 0) return;

            logger.info(`[User] User ${newUser.tag} updated their profile`, {
                userId: newUser.id,
                changes,
                category: 'userUpdate'
            });

            // Log to all guilds this user is in that have logging enabled
            for (const [guildId, guild] of newUser.client.guilds.cache) {
                try {
                    const member = guild.members.cache.get(newUser.id);
                    if (!member) continue;

                    const [config] = await pool.execute(
                        'SELECT log_channel_id, enabled_events FROM logging_config WHERE guild_id = ?',
                        [guildId]
                    );

                    if (config.length === 0) continue;

                    const enabledEvents = JSON.parse(config[0].enabled_events || '[]');
                    if (!enabledEvents.includes('userUpdate')) continue;

                    const logChannel = await guild.channels.fetch(config[0].log_channel_id).catch(() => null);
                    if (!logChannel) continue;

                    const embed = new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle('👤 User Profile Updated')
                        .setDescription(`${newUser} updated their profile`)
                        .addFields(
                            { name: 'User', value: `${newUser.tag} (${newUser.id})`, inline: true },
                            { name: 'Changes', value: changes.join('\n'), inline: false }
                        )
                        .setThumbnail(newUser.displayAvatarURL({ dynamic: true }))
                        .setTimestamp();

                    await logChannel.send({ embeds: [embed] });
                } catch (e) {
                    // Skip this guild
                }
            }
        } catch (error) {
            logger.error('[User] Error logging user update:', { error: error.message });
        }
    }
};
