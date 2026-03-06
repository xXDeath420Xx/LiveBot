import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logInviteDelete } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import pool from '../utils/db.js';

export default {
    name: Events.InviteDelete,
    async execute(invite) {
        try {
            const guild = invite.guild;
            if (!guild) return;

            // Only the default bot should ignore guilds with custom bots
            if (invite.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            // Log to Discord channel
            await logInviteDelete(invite);

            // Update database - mark invite as deleted/used
            try {
                await pool.execute(
                    `UPDATE invite_tracking SET uses = -1 WHERE guild_id = ? AND invite_code = ?`,
                    [guild.id, invite.code]
                );
                logger.info(`[InviteDelete] Marked invite ${invite.code} as deleted in database`);
            } catch (dbError) {
                logger.warn(`[InviteDelete] Could not update invite in database: ${dbError.message}`);
            }

        } catch (error) {
            logger.error('[InviteDelete] Error handling invite delete:', {
                error: error.message,
                stack: error.stack,
                inviteCode: invite?.code
            });
        }
    }
};
