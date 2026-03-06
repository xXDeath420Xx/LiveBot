import { Events, AuditLogEvent } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { logInviteCreate } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.InviteCreate,
    async execute(invite) {
        try {
            const guild = invite.guild;
            if (!guild) return;

            // Only the default bot should ignore guilds with custom bots
            if (invite.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            const inviter = invite.inviter;
            const channel = invite.channel;

            // Log to Discord channel
            await logInviteCreate(invite);

            // Check if this guild has an invite policy
            const [policies] = await pool.execute(
                'SELECT * FROM invite_policy WHERE guild_id = ?',
                [guild.id]
            );

            // Always log the invite creation to database for tracking
            try {
                await pool.execute(
                    `INSERT INTO invite_tracking (guild_id, invite_code, inviter_id, uses, created_at)
                     VALUES (?, ?, ?, 0, NOW())
                     ON DUPLICATE KEY UPDATE inviter_id = VALUES(inviter_id), uses = 0`,
                    [guild.id, invite.code, inviter?.id || 'unknown']
                );
                logger.info(`[InviteCreate] Logged invite to database: ${invite.code}`, {
                    guildId: guild.id,
                    inviterId: inviter?.id,
                    maxUses: invite.maxUses,
                    maxAge: invite.maxAge
                });
            } catch (dbError) {
                logger.warn(`[InviteCreate] Could not log invite to database: ${dbError.message}`);
            }

            if (policies.length === 0 || !policies[0].single_use_only) {
                return; // No policy or single_use_only not enabled
            }

            const policy = policies[0];

            // Check if inviter has an allowed role (staff or verified)
            let isAllowedToCreateInvites = false;
            if (inviter && !inviter.bot) {
                try {
                    const member = await guild.members.fetch(inviter.id);

                    // Check for staff permissions
                    const isStaff = member.permissions.has('ManageGuild') ||
                        member.permissions.has('ManageMessages') ||
                        member.permissions.has('Administrator');

                    if (isStaff) {
                        isAllowedToCreateInvites = true;
                    } else if (policy.allowed_roles) {
                        // Check for verified roles from policy
                        try {
                            const allowedRoles = JSON.parse(policy.allowed_roles);
                            isAllowedToCreateInvites = member.roles.cache.some(
                                role => allowedRoles.includes(role.id)
                            );
                        } catch (e) {
                            // Fallback to verified_role_id
                            if (policy.verified_role_id) {
                                isAllowedToCreateInvites = member.roles.cache.has(policy.verified_role_id);
                            }
                        }
                    } else if (policy.verified_role_id) {
                        isAllowedToCreateInvites = member.roles.cache.has(policy.verified_role_id);
                    }
                } catch (e) {
                    logger.debug(`[InviteCreate] Could not fetch member ${inviter.id}: ${e.message}`);
                }
            }

            // Check if invite violates policy
            const maxAgeSeconds = policy.max_age_seconds || 604800; // 7 days default
            const violatesPolicy =
                invite.maxUses !== 1 || // Not single use
                invite.maxAge === 0 || // Never expires
                invite.maxAge > maxAgeSeconds; // Expires too far in future

            if (!violatesPolicy) {
                logger.info(`[InviteCreate] Compliant invite created: ${invite.code}`, {
                    guildId: guild.id,
                    inviterId: inviter?.id,
                    maxUses: invite.maxUses,
                    maxAge: invite.maxAge,
                    isAllowed: isAllowedToCreateInvites
                });
                return;
            }

            // If user is not allowed to create invites at all, just delete without replacement
            if (!isAllowedToCreateInvites) {
                logger.warn(`[InviteCreate] Unauthorized invite creation attempt: ${invite.code}`, {
                    guildId: guild.id,
                    inviterId: inviter?.id
                });

                try {
                    await invite.delete('User not authorized to create invites');

                    if (inviter && !inviter.bot) {
                        try {
                            await inviter.send(
                                `🔒 **Invite Creation Denied**\n\n` +
                                `Your invite link for **${guild.name}** was deleted because you don't have permission to create invites.\n\n` +
                                `Only verified members can create invite links in this server.`
                            );
                        } catch (dmError) {
                            logger.debug(`[InviteCreate] Could not DM inviter: ${dmError.message}`);
                        }
                    }
                } catch (deleteError) {
                    logger.error(`[InviteCreate] Could not delete unauthorized invite: ${deleteError.message}`);
                }
                return;
            }

            logger.warn(`[InviteCreate] Non-compliant invite detected: ${invite.code}`, {
                guildId: guild.id,
                inviterId: inviter?.id,
                maxUses: invite.maxUses,
                maxAge: invite.maxAge
            });

            // Delete the non-compliant invite
            await invite.delete('Enforcing single-use invite policy');

            // Create a compliant replacement invite
            if (channel) {
                const newInvite = await channel.createInvite({
                    maxUses: 1,
                    maxAge: maxAgeSeconds,
                    unique: true,
                    reason: `Replacement invite (original by ${inviter?.tag || 'unknown'} violated policy)`
                });

                // Log the replacement invite
                try {
                    await pool.execute(
                        `INSERT INTO invite_tracking (guild_id, invite_code, inviter_id, uses, created_at)
                         VALUES (?, ?, ?, 0, NOW())
                         ON DUPLICATE KEY UPDATE inviter_id = VALUES(inviter_id), uses = 0`,
                        [guild.id, newInvite.code, inviter?.id || 'unknown']
                    );
                } catch (dbError) {
                    logger.warn(`[InviteCreate] Could not log replacement invite: ${dbError.message}`);
                }

                logger.info(`[InviteCreate] Created replacement invite: ${newInvite.code}`, {
                    guildId: guild.id,
                    originalCode: invite.code,
                    newCode: newInvite.code
                });

                // Try to DM the inviter about the replacement
                if (inviter && !inviter.bot) {
                    try {
                        await inviter.send(
                            `🔒 **Invite Policy Notice**\n\n` +
                            `Your invite link \`${invite.code}\` for **${guild.name}** was replaced because it didn't meet the server's invite policy.\n\n` +
                            `**Server Policy:**\n` +
                            `• All invites must be single-use\n` +
                            `• All invites must expire within 7 days\n\n` +
                            `**Your new invite link:**\n` +
                            `https://discord.gg/${newInvite.code}\n\n` +
                            `This invite is single-use and will expire in 7 days.`
                        );
                    } catch (dmError) {
                        // User has DMs disabled, that's fine
                        logger.debug(`[InviteCreate] Could not DM inviter: ${dmError.message}`);
                    }
                }
            }

        } catch (error) {
            logger.error('[InviteCreate] Error enforcing invite policy:', {
                error: error.message,
                stack: error.stack,
                inviteCode: invite?.code
            });
        }
    }
};
