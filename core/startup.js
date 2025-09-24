const logger = require('../utils/logger');
const db = require('../utils/db');
const { PermissionsBitField } = require('discord.js');

async function cleanupInvalidRole(guildId, roleId) {
    if (!guildId || !roleId) return;
    logger.warn(`[Role Cleanup] Aggressively purging invalid role ID ${roleId} for guild ${guildId}.`);
    try {
        await db.execute('UPDATE guilds SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?', [guildId, roleId]);
        await db.execute('UPDATE twitch_teams SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?', [guildId, roleId]);
    } catch (dbError) {
        logger.error(`[Role Cleanup] DB Error while purging role ${roleId} for guild ${guildId}:`, { error: dbError });
    }
}

async function startupCleanup(client) {
    logger.info('[Startup Cleanup] Starting...');
    try {
        // --- STAGE 1: Proactive Role Validation and Cleanup ---
        logger.info('[Startup Cleanup] Stage 1: Validating all configured role IDs...');
        const [guildRoles] = await db.execute('SELECT guild_id, live_role_id FROM guilds WHERE live_role_id IS NOT NULL');
        const [teamRoles] = await db.execute('SELECT guild_id, live_role_id FROM twitch_teams WHERE live_role_id IS NOT NULL');
        const allRoleConfigs = [...guildRoles, ...teamRoles];
        const uniqueGuildIds = [...new Set(allRoleConfigs.map(c => c.guild_id))];

        for (const guildId of uniqueGuildIds) {
            try {
                const guild = await client.guilds.fetch(guildId);
                const rolesForGuild = allRoleConfigs.filter(c => c.guild_id === guildId);
                const uniqueRoleIds = [...new Set(rolesForGuild.map(c => c.live_role_id))];

                for (const roleId of uniqueRoleIds) {
                    if (!roleId) continue;
                    const roleExists = await guild.roles.fetch(roleId).catch(() => null);
                    if (!roleExists) {
                        logger.warn(`[Startup Cleanup] Found invalid role ${roleId} in guild ${guildId} during validation.`);
                        await cleanupInvalidRole(guildId, roleId);
                    }
                }
            } catch (e) {
                // Guild likely no longer exists, ignore.
            }
        }
        logger.info('[Startup Cleanup] Stage 1: Proactive role validation complete.');

        // --- STAGE 2: Remove Roles from Members ---
        logger.info('[Startup Cleanup] Stage 2: Removing live roles from all members...');
        const [allGuildsWithRoles] = await db.execute('SELECT DISTINCT guild_id FROM guilds WHERE live_role_id IS NOT NULL');
        const [allTeamsWithRoles] = await db.execute('SELECT DISTINCT guild_id FROM twitch_teams WHERE live_role_id IS NOT NULL');
        const allGuildsForRolePurge = [...new Set([...allGuildsWithRoles.map(g => g.guild_id), ...allTeamsWithRoles.map(g => g.guild_id)])];

        for (const guildId of allGuildsForRolePurge) {
            try {
                const guild = await client.guilds.fetch(guildId);
                logger.info(`[Startup Cleanup] Processing guild for roles: ${guild.name} (${guildId}). Fetching all members...`);
                const members = await guild.members.fetch({ force: true, cache: true });
                logger.info(`[Startup Cleanup] Member cache for ${guild.name} is full (${members.size} members). Clearing roles...`);

                const [guildLiveRole] = await db.execute('SELECT live_role_id FROM guilds WHERE guild_id = ?', [guildId]);
                const [teamLiveRoles] = await db.execute('SELECT live_role_id FROM twitch_teams WHERE guild_id = ?', [guildId]);
                const roleIds = new Set([
                    guildLiveRole[0]?.live_role_id,
                    ...teamLiveRoles.map(t => t.live_role_id)
                ].filter(Boolean));

                if (roleIds.size === 0) {
                    logger.info(`[Startup Cleanup] No live roles configured for guild ${guild.name} (${guildId}). Skipping role removal.`);
                    continue;
                }

                for (const roleId of roleIds) {
                    const role = guild.roles.cache.get(roleId);
                    if (role) {
                        const membersWithRole = members.filter(member => member.roles.cache.has(roleId));
                        if (membersWithRole.size > 0) {
                            logger.info(`[Startup Cleanup] Removing role '${role.name}' from ${membersWithRole.size} member(s) in ${guild.name}.`);
                            for (const member of membersWithRole.values()) {
                                await member.roles.remove(role, 'Bot restart cleanup').catch(e => {
                                    logger.error(`[Startup Cleanup] Failed to remove role ${role.name} from ${member.user.tag} (${member.id}): ${e.message}`);
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                logger.error(`[Startup Cleanup] Failed to process guild ${guildId}:`, { error: e.message });
            }
        }
        logger.info('[Startup Cleanup] Stage 2: Live role removal from members complete.');

        // --- STAGE 3: Purge Old Announcements ---
        logger.info('[Startup Cleanup] Stage 3: Purging all bot messages from announcement channels...');
        const [allGuildsWithSettingsForPurge] = await db.execute('SELECT DISTINCT guild_id FROM guilds');
        const [allGuildsWithSubsForPurge] = await db.execute('SELECT DISTINCT guild_id FROM subscriptions');
        const allGuildsForPurgeAnnc = [...new Set([...allGuildsWithSettingsForPurge.map(g => g.guild_id), ...allGuildsWithSubsForPurge.map(g => g.guild_id)])];

        for (const guildId of allGuildsForPurgeAnnc) {
            try {
                const guild = await client.guilds.fetch(guildId);
                logger.info(`[Startup Cleanup] Purging announcements for guild: ${guild.name} (${guildId})`);

                const [defaultChannels] = await db.execute('SELECT DISTINCT announcement_channel_id FROM guilds WHERE guild_id = ? AND announcement_channel_id IS NOT NULL', [guildId]);
                const [subscriptionChannels] = await db.execute('SELECT DISTINCT announcement_channel_id FROM subscriptions WHERE guild_id = ? AND announcement_channel_id IS NOT NULL', [guildId]);
                const allChannelIdsForGuild = [...new Set([...defaultChannels.map(r => r.announcement_channel_id), ...subscriptionChannels.map(r => r.announcement_channel_id)])];

                for (const channelId of allChannelIdsForGuild) {
                    if (!channelId) continue;
                    try {
                        const channel = await client.channels.fetch(channelId);
                        if (channel && channel.isTextBased() && channel.guild.members.me.permissionsIn(channel).has(PermissionsBitField.Flags.ManageMessages)) {
                            logger.info(`[Startup Cleanup] Purging messages from #${channel.name} (${channel.id})`);
                            let deletedCount = 0;
                            let lastMessageId = null;
                            let totalFetched;
                            do {
                                const messages = await channel.messages.fetch({ limit: 100, before: lastMessageId });
                                totalFetched = messages.size;
                                if (totalFetched === 0) break;
                                const botMessages = messages.filter(m => m.webhookId !== null || m.author.id === client.user.id);
                                if (botMessages.size > 0) {
                                    const deleted = await channel.bulkDelete(botMessages, true);
                                    deletedCount += deleted.size;
                                }
                                lastMessageId = messages.last().id;
                            } while (totalFetched === 100);
                            if (deletedCount > 0) {
                                logger.info(`[Startup Cleanup] Purged ${deletedCount} messages from #${channel.name}.`);
                            }
                        }
                    } catch (e) {
                        logger.error(`[Startup Cleanup] Failed to purge channel ${channelId}: ${e.message}`);
                    }
                }
            } catch (e) {
                logger.error(`[Startup Cleanup] Failed to process guild ${guildId} for announcement purge: ${e.message}`);
            }
        }
        await db.execute('TRUNCATE TABLE announcements');
        logger.info('[Startup Cleanup] Announcements table cleared.');

    } catch (e) { logger.error('[Startup Cleanup] A CRITICAL ERROR occurred:', { error: e }); }
    logger.info('[Startup Cleanup] Full-stage purge process has finished.');
}

module.exports = { startupCleanup };
