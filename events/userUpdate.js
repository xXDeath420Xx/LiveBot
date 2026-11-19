import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { sendLogEmbed } from '../core/log-manager.js';
import { onUserUpdate as checkNameFilters } from '../core/name-filters.js';
import { onUserUpdate as checkAvatarProtection } from '../core/avatar-protection.js';
import { observeFlags } from '../core/user-flag-observations.js';

/**
 * Whether this client is the bot that logs for a guild: a guild with a custom bot is logged by that bot,
 * every other guild by the default bot. Every bot sharing a guild receives the same userUpdate, so without
 * this one profile change would be posted once per bot.
 */
async function logsForGuild(client, guildId) {
    const [rows] = await pool.execute('SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?', [guildId]);
    if (client.isDefaultBot) return rows.length === 0;
    return rows.some(r => String(r.bot_id) === client.user?.id);
}

export default {
    name: Events.UserUpdate,
    async execute(oldUser, newUser) {
        // Name filters: a new username or display name is checked in every server this bot serves
        // that has name checks on (core/name-filters.js). Never throws.
        void checkNameFilters(oldUser, newUser);
        // Avatar protection: a new avatar is checked the same way (core/avatar-protection.js). Never throws.
        void checkAvatarProtection(oldUser, newUser);

        // Flag observation — if Discord changed this user's public_flags (added/removed SPAMMER,
        // QUARANTINED, etc.) we want to know. Fire-and-forget.
        if ((oldUser?.flags?.bitfield ?? 0) !== (newUser?.flags?.bitfield ?? 0)) {
            observeFlags(newUser, null);
        }

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

            // Profile changes log under the Member updates category (memberUpdate.profile), so they follow the
            // server's Logging page: master switch, ticked events, per-event channel and colour. They used to
            // need a 'userUpdate' event the Logging page never offered, so they were never posted anywhere.
            for (const guild of newUser.client.guilds.cache.values()) {
                try {
                    if (!guild.members.cache.has(newUser.id)) continue;
                    if (!await logsForGuild(newUser.client, guild.id)) continue;

                    const embed = new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle('User Profile Updated')
                        .setDescription(`${newUser} updated their profile`)
                        .addFields(
                            { name: 'User', value: `${newUser.tag} (${newUser.id})`, inline: true },
                            { name: 'Changes', value: changes.join('\n'), inline: false }
                        )
                        .setThumbnail(newUser.displayAvatarURL({ size: 256 }))
                        .setTimestamp();

                    await sendLogEmbed(guild, 'memberUpdate', embed, 'memberUpdate.profile',
                        { member: guild.members.cache.get(newUser.id), user: newUser });
                } catch (e) {
                    logger.debug(`[User] Profile update not logged in ${guild.id}: ${e.message}`);
                }
            }
        } catch (error) {
            logger.error('[User] Error logging user update:', { error: error.message });
        }
    }
};
